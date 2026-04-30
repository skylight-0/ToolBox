use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, process::Command, sync::Mutex};
use tauri::{LogicalPosition, LogicalSize, Manager, Position, Size, State};
use tauri_plugin_global_shortcut::ShortcutState;

struct AppState {
    sidebar_width: Mutex<u32>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct PasswordVault {
    domains: Vec<PasswordDomain>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PasswordDomain {
    id: String,
    domain: String,
    accounts: Vec<PasswordAccount>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PasswordAccount {
    id: String,
    username: String,
    password: String,
    note: String,
}

// 获取屏幕尺寸并定位窗口到右侧
fn position_window_right(window: &tauri::WebviewWindow, width: u32) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale_factor = monitor.scale_factor();
        let screen_size = monitor.size().to_logical::<f64>(scale_factor);
        let screen_pos = monitor.position().to_logical::<f64>(scale_factor);

        let screen_height = screen_size.height;
        let screen_width = screen_size.width;

        // 窗口定位到屏幕右侧 (前端传来的 width 是逻辑/CSS像素)
        let logical_width = width as f64;
        let x = screen_pos.x + (screen_width - logical_width);
        let y = screen_pos.y;

        let _ = window.set_size(Size::Logical(LogicalSize::new(
            logical_width,
            screen_height,
        )));
        let _ = window.set_position(Position::Logical(LogicalPosition::new(x, y)));
    }
}

use tauri::Emitter;

#[cfg(target_os = "windows")]
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{FindWindowExW, FindWindowW, ShowWindow, SW_HIDE, SW_SHOWNA},
    },
};

// 切换桌面图标的隐藏/显示
#[tauri::command]
fn toggle_desktop(show: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null()).unwrap_or_default();
        let mut defview =
            FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), PCWSTR::null())
                .unwrap_or_default();

        // 桌面的图标有可能被挂载在 WorkerW 上（例如用了动态壁纸）
        if defview == HWND::default() {
            let mut worker = FindWindowW(w!("WorkerW"), PCWSTR::null()).unwrap_or_default();
            while worker != HWND::default() {
                defview = FindWindowExW(Some(worker), None, w!("SHELLDLL_DefView"), PCWSTR::null())
                    .unwrap_or_default();
                if defview != HWND::default() {
                    break;
                }
                worker = FindWindowExW(None, Some(worker), w!("WorkerW"), PCWSTR::null())
                    .unwrap_or_default();
            }
        }

        let systree = if defview != HWND::default() {
            FindWindowExW(Some(defview), None, w!("SysListView32"), PCWSTR::null())
                .unwrap_or_default()
        } else {
            HWND::default()
        };

        if systree != HWND::default() {
            let cmd = if show { SW_SHOWNA } else { SW_HIDE };
            let _ = ShowWindow(systree, cmd);
        }

        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("仅支持 Windows 平台".to_string())
    }
}

// 切换任务栏的隐藏/显示
#[tauri::command]
fn toggle_taskbar(window: tauri::WebviewWindow, show: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let taskbar = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).unwrap_or_default();
        let cmd = if show { SW_SHOWNA } else { SW_HIDE };
        if taskbar != HWND::default() {
            let _ = ShowWindow(taskbar, cmd);
        }

        let mut secondary =
            FindWindowW(w!("Shell_SecondaryTrayWnd"), PCWSTR::null()).unwrap_or_default();
        while secondary != HWND::default() {
            let _ = ShowWindow(secondary, cmd);
            secondary = FindWindowExW(
                None,
                Some(secondary),
                w!("Shell_SecondaryTrayWnd"),
                PCWSTR::null(),
            )
            .unwrap_or_default();
        }

        if show {
            // Taskbar 显示时也是 Topmost，会挤到 Z 轴最上面。
            // 这里我们通过取消置顶再重新置顶，强制洗牌让我们的窗口回到 Topmost 的最顶端。
            let _ = window.set_always_on_top(false);
            let _ = window.set_always_on_top(true);
        }

        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("仅支持 Windows 平台".to_string())
    }
}

fn password_vault_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录: {}", e))?;
    Ok(dir.join("password_vault.dat"))
}

#[cfg(target_os = "windows")]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err("密码库加密失败".to_string());
        }

        let protected = slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(output.pbData as _);
        Ok(protected)
    }
}

#[cfg(not(target_os = "windows"))]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err("密码库解密失败，可能不是当前 Windows 用户创建的数据".to_string());
        }

        let plain = slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(output.pbData as _);
        Ok(plain)
    }
}

