use std::fs;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sysinfo::{Disks, Networks, System, MINIMUM_CPU_UPDATE_INTERVAL};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TodoRecord {
    id: String,
    text: String,
    completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TextGroupRecord {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TextEntryRecord {
    id: String,
    title: String,
    content: String,
    #[serde(rename = "groupId")]
    group_id: String,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TextManagerData {
    groups: Vec<TextGroupRecord>,
    entries: Vec<TextEntryRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QuickLaunchGroupRecord {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QuickLaunchItemRecord {
    id: String,
    name: String,
    path: String,
    icon: Option<String>,
    alias: Option<String>,
    #[serde(rename = "itemType")]
    item_type: Option<String>,
    args: Option<String>,
    #[serde(rename = "groupId")]
    group_id: Option<String>,
    #[serde(rename = "sortOrder")]
    sort_order: Option<i64>,
    #[serde(rename = "launchCount")]
    launch_count: Option<i64>,
    #[serde(rename = "lastLaunchedAt")]
    last_launched_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QuickLaunchData {
    groups: Vec<QuickLaunchGroupRecord>,
    items: Vec<QuickLaunchItemRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CommandHistoryRecord {
    #[serde(rename = "actionKey")]
    action_key: String,
    title: String,
    #[serde(rename = "groupName")]
    group_name: String,
    icon: String,
    meta: Option<String>,
    #[serde(rename = "payloadJson")]
    payload_json: String,
    #[serde(rename = "lastUsedAt")]
    last_used_at: i64,
    #[serde(rename = "useCount")]
    use_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppNotificationRecord {
    id: String,
    level: String,
    title: String,
    message: String,
    source: String,
    #[serde(rename = "createdAt")]
    created_at: i64,
    read: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct AppNotificationInput {
    id: String,
    level: String,
    title: String,
    message: String,
    source: String,
    #[serde(rename = "createdAt")]
    created_at: i64,
    read: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LaunchTargetRequest {
    target: String,
    #[serde(rename = "itemType")]
    item_type: Option<String>,
    args: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfoSnapshot {
    collected_at: i64,
    os: SystemOsInfo,
    cpu: SystemCpuInfo,
    memory: SystemMemoryInfo,
    disk_summary: SystemDiskSummary,
    disks: Vec<SystemDiskInfo>,
    networks: Vec<SystemNetworkInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemOsInfo {
    name: Option<String>,
    version: Option<String>,
    long_version: Option<String>,
    kernel_version: Option<String>,
    host_name: Option<String>,
    architecture: String,
    uptime_seconds: u64,
    boot_time: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemCpuInfo {
    brand: String,
    vendor: String,
    physical_core_count: Option<usize>,
    logical_core_count: usize,
    frequency_mhz: u64,
    usage_percent: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemMemoryInfo {
    total: u64,
    used: u64,
    available: u64,
    free: u64,
    total_swap: u64,
    used_swap: u64,
    free_swap: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemDiskSummary {
    total: u64,
    used: u64,
    available: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemDiskInfo {
    name: String,
    mount_point: String,
    file_system: String,
    kind: String,
    total: u64,
    available: u64,
    used: u64,
    is_removable: bool,
    is_read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemNetworkInfo {
    name: String,
    mac_address: String,
    ip_addresses: Vec<String>,
    received: u64,
    transmitted: u64,
    packets_received: u64,
    packets_transmitted: u64,
    mtu: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TcpPortCheckRequest {
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TcpPortCheckResult {
    host: String,
    port: u16,
    reachable: bool,
    resolved_address: Option<String>,
    duration_ms: u128,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DnsLookupResult {
    host: String,
    addresses: Vec<String>,
    duration_ms: u128,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PingRequest {
    host: String,
    count: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PingResult {
    host: String,
    success: bool,
    exit_code: Option<i32>,
    duration_ms: u128,
    packet_loss_percent: Option<f32>,
    average_ms: Option<f32>,
    output: String,
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
        let work_area = monitor.work_area();
        let work_size = work_area.size.to_logical::<f64>(scale_factor);
        let work_pos = work_area.position.to_logical::<f64>(scale_factor);

        let work_height = work_size.height;
        let work_width = work_size.width;

        // 使用工作区定位，避免覆盖任务栏或其他系统保留区域。
        let logical_width = (width as f64).min(work_width);
        let x = work_pos.x + (work_width - logical_width);
        let y = work_pos.y;

        let _ = window.set_size(Size::Logical(LogicalSize::new(
            logical_width,
            work_height,
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
// #[tauri::command]
// fn toggle_taskbar(window: tauri::WebviewWindow, show: bool) -> Result<(), String> {
//     platform::toggle_taskbar(window, show)
// }

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

fn init_app_db(path: &PathBuf) -> Result<(), String> {
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

            CREATE TABLE IF NOT EXISTS todo_items (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS text_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS text_entries (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                group_id TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS quicklaunch_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS quicklaunch_items (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                icon TEXT,
                alias TEXT,
                item_type TEXT NOT NULL DEFAULT 'app',
                args TEXT NOT NULL DEFAULT '',
                group_id TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                launch_count INTEGER NOT NULL DEFAULT 0,
                last_launched_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS command_history (
                action_key TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                group_name TEXT NOT NULL,
                icon TEXT NOT NULL,
                meta TEXT,
                payload_json TEXT NOT NULL,
                last_used_at INTEGER NOT NULL,
                use_count INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS notification_history (
                id TEXT PRIMARY KEY,
                level TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                read INTEGER NOT NULL DEFAULT 0
            );
            ",
        )
        .map_err(|error| format!("创建应用数据表失败: {}", error))?;
    connection
        .execute_batch(
            "
            ALTER TABLE quicklaunch_items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'app';
            ALTER TABLE quicklaunch_items ADD COLUMN args TEXT NOT NULL DEFAULT '';
            ALTER TABLE quicklaunch_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
            ",
        )
        .ok();
    Ok(())
}

fn emit_app_notification<R: tauri::Runtime>(
    emitter: &impl tauri::Emitter<R>,
    notification: &AppNotificationRecord,
) {
    let _ = emitter.emit("app-notification", notification);
}

fn trim_notification_history(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM notification_history
             WHERE id NOT IN (
               SELECT id FROM notification_history ORDER BY created_at DESC LIMIT 50
             )",
            [],
        )
        .map_err(|error| format!("裁剪通知历史失败: {}", error))?;
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

fn replace_todos(connection: &Connection, todos: &[TodoRecord]) -> Result<(), String> {
    connection
        .execute("DELETE FROM todo_items", [])
        .map_err(|error| format!("清空待办数据失败: {}", error))?;
    let mut statement = connection
        .prepare("INSERT INTO todo_items (id, text, completed) VALUES (?1, ?2, ?3)")
        .map_err(|error| format!("准备保存待办数据失败: {}", error))?;
    for todo in todos {
        statement
            .execute(params![todo.id, todo.text, i64::from(todo.completed)])
            .map_err(|error| format!("保存待办数据失败: {}", error))?;
    }
    Ok(())
}

fn replace_text_manager_data(connection: &Connection, data: &TextManagerData) -> Result<(), String> {
    connection
        .execute("DELETE FROM text_groups", [])
        .map_err(|error| format!("清空文本分组失败: {}", error))?;
    connection
        .execute("DELETE FROM text_entries", [])
        .map_err(|error| format!("清空文本条目失败: {}", error))?;

    let mut group_statement = connection
        .prepare("INSERT INTO text_groups (id, name) VALUES (?1, ?2)")
        .map_err(|error| format!("准备保存文本分组失败: {}", error))?;
    for group in &data.groups {
        group_statement
            .execute(params![group.id, group.name])
            .map_err(|error| format!("保存文本分组失败: {}", error))?;
    }

    let mut entry_statement = connection
        .prepare(
            "INSERT INTO text_entries (id, title, content, group_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(|error| format!("准备保存文本条目失败: {}", error))?;
    for entry in &data.entries {
        entry_statement
            .execute(params![
                entry.id,
                entry.title,
                entry.content,
                entry.group_id,
                entry.updated_at
            ])
            .map_err(|error| format!("保存文本条目失败: {}", error))?;
    }
    Ok(())
}

fn replace_quicklaunch_data(connection: &Connection, data: &QuickLaunchData) -> Result<(), String> {
    connection
        .execute("DELETE FROM quicklaunch_groups", [])
        .map_err(|error| format!("清空快捷启动分组失败: {}", error))?;
    connection
        .execute("DELETE FROM quicklaunch_items", [])
        .map_err(|error| format!("清空快捷启动条目失败: {}", error))?;

    let mut group_statement = connection
        .prepare("INSERT INTO quicklaunch_groups (id, name) VALUES (?1, ?2)")
        .map_err(|error| format!("准备保存快捷启动分组失败: {}", error))?;
    for group in &data.groups {
        group_statement
            .execute(params![group.id, group.name])
            .map_err(|error| format!("保存快捷启动分组失败: {}", error))?;
    }

    let mut item_statement = connection
        .prepare(
            "INSERT INTO quicklaunch_items
             (id, name, path, icon, alias, item_type, args, group_id, sort_order, launch_count, last_launched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )
        .map_err(|error| format!("准备保存快捷启动条目失败: {}", error))?;
    for item in &data.items {
        item_statement
            .execute(params![
                item.id,
                item.name,
                item.path,
                item.icon,
                item.alias,
                item.item_type.clone().unwrap_or_else(|| "app".to_string()),
                item.args.clone().unwrap_or_default(),
                item.group_id,
                item.sort_order.unwrap_or(0),
                item.launch_count.unwrap_or(0),
                item.last_launched_at.unwrap_or(0),
            ])
            .map_err(|error| format!("保存快捷启动条目失败: {}", error))?;
    }
    Ok(())
}

fn upsert_command_history_record(
    connection: &Connection,
    entry: &CommandHistoryRecord,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO command_history
             (action_key, title, group_name, icon, meta, payload_json, last_used_at, use_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
             ON CONFLICT(action_key) DO UPDATE SET
               title = excluded.title,
               group_name = excluded.group_name,
               icon = excluded.icon,
               meta = excluded.meta,
               payload_json = excluded.payload_json,
               last_used_at = excluded.last_used_at,
               use_count = command_history.use_count + 1",
            params![
                entry.action_key,
                entry.title,
                entry.group_name,
                entry.icon,
                entry.meta,
                entry.payload_json,
                entry.last_used_at
            ],
        )
        .map_err(|error| format!("写入命令历史失败: {}", error))?;
    Ok(())
}

fn insert_notification_record(
    connection: &Connection,
    notification: &AppNotificationInput,
) -> Result<AppNotificationRecord, String> {
    connection
        .execute(
            "INSERT OR REPLACE INTO notification_history
             (id, level, title, message, source, created_at, read)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                notification.id,
                notification.level,
                notification.title,
                notification.message,
                notification.source,
                notification.created_at,
                i64::from(notification.read.unwrap_or(false)),
            ],
        )
        .map_err(|error| format!("写入通知历史失败: {}", error))?;
    trim_notification_history(connection)?;
    Ok(AppNotificationRecord {
        id: notification.id.clone(),
        level: notification.level.clone(),
        title: notification.title.clone(),
        message: notification.message.clone(),
        source: notification.source.clone(),
        created_at: notification.created_at,
        read: notification.read.unwrap_or(false),
    })
}

// 切换任务栏的隐藏/显示
#[tauri::command]
fn toggle_taskbar(window: tauri::WebviewWindow, show: bool) -> Result<(), String> {
    platform::toggle_taskbar(window, show)
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

#[cfg(target_os = "windows")]
fn current_windows_username() -> Result<String, String> {
    use windows_sys::Win32::System::WindowsProgramming::GetUserNameW;

    unsafe {
        let mut username = vec![0u16; 256];
        let mut username_len = username.len() as u32;
        if GetUserNameW(username.as_mut_ptr(), &mut username_len) == 0 {
            return std::env::var("USERNAME")
                .map_err(|e| format!("读取当前 Windows 用户名失败: {}", e));
        }
        Ok(wide_to_string(&username))
    }
}

#[tauri::command]
fn authenticate_password_vault() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    unsafe {
        use std::{mem, ptr};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            Security::{
                Credentials::{
                    CredUIPromptForCredentialsW, CREDUI_FLAGS_DO_NOT_PERSIST,
                    CREDUI_FLAGS_KEEP_USERNAME, CREDUI_INFOW,
                },
                LogonUserW, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT,
            },
        };

        const ERROR_CANCELLED: u32 = 1223;

        let message = wide_null("请输入当前 Windows 用户密码以打开密码管理工具。");
        let caption = wide_null("ToolBox 密码管理");
        let target_name = wide_null("ToolBox 密码管理");
        let ui_info = CREDUI_INFOW {
            cbSize: mem::size_of::<CREDUI_INFOW>() as u32,
            hwndParent: ptr::null_mut(),
            pszMessageText: message.as_ptr(),
            pszCaptionText: caption.as_ptr(),
            hbmBanner: ptr::null_mut(),
        };

        let current_username = current_windows_username()?;
        let env_domain = std::env::var("USERDOMAIN").unwrap_or_default();
        let prompt_username = if current_username.contains('\\') || env_domain.is_empty() {
            current_username.clone()
        } else {
            format!("{}\\{}", env_domain, current_username)
        };
        let mut prompt_username_w = wide_null(&prompt_username);
        prompt_username_w.resize(256, 0);
        let mut password = vec![0u16; 512];
        let mut save = 0i32;
        let prompt_result = CredUIPromptForCredentialsW(
            &ui_info,
            target_name.as_ptr(),
            ptr::null(),
            0,
            prompt_username_w.as_mut_ptr(),
            prompt_username_w.len() as u32,
            password.as_mut_ptr(),
            password.len() as u32,
            &mut save,
            CREDUI_FLAGS_DO_NOT_PERSIST | CREDUI_FLAGS_KEEP_USERNAME,
        );

        if prompt_result == ERROR_CANCELLED {
            return Ok(false);
        }
        if prompt_result != 0 {
            return Err(format!("系统凭据验证窗口打开失败: {}", prompt_result));
        }

        let mut username_text = current_username;
        let mut domain_text = env_domain;
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
        Err("Windows 用户密码验证仅支持 Windows 平台".to_string())
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
fn save_image_data(path: String, data_url: String) -> Result<(), String> {
    let bytes = decode_data_url(&data_url)?;
    fs::write(path, bytes).map_err(|e| format!("保存图片失败: {}", e))
}

// 启动指定路径的程序（快捷访问功能）
#[tauri::command]
fn launch_program(window: tauri::WebviewWindow, request: LaunchTargetRequest) -> Result<(), String> {
    let result = platform::launch_program(window.clone(), request.clone());
    if let Err(error) = &result {
        let notification = AppNotificationInput {
            id: format!("launch-{}", chrono_like_timestamp()),
            level: "error".to_string(),
            title: "启动失败".to_string(),
            message: error.clone(),
            source: "quicklaunch".to_string(),
            created_at: chrono_like_timestamp(),
            read: Some(false),
        };
        let state: State<'_, AppState> = window.state();
        if let Ok(connection) = open_clipboard_db(&state) {
            if let Ok(record) = insert_notification_record(&connection, &notification) {
                emit_app_notification(&window, &record);
            }
        }
    }
    result?;
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
) -> Result<bool, String> {
    let connection = open_clipboard_db(&state)?;
    let latest_record = connection
        .query_row(
            "SELECT type, content
             FROM clipboard_history
             ORDER BY timestamp DESC
             LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("读取最新剪贴板记录失败: {}", error))?;

    if latest_record
        .as_ref()
        .is_some_and(|(record_type, content)| {
            record_type == &record.record_type && content == &record.content
        })
    {
        return Ok(false);
    }

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
    Ok(true)
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

#[tauri::command]
fn get_todos(state: State<'_, AppState>) -> Result<Vec<TodoRecord>, String> {
    let connection = open_clipboard_db(&state)?;
    let mut statement = connection
        .prepare("SELECT id, text, completed FROM todo_items")
        .map_err(|error| format!("读取待办失败: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(TodoRecord {
                id: row.get("id")?,
                text: row.get("text")?,
                completed: row.get::<_, i64>("completed")? != 0,
            })
        })
        .map_err(|error| format!("查询待办失败: {}", error))?;

    rows.into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析待办失败: {}", error))
}

#[tauri::command]
fn save_todos(state: State<'_, AppState>, todos: Vec<TodoRecord>) -> Result<(), String> {
    let mut connection = open_clipboard_db(&state)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始保存待办事务失败: {}", error))?;
    replace_todos(&transaction, &todos)?;
    transaction
        .commit()
        .map_err(|error| format!("提交待办事务失败: {}", error))
}

#[tauri::command]
fn get_text_manager_data(state: State<'_, AppState>) -> Result<TextManagerData, String> {
    let connection = open_clipboard_db(&state)?;

    let mut group_statement = connection
        .prepare("SELECT id, name FROM text_groups ORDER BY id")
        .map_err(|error| format!("读取文本分组失败: {}", error))?;
    let groups = group_statement
        .query_map([], |row| {
            Ok(TextGroupRecord {
                id: row.get("id")?,
                name: row.get("name")?,
            })
        })
        .map_err(|error| format!("查询文本分组失败: {}", error))?
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析文本分组失败: {}", error))?;

    let mut entry_statement = connection
        .prepare("SELECT id, title, content, group_id, updated_at FROM text_entries")
        .map_err(|error| format!("读取文本条目失败: {}", error))?;
    let entries = entry_statement
        .query_map([], |row| {
            Ok(TextEntryRecord {
                id: row.get("id")?,
                title: row.get("title")?,
                content: row.get("content")?,
                group_id: row.get("group_id")?,
                updated_at: row.get("updated_at")?,
            })
        })
        .map_err(|error| format!("查询文本条目失败: {}", error))?
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析文本条目失败: {}", error))?;

    Ok(TextManagerData { groups, entries })
}

#[tauri::command]
fn save_text_manager_data(
    state: State<'_, AppState>,
    data: TextManagerData,
) -> Result<(), String> {
    let mut connection = open_clipboard_db(&state)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始保存文本管理事务失败: {}", error))?;
    replace_text_manager_data(&transaction, &data)?;
    transaction
        .commit()
        .map_err(|error| format!("提交文本管理事务失败: {}", error))
}

#[tauri::command]
fn get_quicklaunch_data(state: State<'_, AppState>) -> Result<QuickLaunchData, String> {
    let connection = open_clipboard_db(&state)?;

    let mut group_statement = connection
        .prepare("SELECT id, name FROM quicklaunch_groups ORDER BY id")
        .map_err(|error| format!("读取快捷启动分组失败: {}", error))?;
    let groups = group_statement
        .query_map([], |row| {
            Ok(QuickLaunchGroupRecord {
                id: row.get("id")?,
                name: row.get("name")?,
            })
        })
        .map_err(|error| format!("查询快捷启动分组失败: {}", error))?
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析快捷启动分组失败: {}", error))?;

    let mut item_statement = connection
        .prepare(
            "SELECT id, name, path, icon, alias, item_type, args, group_id, sort_order, launch_count, last_launched_at
             FROM quicklaunch_items",
        )
        .map_err(|error| format!("读取快捷启动条目失败: {}", error))?;
    let items = item_statement
        .query_map([], |row| {
            Ok(QuickLaunchItemRecord {
                id: row.get("id")?,
                name: row.get("name")?,
                path: row.get("path")?,
                icon: row.get("icon")?,
                alias: row.get("alias")?,
                item_type: row.get("item_type")?,
                args: row.get("args")?,
                group_id: row.get("group_id")?,
                sort_order: Some(row.get("sort_order")?),
                launch_count: Some(row.get("launch_count")?),
                last_launched_at: Some(row.get("last_launched_at")?),
            })
        })
        .map_err(|error| format!("查询快捷启动条目失败: {}", error))?
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析快捷启动条目失败: {}", error))?;

    Ok(QuickLaunchData { groups, items })
}

#[tauri::command]
fn get_command_history(state: State<'_, AppState>) -> Result<Vec<CommandHistoryRecord>, String> {
    let connection = open_clipboard_db(&state)?;
    let mut statement = connection
        .prepare(
            "SELECT action_key, title, group_name, icon, meta, payload_json, last_used_at, use_count
             FROM command_history
             ORDER BY last_used_at DESC
             LIMIT 20",
        )
        .map_err(|error| format!("读取命令历史失败: {}", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(CommandHistoryRecord {
                action_key: row.get("action_key")?,
                title: row.get("title")?,
                group_name: row.get("group_name")?,
                icon: row.get("icon")?,
                meta: row.get("meta")?,
                payload_json: row.get("payload_json")?,
                last_used_at: row.get("last_used_at")?,
                use_count: row.get("use_count")?,
            })
        })
        .map_err(|error| format!("查询命令历史失败: {}", error))?;
    rows.into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析命令历史失败: {}", error))
}

#[tauri::command]
fn upsert_command_history(
    state: State<'_, AppState>,
    entry: CommandHistoryRecord,
) -> Result<(), String> {
    let connection = open_clipboard_db(&state)?;
    upsert_command_history_record(&connection, &entry)
}

#[tauri::command]
fn get_notification_history(state: State<'_, AppState>) -> Result<Vec<AppNotificationRecord>, String> {
    let connection = open_clipboard_db(&state)?;
    let mut statement = connection
        .prepare(
            "SELECT id, level, title, message, source, created_at, read
             FROM notification_history
             ORDER BY created_at DESC
             LIMIT 50",
        )
        .map_err(|error| format!("读取通知历史失败: {}", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(AppNotificationRecord {
                id: row.get("id")?,
                level: row.get("level")?,
                title: row.get("title")?,
                message: row.get("message")?,
                source: row.get("source")?,
                created_at: row.get("created_at")?,
                read: row.get::<_, i64>("read")? != 0,
            })
        })
        .map_err(|error| format!("查询通知历史失败: {}", error))?;
    rows.into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析通知历史失败: {}", error))
}

#[tauri::command]
fn insert_notification(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    notification: AppNotificationInput,
) -> Result<(), String> {
    let connection = open_clipboard_db(&state)?;
    let record = insert_notification_record(&connection, &notification)?;
    emit_app_notification(&app, &record);
    Ok(())
}

#[tauri::command]
fn mark_notification_read(state: State<'_, AppState>, id: String, read: bool) -> Result<(), String> {
    let connection = open_clipboard_db(&state)?;
    connection
        .execute(
            "UPDATE notification_history SET read = ?2 WHERE id = ?1",
            params![id, i64::from(read)],
        )
        .map_err(|error| format!("更新通知状态失败: {}", error))?;
    Ok(())
}

#[tauri::command]
fn clear_notification_history(state: State<'_, AppState>) -> Result<(), String> {
    let connection = open_clipboard_db(&state)?;
    connection
        .execute("DELETE FROM notification_history", [])
        .map_err(|error| format!("清空通知历史失败: {}", error))?;
    Ok(())
}

#[tauri::command]
fn save_quicklaunch_data(
    state: State<'_, AppState>,
    data: QuickLaunchData,
) -> Result<(), String> {
    let mut connection = open_clipboard_db(&state)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始保存快捷启动事务失败: {}", error))?;
    replace_quicklaunch_data(&transaction, &data)?;
    transaction
        .commit()
        .map_err(|error| format!("提交快捷启动事务失败: {}", error))
}

#[tauri::command]
fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let connection = open_clipboard_db(&state)?;
    connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("读取设置失败: {}", error))
}

#[tauri::command]
fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let connection = open_clipboard_db(&state)?;
    connection
        .execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|error| format!("保存设置失败: {}", error))?;
    Ok(())
}

#[tauri::command]
fn get_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("读取开机自启状态失败: {}", error))
}

#[tauri::command]
fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|error| format!("启用开机自启失败: {}", error))?;
    } else {
        manager
            .disable()
            .map_err(|error| format!("关闭开机自启失败: {}", error))?;
    }
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

fn chrono_like_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
fn get_system_info() -> Result<SystemInfoSnapshot, String> {
    let mut system = System::new_all();
    std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_cpu_usage();
    system.refresh_memory();

    let cpu = system.cpus().first();
    let disks = Disks::new_with_refreshed_list();
    let networks = Networks::new_with_refreshed_list();

    let mut disk_records = disks
        .list()
        .iter()
        .filter(|disk| disk.total_space() > 0)
        .map(|disk| {
            let total = disk.total_space();
            let available = disk.available_space();
            SystemDiskInfo {
                name: disk.name().to_string_lossy().into_owned(),
                mount_point: disk.mount_point().to_string_lossy().into_owned(),
                file_system: disk.file_system().to_string_lossy().into_owned(),
                kind: format!("{:?}", disk.kind()),
                total,
                available,
                used: total.saturating_sub(available),
                is_removable: disk.is_removable(),
                is_read_only: disk.is_read_only(),
            }
        })
        .collect::<Vec<_>>();
    disk_records.sort_by(|left, right| left.mount_point.cmp(&right.mount_point));

    let disk_total = disk_records.iter().map(|disk| disk.total).sum::<u64>();
    let disk_available = disk_records.iter().map(|disk| disk.available).sum::<u64>();

    let mut network_records = networks
        .iter()
        .map(|(name, network)| SystemNetworkInfo {
            name: name.clone(),
            mac_address: network.mac_address().to_string(),
            ip_addresses: network
                .ip_networks()
                .iter()
                .map(ToString::to_string)
                .collect(),
            received: network.total_received(),
            transmitted: network.total_transmitted(),
            packets_received: network.total_packets_received(),
            packets_transmitted: network.total_packets_transmitted(),
            mtu: network.mtu(),
        })
        .collect::<Vec<_>>();
    network_records.sort_by(|left, right| left.name.cmp(&right.name));

    Ok(SystemInfoSnapshot {
        collected_at: chrono_like_timestamp(),
        os: SystemOsInfo {
            name: System::name(),
            version: System::os_version(),
            long_version: System::long_os_version(),
            kernel_version: System::kernel_version(),
            host_name: System::host_name(),
            architecture: System::cpu_arch(),
            uptime_seconds: System::uptime(),
            boot_time: System::boot_time(),
        },
        cpu: SystemCpuInfo {
            brand: cpu
                .map(|item| item.brand().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "未知 CPU".to_string()),
            vendor: cpu
                .map(|item| item.vendor_id().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "未知厂商".to_string()),
            physical_core_count: System::physical_core_count(),
            logical_core_count: system.cpus().len(),
            frequency_mhz: cpu.map(|item| item.frequency()).unwrap_or(0),
            usage_percent: system.global_cpu_usage(),
        },
        memory: SystemMemoryInfo {
            total: system.total_memory(),
            used: system.used_memory(),
            available: system.available_memory(),
            free: system.free_memory(),
            total_swap: system.total_swap(),
            used_swap: system.used_swap(),
            free_swap: system.free_swap(),
        },
        disk_summary: SystemDiskSummary {
            total: disk_total,
            used: disk_total.saturating_sub(disk_available),
            available: disk_available,
        },
        disks: disk_records,
        networks: network_records,
    })
}

fn normalize_network_host(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("目标地址不能为空".to_string());
    }

    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let without_path = without_scheme
        .split(|ch| matches!(ch, '/' | '?' | '#'))
        .next()
        .unwrap_or(without_scheme);
    let without_userinfo = without_path.rsplit('@').next().unwrap_or(without_path);
    let host = without_userinfo.trim();

    if host.starts_with('[') {
        if let Some(end_index) = host.find(']') {
            let ipv6 = host[1..end_index].trim();
            if !ipv6.is_empty() {
                return Ok(ipv6.to_string());
            }
        }
    }

    let colon_count = host.matches(':').count();
    let host_without_port = if colon_count == 1 {
        let (name, maybe_port) = host.rsplit_once(':').unwrap_or((host, ""));
        if maybe_port.chars().all(|ch| ch.is_ascii_digit()) {
            name
        } else {
            host
        }
    } else {
        host
    };

    let normalized = host_without_port
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']');
    if normalized.is_empty() {
        Err("目标地址无效".to_string())
    } else {
        Ok(normalized.to_string())
    }
}

fn unique_sorted(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut items = values.into_iter().collect::<Vec<_>>();
    items.sort();
    items.dedup();
    items
}

fn parse_packet_loss(output: &str) -> Option<f32> {
    for line in output.lines() {
        if let Some(percent_index) = line.find('%') {
            let before_percent = &line[..percent_index];
            let number = before_percent
                .split(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
                .filter(|part| !part.is_empty())
                .last()?;
            if line.to_ascii_lowercase().contains("loss") || line.contains("丢失") {
                if let Ok(value) = number.parse::<f32>() {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn parse_average_ping_ms(output: &str) -> Option<f32> {
    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("min/avg/max") {
            let (_, values) = line.split_once('=')?;
            let avg = values.trim().split('/').nth(1)?;
            if let Ok(value) = avg.trim().parse::<f32>() {
                return Some(value);
            }
        }
        if let Some((_, value)) = line.split_once("Average =") {
            let avg = value.trim().trim_end_matches("ms").trim();
            if let Ok(parsed) = avg.parse::<f32>() {
                return Some(parsed);
            }
        }
        if let Some((_, value)) = line.split_once("平均 =") {
            let avg = value.trim().trim_end_matches("ms").trim();
            if let Ok(parsed) = avg.parse::<f32>() {
                return Some(parsed);
            }
        }
    }
    None
}

#[tauri::command]
fn resolve_dns(host: String) -> Result<DnsLookupResult, String> {
    let normalized_host = normalize_network_host(&host)?;
    let started_at = Instant::now();
    let addresses = (normalized_host.as_str(), 0)
        .to_socket_addrs()
        .map_err(|error| format!("DNS 解析失败: {}", error))?;
    let addresses = unique_sorted(addresses.map(|address| address.ip().to_string()));

    Ok(DnsLookupResult {
        host: normalized_host,
        addresses,
        duration_ms: started_at.elapsed().as_millis(),
    })
}

#[tauri::command]
fn check_tcp_port(request: TcpPortCheckRequest) -> Result<TcpPortCheckResult, String> {
    let host = normalize_network_host(&request.host)?;
    if request.port == 0 {
        return Err("端口必须在 1-65535 之间".to_string());
    }

    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(2000).clamp(200, 10000));
    let started_at = Instant::now();
    let addresses = (host.as_str(), request.port)
        .to_socket_addrs()
        .map_err(|error| format!("解析目标失败: {}", error))?
        .collect::<Vec<_>>();

    if addresses.is_empty() {
        return Ok(TcpPortCheckResult {
            host,
            port: request.port,
            reachable: false,
            resolved_address: None,
            duration_ms: started_at.elapsed().as_millis(),
            error: Some("没有解析到可连接地址".to_string()),
        });
    }

    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(_) => {
                return Ok(TcpPortCheckResult {
                    host,
                    port: request.port,
                    reachable: true,
                    resolved_address: Some(address.to_string()),
                    duration_ms: started_at.elapsed().as_millis(),
                    error: None,
                });
            }
            Err(error) => {
                last_error = Some(format!("{}: {}", address, error));
            }
        }
    }

    Ok(TcpPortCheckResult {
        host,
        port: request.port,
        reachable: false,
        resolved_address: None,
        duration_ms: started_at.elapsed().as_millis(),
        error: last_error,
    })
}

#[tauri::command]
fn run_ping(request: PingRequest) -> Result<PingResult, String> {
    let host = normalize_network_host(&request.host)?;
    let count = request.count.unwrap_or(4).clamp(1, 10).to_string();
    let started_at = Instant::now();

    #[cfg(target_os = "windows")]
    let output = Command::new("ping")
        .args(["-n", &count, "-w", "2000", &host])
        .output();

    #[cfg(target_os = "macos")]
    let output = Command::new("ping")
        .args(["-c", &count, "-W", "2000", &host])
        .output();

    #[cfg(all(unix, not(target_os = "macos")))]
    let output = Command::new("ping")
        .args(["-c", &count, "-W", "2", &host])
        .output();

    #[cfg(not(any(unix, target_os = "windows")))]
    let output = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "当前平台不支持 ping",
    ));

    let output = output.map_err(|error| format!("执行 ping 失败: {}", error))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let text = if stderr.trim().is_empty() {
        stdout
    } else if stdout.trim().is_empty() {
        stderr
    } else {
        format!("{}\n{}", stdout.trim_end(), stderr)
    };

    Ok(PingResult {
        host,
        success: output.status.success(),
        exit_code: output.status.code(),
        duration_ms: started_at.elapsed().as_millis(),
        packet_loss_percent: parse_packet_loss(&text),
        average_ms: parse_average_ping_ms(&text),
        output: text.trim().to_string(),
    })
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
            clear_clipboard_records,
            get_todos,
            save_todos,
            get_text_manager_data,
            save_text_manager_data,
            get_quicklaunch_data,
            save_quicklaunch_data,
            get_command_history,
            upsert_command_history,
            get_notification_history,
            insert_notification,
            mark_notification_read,
            clear_notification_history,
            get_setting,
            set_setting,
            get_autostart_enabled,
            set_autostart_enabled,
            get_system_info,
            resolve_dns,
            check_tcp_port,
            run_ping,
            authenticate_password_vault,
            load_password_vault,
            save_password_vault
        ])
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("读取应用数据目录失败: {}", error))?;
            fs::create_dir_all(&app_data_dir)
                .map_err(|error| format!("创建应用数据目录失败: {}", error))?;
            let clipboard_db_path = app_data_dir.join("clipboard.sqlite");
            init_app_db(&clipboard_db_path)?;

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
                let state: State<'_, AppState> = app.state();
                if let Ok(connection) = open_clipboard_db(&state) {
                    let input = AppNotificationInput {
                        id: format!("shortcut-{}", chrono_like_timestamp()),
                        level: "error".to_string(),
                        title: "快捷键注册失败".to_string(),
                        message: format!("Alt+Space 注册失败: {}", error),
                        source: "system".to_string(),
                        created_at: chrono_like_timestamp(),
                        read: Some(false),
                    };
                    if let Ok(record) = insert_notification_record(&connection, &input) {
                        emit_app_notification(app, &record);
                    }
                }
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
