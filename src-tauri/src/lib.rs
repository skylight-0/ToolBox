use tauri::{Manager, LogicalPosition, LogicalSize, Position, Size, State};
use tauri_plugin_global_shortcut::ShortcutState;
use std::sync::Mutex;

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

        let _ = window.set_size(Size::Logical(LogicalSize::new(logical_width, screen_height)));
        let _ = window.set_position(Position::Logical(LogicalPosition::new(x, y)));
    }
}


// 切换侧边栏显示/隐藏
#[tauri::command]
fn toggle_sidebar(window: tauri::WebviewWindow, state: State<'_, AppState>) {
    if let Ok(visible) = window.is_visible() {
        if visible {
            let _ = window.hide();
        } else {
            let width = *state.sidebar_width.lock().unwrap();
            position_window_right(&window, width);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
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
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            if let Ok(visible) = window.is_visible() {
                                if visible {
                                    let _ = window.hide();
                                } else {
                                    // 从状态中获取当前宽度
                                    let state: State<'_, AppState> = app.state();
                                    let width = *state.sidebar_width.lock().unwrap();
                                    
                                    position_window_right(&window, width);
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![toggle_sidebar, resize_sidebar])
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
