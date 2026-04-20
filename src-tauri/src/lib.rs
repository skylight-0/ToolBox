use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{
    LogicalPosition, LogicalSize, Manager, Monitor, Position, Size, State,
};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

mod platform;

pub(crate) struct AppState {
    sidebar_width: Mutex<u32>,
    sidebar_is_closing: Mutex<bool>,
    clipboard_db_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClipboardRecord {
    id: String,
    #[serde(rename = "type")]
    record_type: String,
    content: String,
    timestamp: i64,
    favorite: bool,
    pinned: bool,
    tags: Vec<String>,
    group: String,
}

#[derive(Debug, Deserialize)]
struct ClipboardRecordInput {
    id: String,
    #[serde(rename = "type")]
    record_type: String,
    content: String,
    timestamp: i64,
    favorite: Option<bool>,
    pinned: Option<bool>,
    tags: Option<Vec<String>>,
    group: Option<String>,
}

// 获取屏幕尺寸并定位窗口到右侧
fn resolve_target_monitor(window: &tauri::WebviewWindow) -> Option<Monitor> {
    if let Ok(cursor) = window.cursor_position() {
        if let Ok(Some(monitor)) = window.monitor_from_point(cursor.x, cursor.y) {
            return Some(monitor);
        }
    }

    window.current_monitor().ok().flatten()
}

fn position_window_right(window: &tauri::WebviewWindow, width: u32) {
    if let Some(monitor) = resolve_target_monitor(window) {
        let scale_factor = monitor.scale_factor();
        let screen_size = monitor.size().to_logical::<f64>(scale_factor);
        let screen_pos = monitor.position().to_logical::<f64>(scale_factor);

        let screen_height = screen_size.height;
        let screen_width = screen_size.width;

        // 窗口定位到鼠标所在屏幕右侧 (前端传来的 width 是逻辑/CSS像素)
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

fn mark_sidebar_closing(state: &State<'_, AppState>, is_closing: bool) {
    if let Ok(mut closing) = state.sidebar_is_closing.lock() {
        *closing = is_closing;
    }
}

// 切换桌面图标的隐藏/显示
#[tauri::command]
fn toggle_desktop(show: bool) -> Result<(), String> {
    platform::toggle_desktop(show)
}

// 切换任务栏的隐藏/显示
#[tauri::command]
fn toggle_taskbar(window: tauri::WebviewWindow, show: bool) -> Result<(), String> {
    platform::toggle_taskbar(window, show)
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

fn open_clipboard_db(state: &State<'_, AppState>) -> Result<Connection, String> {
    Connection::open(&state.clipboard_db_path)
        .map_err(|error| format!("打开剪贴板数据库失败: {}", error))
}

fn init_clipboard_db(path: &PathBuf) -> Result<(), String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("初始化剪贴板数据库失败: {}", error))?;
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS clipboard_history (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                favorite INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0,
                tags TEXT NOT NULL DEFAULT '[]',
                group_name TEXT NOT NULL DEFAULT 'general'
            );

            CREATE INDEX IF NOT EXISTS idx_clipboard_history_timestamp
            ON clipboard_history(timestamp DESC);
            ",
        )
        .map_err(|error| format!("创建剪贴板数据表失败: {}", error))?;
    Ok(())
}

fn normalize_group_name(group: Option<String>) -> String {
    match group.as_deref() {
        Some("snippet") => "snippet".to_string(),
        _ => "general".to_string(),
    }
}

fn normalize_tags(tags: Option<Vec<String>>) -> Vec<String> {
    let mut normalized = Vec::<String>::new();
    for tag in tags.unwrap_or_default() {
        let tag = tag.trim().to_lowercase();
        if !tag.is_empty() && !normalized.contains(&tag) {
            normalized.push(tag);
        }
    }
    normalized
}

fn read_clipboard_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardRecord> {
    let tags_json: String = row.get("tags")?;
    let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
    Ok(ClipboardRecord {
        id: row.get("id")?,
        record_type: row.get("type")?,
        content: row.get("content")?,
        timestamp: row.get("timestamp")?,
        favorite: row.get::<_, i64>("favorite")? != 0,
        pinned: row.get::<_, i64>("pinned")? != 0,
        tags,
        group: row.get("group_name")?,
    })
}

#[tauri::command]
fn save_image_data(path: String, data_url: String) -> Result<(), String> {
    let bytes = decode_data_url(&data_url)?;
    fs::write(path, bytes).map_err(|e| format!("保存图片失败: {}", e))
}

// 启动指定路径的程序（快捷访问功能）
#[tauri::command]
fn launch_program(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    platform::launch_program(window.clone(), path)?;
    let state: State<'_, AppState> = window.state();
    request_hide_sidebar(&window, &state);
    Ok(())
}

// 提取程序图标为 base64 PNG 数据（通过 PowerShell 调用 .NET 的 System.Drawing）
#[tauri::command]
async fn extract_program_icon(path: String) -> Result<String, String> {
    platform::extract_program_icon(path).await
}

#[tauri::command]
fn get_clipboard_history(state: State<'_, AppState>) -> Result<Vec<ClipboardRecord>, String> {
    let connection = open_clipboard_db(&state)?;
    let mut statement = connection
        .prepare(
            "SELECT id, type, content, timestamp, favorite, pinned, tags, group_name
             FROM clipboard_history
             ORDER BY pinned DESC, favorite DESC, timestamp DESC",
        )
        .map_err(|error| format!("读取剪贴板记录失败: {}", error))?;

    let rows = statement
        .query_map([], read_clipboard_record)
        .map_err(|error| format!("查询剪贴板记录失败: {}", error))?;

    rows.into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析剪贴板记录失败: {}", error))
}

#[tauri::command]
fn insert_clipboard_record(
    state: State<'_, AppState>,
    record: ClipboardRecordInput,
) -> Result<(), String> {
    let connection = open_clipboard_db(&state)?;
    let tags = normalize_tags(record.tags);
    connection
        .execute(
            "INSERT INTO clipboard_history (id, type, content, timestamp, favorite, pinned, tags, group_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                record.id,
                record.record_type,
                record.content,
                record.timestamp,
                i64::from(record.favorite.unwrap_or(false)),
                i64::from(record.pinned.unwrap_or(false)),
                serde_json::to_string(&tags).map_err(|error| format!("序列化标签失败: {}", error))?,
                normalize_group_name(record.group),
            ],
        )
        .map_err(|error| format!("保存剪贴板记录失败: {}", error))?;
    Ok(())
}

