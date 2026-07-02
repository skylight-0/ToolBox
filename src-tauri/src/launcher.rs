use std::fs;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

const DETACHED_PROCESS: u32 = 0x00000008;
const STORE_FILE: &str = "launcher.json";
const ITEMS_KEY: &str = "items";
const DEFAULT_OPEN_MODE_KEY: &str = "default_folder_open_mode";

#[derive(Serialize, Deserialize, Clone)]
pub struct LauncherItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: String,
    pub item_type: String,
    pub open_mode: Option<String>,
    pub order: i64,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

fn store<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<std::sync::Arc<tauri_plugin_store::Store<R>>> {
    app.store(STORE_FILE).ok()
}

fn load_items(app: &AppHandle) -> Vec<LauncherItem> {
    let Some(store) = store(app) else { return vec![] };
    store
        .get(ITEMS_KEY)
        .and_then(|v| serde_json::from_value::<Vec<LauncherItem>>(v).ok())
        .unwrap_or_default()
}

fn persist_items(app: &AppHandle, items: &[LauncherItem]) {
    let Some(store) = store(app) else { return };
    let value = serde_json::to_value(items).unwrap_or(serde_json::Value::Null);
    let _ = store.set(ITEMS_KEY, value);
    let _ = store.save();
}

fn sort_items(items: &mut Vec<LauncherItem>) {
    items.sort_by_key(|i| (i.order, i.name.to_lowercase()));
}

#[cfg(target_os = "windows")]
fn resolve_lnk(lnk_path: &str) -> Result<(String, String), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{GUID, Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        IPersistFile,
    };
    use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
    use windows::Win32::UI::Shell::IShellLinkW;

    let clsid = GUID::from_values(
        0x00021401,
        0x0000,
        0x0000,
        [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    );
    let wide: Vec<u16> = std::ffi::OsStr::new(lnk_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let handle = std::thread::spawn(move || -> Result<(String, String), String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let result = (|| {
                let shell_link: IShellLinkW = CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("创建 ShellLink 失败: {}", e))?;
                let persist_file: IPersistFile = shell_link
                    .cast()
                    .map_err(|e| format!("查询 IPersistFile 失败: {}", e))?;
                let pcw = PCWSTR::from_raw(wide.as_ptr());
                persist_file
                    .Load(pcw, windows::Win32::System::Com::STGM::default())
                    .map_err(|e| format!("加载 lnk 失败: {}", e))?;
                let mut target_buf = [0u16; 260];
                let mut find_data: WIN32_FIND_DATAW = std::mem::zeroed();
                shell_link
                    .GetPath(
                        &mut target_buf,
                        &mut find_data as *mut _ as *mut WIN32_FIND_DATAW,
                        0,
                    )
                    .map_err(|e| format!("GetPath 失败: {}", e))?;
                let mut args_buf = [0u16; 512];
                let _ = shell_link.GetArguments(&mut args_buf);
                Ok((from_wide(&target_buf), from_wide(&args_buf)))
            })();
            CoUninitialize();
            result
        }
    });
    handle.join().map_err(|_| "解析 lnk 线程崩溃".to_string())?
}

#[cfg(not(target_os = "windows"))]
fn resolve_lnk(_lnk_path: &str) -> Result<(String, String), String> {
    Err("lnk 解析仅支持 Windows".to_string())
}

fn from_wide(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

fn build_item_from_path(raw: &str, order: i64) -> Option<LauncherItem> {
    let path = raw.trim();
    if path.is_empty() {
        return None;
    }
    let p = Path::new(path);
    let is_lnk = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("lnk"))
        .unwrap_or(false);

    let (resolved, args) = if is_lnk {
        match resolve_lnk(path) {
            Ok((t, a)) if !t.is_empty() => (t, a),
            _ => (path.to_string(), String::new()),
        }
    } else {
        (path.to_string(), String::new())
    };

    let rp = Path::new(&resolved);
    let name = rp
        .file_stem()
        .and_then(|s| s.to_str())
        .or_else(|| p.file_stem().and_then(|s| s.to_str()))
        .unwrap_or("项目")
        .to_string();

    let item_type = if rp.is_dir() {
        "folder"
    } else if rp
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("exe"))
        .unwrap_or(false)
    {
        "app"
    } else {
        "file"
    };

    Some(LauncherItem {
        id: Uuid::new_v4().to_string(),
        name,
        path: resolved,
        args,
        item_type: item_type.to_string(),
        open_mode: None,
        order,
    })
}

fn launch_path(path: &str, args: &str, item_type: &str) -> Result<(), String> {
    match item_type {
        "app" => {
            let mut cmd = Command::new(path);
            let trimmed = args.trim();
            if !trimmed.is_empty() {
                cmd.raw_arg(trimmed);
            }
            cmd.creation_flags(DETACHED_PROCESS);
            cmd.spawn()
                .map_err(|e| format!("启动失败: {}", e))?;
        }
        "folder" => {
            Command::new("explorer")
                .arg(path)
                .spawn()
                .map_err(|e| format!("打开文件夹失败: {}", e))?;
        }
        _ => {
            Command::new("explorer")
                .arg(path)
                .spawn()
                .map_err(|e| format!("打开文件失败: {}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn launcher_load(app: AppHandle) -> Result<Vec<LauncherItem>, String> {
    Ok(load_items(&app))
}

#[tauri::command]
pub fn launcher_add_paths(app: AppHandle, paths: Vec<String>) -> Result<Vec<LauncherItem>, String> {
    let mut items = load_items(&app);
    let mut next_order = items.iter().map(|i| i.order).max().unwrap_or(0) + 1;
    for raw in paths {
        if let Some(item) = build_item_from_path(&raw, next_order) {
            next_order += 1;
            items.push(item);
        }
    }
    sort_items(&mut items);
    persist_items(&app, &items);
    Ok(items)
}

#[tauri::command]
pub fn launcher_remove(app: AppHandle, id: String) -> Result<Vec<LauncherItem>, String> {
    let mut items = load_items(&app);
    items.retain(|i| i.id != id);
    persist_items(&app, &items);
    Ok(items)
}

#[tauri::command]
pub fn launcher_update(app: AppHandle, item: LauncherItem) -> Result<Vec<LauncherItem>, String> {
    let mut items = load_items(&app);
    if let Some(existing) = items.iter_mut().find(|i| i.id == item.id) {
        *existing = item;
    }
    sort_items(&mut items);
    persist_items(&app, &items);
    Ok(items)
}

#[tauri::command]
pub fn launcher_launch(app: AppHandle, id: String) -> Result<(), String> {
    let items = load_items(&app);
    let item = items
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(|| "未找到项目".to_string())?;
    launch_path(&item.path, &item.args, &item.item_type)
}

#[tauri::command]
pub fn launcher_open_external(path: String) -> Result<(), String> {
    Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("打开失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn launcher_list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = vec![];
    let read = fs::read_dir(&path).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in read.flatten() {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let name = entry.file_name().to_string_lossy().to_string();
        let p = entry.path().to_string_lossy().to_string();
        entries.push(DirEntry { name, path: p, is_dir });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
pub fn launcher_get_default_open_mode(app: AppHandle) -> Result<String, String> {
    let mode = store(&app)
        .and_then(|s| s.get(DEFAULT_OPEN_MODE_KEY))
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "external".to_string());
    Ok(mode)
}

#[tauri::command]
pub fn launcher_set_default_open_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let Some(store) = store(&app) else { return Ok(()) };
    let _ = store.set(DEFAULT_OPEN_MODE_KEY, serde_json::Value::String(mode));
    let _ = store.save();
    Ok(())
}
