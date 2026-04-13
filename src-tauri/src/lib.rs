use tauri::{Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_global_shortcut::ShortcutState;

// 获取屏幕尺寸并定位窗口到右侧
fn position_window_right(window: &tauri::WebviewWindow, width: u32) {
    if let Ok(monitor) = window.current_monitor() {
        if let Some(monitor) = monitor {
            let screen_size = monitor.size();
            let screen_pos = monitor.position();
            let screen_height = screen_size.height;
            let screen_width = screen_size.width;

            // 窗口定位到屏幕右侧
            let x = screen_pos.x + (screen_width - width) as i32;
            let y = screen_pos.y;

            let _ = window.set_size(PhysicalSize::new(width, screen_height));
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }
}

// 切换侧边栏显示/隐藏
#[tauri::command]
fn toggle_sidebar(window: tauri::WebviewWindow) {
    if let Ok(visible) = window.is_visible() {
        if visible {
            let _ = window.hide();
        } else {
            position_window_right(&window, 400);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

// 调整侧边栏宽度（由前端拖拽时调用）
#[tauri::command]
fn resize_sidebar(window: tauri::WebviewWindow, width: u32) {
    let min_width = 280;
    let max_width = 1200;
    let clamped_width = width.clamp(min_width, max_width);
    position_window_right(&window, clamped_width);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // ShortcutEvent 是一个结构体，包含 state 字段
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            if let Ok(visible) = window.is_visible() {
                                if visible {
                                    let _ = window.hide();
                                } else {
                                    position_window_right(&window, 400);
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
            // 注册 Alt+Space 全局快捷键
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            app.global_shortcut().register("Alt+Space")?;

            // 初始隐藏窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
