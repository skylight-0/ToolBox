use std::sync::Mutex;
use tauri::{LogicalPosition, LogicalSize, Manager, Position, Size, State};
use tauri_plugin_global_shortcut::ShortcutState;

struct AppState {
    sidebar_width: Mutex<u32>,
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
        UI::WindowsAndMessaging::{
            FindWindowExW, FindWindowW, ShowWindow, SW_HIDE, SW_SHOWNA,
        },
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

        let mut secondary = FindWindowW(w!("Shell_SecondaryTrayWnd"), PCWSTR::null()).unwrap_or_default();
        while secondary != HWND::default() {
            let _ = ShowWindow(secondary, cmd);
            secondary = FindWindowExW(None, Some(secondary), w!("Shell_SecondaryTrayWnd"), PCWSTR::null()).unwrap_or_default();
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
use std::process::Command;

// 执行快捷系统调用
#[tauri::command]
fn system_action(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "lock_screen" => {
            // 利用 Windows 原生的 rundll32 命令锁屏，避免额外引入 API
            let _ = Command::new("rundll32.exe").args(["user32.dll,LockWorkStation"]).spawn();
        }
        "settings" => {
            let _ = Command::new("cmd").args(["/c", "start", "ms-settings:"]).spawn();
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
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
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
            system_action
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
                None::<&str>
            )?;
            
            let settings_menu = tauri::menu::Submenu::with_id_and_items(
                app, 
                "settings",
                "设置", 
                true, 
                &[&autostart_i]
            )?;

            let quit_i = tauri::menu::MenuItem::with_id(app, "quit", "退出过程", true, None::<&str>)?;
            let show_i = tauri::menu::MenuItem::with_id(app, "show", "显示/隐藏", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show_i, &settings_menu, &quit_i])?;

            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ToolBox 侧边栏")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
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
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
                        toggle_sidebar_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
