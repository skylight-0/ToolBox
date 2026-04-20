use std::collections::HashMap;
use std::fs;
use std::process::Command;
use std::sync::Mutex;
use tauri::{
    LogicalPosition, LogicalSize, Manager, Position, Size, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::ShortcutState;

struct AppState {
    sidebar_width: Mutex<u32>,
    latest_screenshot: Mutex<Option<String>>,
    pinned_images: Mutex<HashMap<String, String>>,
    pinned_window_counter: Mutex<u32>,
}

fn remove_pinned_image(state: &AppState, label: &str) {
    if let Ok(mut pinned_images) = state.pinned_images.lock() {
        pinned_images.remove(label);
    }
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

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let (_, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "无效的图片数据".to_string())?;
    decode_base64(encoded)
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(input.len() * 3 / 4);
    let mut chunk = [0u8; 4];
    let mut chunk_len = 0;

    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            b'\r' | b'\n' | b'\t' | b' ' => continue,
            _ => return Err("图片数据包含无效字符".to_string()),
        };

        chunk[chunk_len] = value;
        chunk_len += 1;

        if chunk_len == 4 {
            output.push((chunk[0] << 2) | (chunk[1] >> 4));
            if chunk[2] != 64 {
                output.push((chunk[1] << 4) | (chunk[2] >> 2));
            }
            if chunk[3] != 64 {
                output.push((chunk[2] << 6) | chunk[3]);
            }
            chunk_len = 0;
        }
    }

    if chunk_len != 0 {
        return Err("图片数据长度无效".to_string());
    }

    Ok(output)
}

#[cfg(target_os = "windows")]
fn run_hidden_powershell(script: &str) -> Result<String, String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("执行 PowerShell 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "硬件信息采集失败".to_string()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "windows")]
fn capture_screen_data_url() -> Result<String, String> {
    let script = r#"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
$memory = New-Object System.IO.MemoryStream
$bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
[Convert]::ToBase64String($memory.ToArray())
"#;

    let encoded = run_hidden_powershell(script)?;
    if encoded.is_empty() {
        Err("截图失败".to_string())
    } else {
        Ok(format!("data:image/png;base64,{}", encoded))
    }
}

fn show_screenshot_editor(app: &tauri::AppHandle, state: &State<'_, AppState>) {
    if let Some(window) = app.get_webview_window("main") {
        let current_width = state
            .sidebar_width
            .lock()
            .ok()
            .map(|value| *value)
            .unwrap_or(400);
        let screenshot_width = current_width.max(920);
        position_window_right(&window, screenshot_width);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("show-sidebar", ());
        let _ = window.emit("open-screenshot-editor", ());
    }
}

#[cfg(target_os = "windows")]
fn open_screenshot_selector_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("screenshot-selector") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        "screenshot-selector",
        WebviewUrl::App("index.html?mode=selector".into()),
    )
    .title("Screenshot Selector")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .fullscreen(true)
    .resizable(false)
    .build()
    .map_err(|e| format!("创建截图选择窗口失败: {}", e))?;

    Ok(())
}

#[tauri::command]
fn capture_screenshot(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let image = capture_screen_data_url()?;
        if let Ok(mut latest) = state.latest_screenshot.lock() {
            *latest = Some(image.clone());
        }

        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }

        open_screenshot_selector_window(&app)?;
        Ok(image)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        let _ = state;
        Err("仅支持 Windows 平台".to_string())
    }
}

#[tauri::command]
fn confirm_screenshot_capture(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    data_url: String,
) -> Result<(), String> {
    if let Ok(mut latest) = state.latest_screenshot.lock() {
        *latest = Some(data_url);
    }

    if let Some(window) = app.get_webview_window("screenshot-selector") {
        let _ = window.close();
    }

    show_screenshot_editor(&app, &state);
    Ok(())
}

#[tauri::command]
fn cancel_screenshot_capture(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("screenshot-selector") {
        let _ = window.close();
    }
}

#[tauri::command]
fn get_latest_screenshot(state: State<'_, AppState>) -> Result<String, String> {
    state
        .latest_screenshot
        .lock()
        .map_err(|_| "截图状态不可用".to_string())?
        .clone()
        .ok_or_else(|| "当前还没有可编辑的截图".to_string())
}

#[tauri::command]
fn save_image_data(path: String, data_url: String) -> Result<(), String> {
    let bytes = decode_data_url(&data_url)?;
    fs::write(path, bytes).map_err(|e| format!("保存图片失败: {}", e))
}

#[tauri::command]
fn get_pinned_image(state: State<'_, AppState>, label: String) -> Result<String, String> {
    state
        .pinned_images
        .lock()
        .map_err(|_| "钉图状态不可用".to_string())?
        .get(&label)
        .cloned()
        .ok_or_else(|| "当前没有钉图内容".to_string())
}

#[tauri::command]
fn open_pinned_image_window(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    data_url: String,
) -> Result<String, String> {
    let label = {
        let mut counter = state
            .pinned_window_counter
            .lock()
            .map_err(|_| "钉图计数器不可用".to_string())?;
        *counter += 1;
        format!("pinned-image-{}", *counter)
    };

    if let Ok(mut pinned_images) = state.pinned_images.lock() {
        pinned_images.insert(label.clone(), data_url.clone());
    }

    let window = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html?mode=pinned&label={label}").into()),
    )
    .title("Pinned Screenshot")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .inner_size(720.0, 480.0)
    .build()
    .map_err(|e| format!("创建钉图窗口失败: {}", e))?;

    let _ = window.emit("pinned-image-updated", data_url);
    Ok(label)
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
        .on_window_event(|window, event| match event {
            // 在底层直接监听系统窗口级别的失焦事件
            tauri::WindowEvent::Focused(focused) => {
                if !focused {
                    let _ = window.emit("hide-sidebar", ());
                }
            }
            tauri::WindowEvent::Destroyed => {
                let label = window.label();
                if label.starts_with("pinned-image-") {
                    let state: State<'_, AppState> = window.state();
                    remove_pinned_image(&state, label);
                }
            }
            _ => {}
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let shortcut = shortcut.to_string();
                        if shortcut == "Alt+Space" {
                            toggle_sidebar_window(app);
                        } else if shortcut == "Alt+Shift+S" {
                            let state: State<'_, AppState> = app.state();
                            let _ = capture_screenshot(app.clone(), state);
                        }
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
            capture_screenshot,
            confirm_screenshot_capture,
            cancel_screenshot_capture,
            get_latest_screenshot,
            save_image_data,
            open_pinned_image_window,
            get_pinned_image
        ])
        .setup(|app| {
            // 初始化状态管理器
            app.manage(AppState {
                sidebar_width: Mutex::new(400),
                latest_screenshot: Mutex::new(None),
                pinned_images: Mutex::new(HashMap::new()),
                pinned_window_counter: Mutex::new(0),
            });

            // 注册 Alt+Space 全局快捷键
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let _ = app.global_shortcut().register("Alt+Space");
            let _ = app.global_shortcut().register("Alt+Shift+S");

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