#[tauri::command]
fn update_clipboard_record(
    state: State<'_, AppState>,
    id: String,
    favorite: Option<bool>,
    pinned: Option<bool>,
    tags: Option<Vec<String>>,
    group: Option<String>,
) -> Result<(), String> {
    let connection = open_clipboard_db(&state)?;
    let current = connection
        .query_row(
            "SELECT id, type, content, timestamp, favorite, pinned, tags, group_name
             FROM clipboard_history
             WHERE id = ?1",
            params![id],
            read_clipboard_record,
        )
        .map_err(|error| format!("读取待更新剪贴板记录失败: {}", error))?;

    let next_favorite = favorite.unwrap_or(current.favorite);
    let next_pinned = pinned.unwrap_or(current.pinned);
    let next_tags = if tags.is_some() {
        normalize_tags(tags)
    } else {
        current.tags
    };
    let next_group = group.unwrap_or(current.group);

    connection
        .execute(
            "UPDATE clipboard_history
             SET favorite = ?2, pinned = ?3, tags = ?4, group_name = ?5
             WHERE id = ?1",
            params![
                current.id,
                i64::from(next_favorite),
                i64::from(next_pinned),
                serde_json::to_string(&next_tags).map_err(|error| format!("序列化标签失败: {}", error))?,
                normalize_group_name(Some(next_group)),
            ],
        )
        .map_err(|error| format!("更新剪贴板记录失败: {}", error))?;
    Ok(())
}

#[tauri::command]
fn delete_clipboard_record(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let connection = open_clipboard_db(&state)?;
    connection
        .execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])
        .map_err(|error| format!("删除剪贴板记录失败: {}", error))?;
    Ok(())
}

#[tauri::command]
fn clear_clipboard_records(state: State<'_, AppState>) -> Result<(), String> {
    let connection = open_clipboard_db(&state)?;
    connection
        .execute(
            "DELETE FROM clipboard_history WHERE favorite = 0 AND pinned = 0",
            [],
        )
        .map_err(|error| format!("清空剪贴板记录失败: {}", error))?;
    Ok(())
}

// 供前端或底部托盘和快捷键统一调用的侧边栏切换逻辑
fn show_sidebar_window(app_handle: &tauri::AppHandle, state: &State<'_, AppState>) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let width = state.sidebar_width.lock().ok().map(|value| *value).unwrap_or(400);
        mark_sidebar_closing(state, false);
        position_window_right(&window, width);
        let _ = window.emit("show-sidebar", ());
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn request_hide_sidebar<R: tauri::Runtime>(
    window: &impl tauri::Emitter<R>,
    state: &State<'_, AppState>,
) {
    mark_sidebar_closing(state, true);
    let _ = window.emit("hide-sidebar", ());
}

fn toggle_sidebar_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let state: State<'_, AppState> = app_handle.state();
        if let Ok(visible) = window.is_visible() {
            if visible {
                let is_closing = state
                    .sidebar_is_closing
                    .lock()
                    .ok()
                    .map(|value| *value)
                    .unwrap_or(false);
                if is_closing {
                    show_sidebar_window(app_handle, &state);
                } else {
                    request_hide_sidebar(&window, &state);
                }
            } else {
                show_sidebar_window(app_handle, &state);
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
fn do_hide_sidebar(window: tauri::WebviewWindow, state: State<'_, AppState>) {
    mark_sidebar_closing(&state, false);
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
                if !focused && window.label() == "main" {
                    let state: State<'_, AppState> = window.state();
                    request_hide_sidebar(window, &state);
                }
            }
            _ => {}
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed
                        && shortcut.matches(Modifiers::ALT, Code::Space)
                    {
                        eprintln!("全局快捷键 Alt+Space 已触发");
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
            launch_program,
            extract_program_icon,
            save_image_data,
            get_clipboard_history,
            insert_clipboard_record,
            update_clipboard_record,
            delete_clipboard_record,
            clear_clipboard_records
        ])
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("读取应用数据目录失败: {}", error))?;
            fs::create_dir_all(&app_data_dir)
                .map_err(|error| format!("创建应用数据目录失败: {}", error))?;
            let clipboard_db_path = app_data_dir.join("clipboard.sqlite");
            init_clipboard_db(&clipboard_db_path)?;

            // 初始化状态管理器
            app.manage(AppState {
                sidebar_width: Mutex::new(400),
                sidebar_is_closing: Mutex::new(false),
                clipboard_db_path,
            });

            // 注册 Alt+Space 全局快捷键
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            if let Err(error) = app.global_shortcut().register("Alt+Space") {
                eprintln!("注册全局快捷键 Alt+Space 失败: {}", error);
            }

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