#[cfg(not(target_os = "windows"))]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(target_os = "windows")]
fn wide_null(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn wide_to_string(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

#[tauri::command]
fn authenticate_password_vault() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    unsafe {
        use std::{ffi::c_void, mem, ptr};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            Security::{
                Credentials::{
                    CredUIPromptForWindowsCredentialsW, CredUnPackAuthenticationBufferW,
                    CREDUIWIN_ENUMERATE_CURRENT_USER, CREDUIWIN_SECURE_PROMPT, CREDUI_INFOW,
                },
                LogonUserW, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT,
            },
        };

        const ERROR_CANCELLED: u32 = 1223;

        let message = wide_null("请输入当前 Windows 用户的锁屏密码以打开密码管理工具。");
        let caption = wide_null("ToolBox 密码管理");
        let ui_info = CREDUI_INFOW {
            cbSize: mem::size_of::<CREDUI_INFOW>() as u32,
            hwndParent: ptr::null_mut(),
            pszMessageText: message.as_ptr(),
            pszCaptionText: caption.as_ptr(),
            hbmBanner: ptr::null_mut(),
        };

        let mut auth_package = 0u32;
        let mut out_auth_buffer: *mut c_void = ptr::null_mut();
        let mut out_auth_buffer_size = 0u32;
        let mut save = 0i32;
        let prompt_result = CredUIPromptForWindowsCredentialsW(
            &ui_info,
            0,
            &mut auth_package,
            ptr::null(),
            0,
            &mut out_auth_buffer,
            &mut out_auth_buffer_size,
            &mut save,
            CREDUIWIN_ENUMERATE_CURRENT_USER | CREDUIWIN_SECURE_PROMPT,
        );

        if prompt_result == ERROR_CANCELLED {
            return Ok(false);
        }
        if prompt_result != 0 {
            return Err(format!("系统凭据验证窗口打开失败: {}", prompt_result));
        }

        let mut username = vec![0u16; 256];
        let mut domain = vec![0u16; 256];
        let mut password = vec![0u16; 512];
        let mut username_len = username.len() as u32;
        let mut domain_len = domain.len() as u32;
        let mut password_len = password.len() as u32;

        let unpacked = CredUnPackAuthenticationBufferW(
            0,
            out_auth_buffer,
            out_auth_buffer_size,
            username.as_mut_ptr(),
            &mut username_len,
            domain.as_mut_ptr(),
            &mut domain_len,
            password.as_mut_ptr(),
            &mut password_len,
        );
        windows_sys::Win32::Security::Credentials::CredFree(out_auth_buffer);

        if unpacked == 0 {
            return Err("无法读取系统凭据输入".to_string());
        }

        let mut username_text = wide_to_string(&username);
        let mut domain_text = wide_to_string(&domain);
        if domain_text.is_empty() {
            if let Some((domain_part, user_part)) = username_text.split_once('\\') {
                domain_text = domain_part.to_string();
                username_text = user_part.to_string();
            }
        }

        let username_w = wide_null(&username_text);
        let domain_w = if domain_text.is_empty() {
            Vec::new()
        } else {
            wide_null(&domain_text)
        };
        let password_text = wide_to_string(&password);
        let password_w = wide_null(&password_text);
        let domain_ptr = if domain_w.is_empty() {
            ptr::null()
        } else {
            domain_w.as_ptr()
        };

        let mut token: HANDLE = ptr::null_mut();
        let ok = LogonUserW(
            username_w.as_ptr(),
            domain_ptr,
            password_w.as_ptr(),
            LOGON32_LOGON_INTERACTIVE,
            LOGON32_PROVIDER_DEFAULT,
            &mut token,
        );

        if ok == 0 {
            return Ok(false);
        }
        let _ = CloseHandle(token);
        Ok(true)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("系统锁屏密码验证仅支持 Windows 平台".to_string())
    }
}

#[tauri::command]
fn load_password_vault(app: tauri::AppHandle) -> Result<PasswordVault, String> {
    let path = password_vault_path(&app)?;
    if !path.exists() {
        return Ok(PasswordVault::default());
    }

    let encrypted = fs::read(&path).map_err(|e| format!("读取密码库失败: {}", e))?;
    if encrypted.is_empty() {
        return Ok(PasswordVault::default());
    }

    let decrypted = dpapi_unprotect(&encrypted)?;
    serde_json::from_slice(&decrypted).map_err(|e| format!("密码库数据损坏: {}", e))
}

#[tauri::command]
fn save_password_vault(app: tauri::AppHandle, vault: PasswordVault) -> Result<(), String> {
    let path = password_vault_path(&app)?;
    let plain = serde_json::to_vec(&vault).map_err(|e| format!("序列化密码库失败: {}", e))?;
    let encrypted = dpapi_protect(&plain)?;
    fs::write(&path, encrypted).map_err(|e| format!("保存密码库失败: {}", e))
}

// 执行快捷系统调用
#[tauri::command]
fn system_action(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "lock_screen" => {
            // 利用 Windows 原生的 rundll32 命令锁屏，避免额外引入 API
            let _ = Command::new("rundll32.exe")
                .args(["user32.dll,LockWorkStation"])
                .spawn();
        }
        "settings" => {
            let _ = Command::new("cmd")
                .args(["/c", "start", "ms-settings:"])
                .spawn();
        }
        "notepad" => {
            let _ = Command::new("notepad.exe").spawn();
        }
        "calc" => {
            let _ = Command::new("calc.exe").spawn();
        }
        "terminal" => {
            // 打开现代的 Windows Terminal 或者回退到 cmd
            let _ = Command::new("cmd").args(["/c", "start", "wt.exe"]).spawn();
        }
        "taskmgr" => {
            let _ = Command::new("taskmgr.exe").spawn();
        }
        _ => {}
    }

    // 执行了快速启动操作之后，非常自然地自动收起侧边栏
    let _ = window.emit("hide-sidebar", ());
    Ok(())
}

// 启动指定路径的程序（快捷访问功能）
#[tauri::command]
fn launch_program(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "start", "", &path]);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(|e| format!("启动程序失败: {}", e))?;
    let _ = window.emit("hide-sidebar", ());
    Ok(())
}

// 提取程序图标为 base64 PNG 数据（通过 PowerShell 调用 .NET 的 System.Drawing）
#[tauri::command]
async fn extract_program_icon(path: String) -> Result<String, String> {
    let mut cmd = Command::new("powershell");
    let ps_script = format!(
        "Add-Type -AssemblyName System.Drawing; try {{ $icon = [System.Drawing.Icon]::ExtractAssociatedIcon('{}'); if ($icon) {{ $bmp = $icon.ToBitmap(); $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }} }} catch {{}}",
        path.replace('\'', "''")
    );
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps_script]);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| format!("提取图标失败: {}", e))?;
    let base64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if base64.is_empty() {
        Err("无法提取图标".to_string())
    } else {
        Ok(format!("data:image/png;base64,{}", base64))
    }
}

// 供前端或底部托盘和快捷键统一调用的侧边栏切换逻辑
fn toggle_sidebar_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        if let Ok(visible) = window.is_visible() {
            if visible {
                let _ = window.emit("hide-sidebar", ());
            } else {
                let state: State<'_, AppState> = app_handle.state();
                let width = *state.sidebar_width.lock().unwrap();
                position_window_right(&window, width);
                let _ = window.emit("show-sidebar", ());
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

// 切换侧边栏显示/隐藏（给前端命令用）
#[tauri::command]
fn toggle_sidebar(app: tauri::AppHandle) {
    toggle_sidebar_window(&app);
}

// 供前端在滑出动画结束后实际隐藏窗口的命令
#[tauri::command]
fn do_hide_sidebar(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

// 调整侧边栏宽度（由前端拖拽时调用）
#[tauri::command]
fn resize_sidebar(window: tauri::WebviewWindow, state: State<'_, AppState>, width: u32) {
    let min_width = 280;
    let max_width = 1200;
    let clamped_width = width.clamp(min_width, max_width);

    // 更新保存的宽度
    if let Ok(mut w) = state.sidebar_width.lock() {
        *w = clamped_width;
    }

    position_window_right(&window, clamped_width);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            // 在底层直接监听系统窗口级别的失焦事件
            if let tauri::WindowEvent::Focused(focused) = event {
                if !focused {
                    let _ = window.emit("hide-sidebar", ());
                }
            }
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_sidebar_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            toggle_sidebar,
            resize_sidebar,
            do_hide_sidebar,
            toggle_desktop,
            toggle_taskbar,
            system_action,
            launch_program,
            extract_program_icon,
            authenticate_password_vault,
            load_password_vault,
            save_password_vault
        ])
        .setup(|app| {
            // 初始化状态管理器
            app.manage(AppState {
                sidebar_width: Mutex::new(400),
            });

            // 注册 Alt+Space 全局快捷键
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let _ = app.global_shortcut().register("Alt+Space");

            // 初始隐藏窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }

            // ===== 添加系统托盘 =====
            use tauri_plugin_autostart::ManagerExt;

            // 获取开机自启状态
            let autostart_manager = app.autolaunch();
            let is_autostart_enabled = autostart_manager.is_enabled().unwrap_or(false);

            let autostart_i = tauri::menu::CheckMenuItem::with_id(
                app,
                "autostart",
                "开机自启动",
                true,
                is_autostart_enabled,
                None::<&str>,
            )?;

            let settings_menu = tauri::menu::Submenu::with_id_and_items(
                app,
                "settings",
                "设置",
                true,
                &[&autostart_i],
            )?;

            let quit_i =
                tauri::menu::MenuItem::with_id(app, "quit", "退出过程", true, None::<&str>)?;
            let show_i =
                tauri::menu::MenuItem::with_id(app, "show", "显示/隐藏", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show_i, &settings_menu, &quit_i])?;

            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ToolBox 侧边栏")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        toggle_sidebar_window(app);
                    }
                    "autostart" => {
                        let manager = app.autolaunch();
                        if let Ok(enabled) = manager.is_enabled() {
                            if enabled {
                                let _ = manager.disable();
                            } else {
                                let _ = manager.enable();
                            }
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_sidebar_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
