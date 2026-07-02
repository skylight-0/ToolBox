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
const GROUPS_KEY: &str = "groups";
const DEFAULT_OPEN_MODE_KEY: &str = "default_folder_open_mode";
pub const DEFAULT_GROUP_ID: &str = "default";

#[derive(Serialize, Deserialize, Clone)]
pub struct LauncherGroup {
    pub id: String,
    pub name: String,
    pub order: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LauncherItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: String,
    pub item_type: String,
    pub open_mode: Option<String>,
    pub order: i64,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LauncherState {
    pub items: Vec<LauncherItem>,
    pub groups: Vec<LauncherGroup>,
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

fn load_state(app: &AppHandle) -> LauncherState {
    let s = store(app);
    let mut items: Vec<LauncherItem> = s
        .as_ref()
        .and_then(|s| s.get(ITEMS_KEY))
        .and_then(|v| serde_json::from_value::<Vec<LauncherItem>>(v).ok())
        .unwrap_or_default();
    let mut groups: Vec<LauncherGroup> = s
        .as_ref()
        .and_then(|s| s.get(GROUPS_KEY))
        .and_then(|v| serde_json::from_value::<Vec<LauncherGroup>>(v).ok())
        .unwrap_or_default();

    // 确保默认分组存在
    if !groups.iter().any(|g| g.id == DEFAULT_GROUP_ID) {
        groups.push(LauncherGroup {
            id: DEFAULT_GROUP_ID.to_string(),
            name: "常用".to_string(),
            order: 0,
        });
    }
    // 孤儿条目（指向已删除分组）回收到默认分组
    let known: std::collections::HashSet<&str> = groups.iter().map(|g| g.id.as_str()).collect();
    for item in items.iter_mut() {
        if item.group_id.as_deref().map_or(true, |id| !known.contains(id)) {
            item.group_id = None;
        }
    }
    LauncherState { items, groups }
}

fn persist_state(app: &AppHandle, state: &LauncherState) {
    let Some(store) = store(app) else { return };
    let items = serde_json::to_value(&state.items).unwrap_or(serde_json::Value::Null);
    let groups = serde_json::to_value(&state.groups).unwrap_or(serde_json::Value::Null);
    let _ = store.set(ITEMS_KEY, items);
    let _ = store.set(GROUPS_KEY, groups);
    let _ = store.save();
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
        group_id: None,
        icon: None,
    })
}

#[cfg(target_os = "windows")]
fn extract_icon_data_url(path: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Controls::IImageList;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_SYSICONINDEX,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, HICON};

    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let pcw = PCWSTR::from_raw(wide.as_ptr());

    unsafe {
        let mut shfi: SHFILEINFOW = std::mem::zeroed();
        let r = SHGetFileInfoW(
            pcw,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi as *mut SHFILEINFOW),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX,
        );
        if r == 0 {
            return None;
        }
        let index = shfi.iIcon;

        let image_list: IImageList = SHGetImageList::<IImageList>(2i32).ok()?; // SHIL_EXTRALARGE = 2
        let hicon: HICON = image_list.GetIcon(index, 1).ok()?; // ILD_TRANSPARENT = 1
        let data_url = hicon_to_png_data_url(hicon);
        let _ = DestroyIcon(hicon);
        data_url
    }
}

#[cfg(not(target_os = "windows"))]
fn extract_icon_data_url(_path: &str) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn hicon_to_png_data_url(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<String> {
    use windows::Win32::Graphics::Gdi::{
        BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DeleteDC, DeleteObject,
        DIB_RGB_COLORS, GetDIBits, GetObjectW, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    unsafe {
        let mut ii: ICONINFO = std::mem::zeroed();
        if GetIconInfo(hicon, &mut ii as *mut _ as *mut ICONINFO).is_err() {
            return None;
        }
        let hbm_color = ii.hbmColor;
        let hbm_mask = ii.hbmMask;

        let result = (|| -> Option<String> {
            if hbm_color.is_invalid() {
                return None;
            }
            let mut bmp: BITMAP = std::mem::zeroed();
            let n = GetObjectW(
                HGDIOBJ(hbm_color.0),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bmp as *mut _ as *mut core::ffi::c_void),
            );
            if n == 0 {
                return None;
            }
            let width = bmp.bmWidth as u32;
            let height = bmp.bmHeight as u32;
            if width == 0 || height == 0 {
                return None;
            }

            let mut bi: BITMAPINFOHEADER = std::mem::zeroed();
            bi.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bi.biWidth = width as i32;
            bi.biHeight = -(height as i32); // top-down，避免上下翻转
            bi.biPlanes = 1;
            bi.biBitCount = 32;
            bi.biCompression = 0; // BI_RGB
            bi.biSizeImage = width * height * 4;

            let mut bmi: BITMAPINFO = std::mem::zeroed();
            bmi.bmiHeader = bi;

            let mut buf = vec![0u8; (width * height * 4) as usize];
            let hdc = CreateCompatibleDC(None);
            if hdc.is_invalid() {
                return None;
            }
            let ok = GetDIBits(
                hdc,
                hbm_color,
                0,
                height,
                Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                &mut bmi as *mut BITMAPINFO,
                DIB_RGB_COLORS,
            );
            let _ = DeleteDC(hdc);
            if ok == 0 {
                return None;
            }

            // 检测是否有 alpha 通道；现代 48px 图标通常是 32 位预乘 ARGB
            let has_alpha = buf.iter().skip(3).step_by(4).any(|&a| a != 0);

            let mut rgba = vec![0u8; (width * height * 4) as usize];
            let count = (width * height) as usize;
            if has_alpha {
                for i in 0..count {
                    let b = buf[i * 4] as u32;
                    let g = buf[i * 4 + 1] as u32;
                    let r = buf[i * 4 + 2] as u32;
                    let a = buf[i * 4 + 3] as u32;
                    if a == 0 {
                        rgba[i * 4] = 0;
                        rgba[i * 4 + 1] = 0;
                        rgba[i * 4 + 2] = 0;
                        rgba[i * 4 + 3] = 0;
                    } else {
                        // 预乘 alpha 还原为直线 alpha，PNG 才能正确显示半透明边缘
                        rgba[i * 4] = (r * 255 / a).min(255) as u8;
                        rgba[i * 4 + 1] = (g * 255 / a).min(255) as u8;
                        rgba[i * 4 + 2] = (b * 255 / a).min(255) as u8;
                        rgba[i * 4 + 3] = a as u8;
                    }
                }
            } else {
                // 无 alpha：从掩码位图推导透明度（旧式图标）
                let mask_alpha = if !hbm_mask.is_invalid() {
                    let mut mbi: BITMAPINFOHEADER = std::mem::zeroed();
                    mbi.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                    mbi.biWidth = width as i32;
                    mbi.biHeight = -(height as i32);
                    mbi.biPlanes = 1;
                    mbi.biBitCount = 32;
                    let mut mbmi: BITMAPINFO = std::mem::zeroed();
                    mbmi.bmiHeader = mbi;
                    let mut mbuf = vec![0u8; count * 4];
                    let hdc2 = CreateCompatibleDC(None);
                    let mut got = 0;
                    if !hdc2.is_invalid() {
                        got = GetDIBits(
                            hdc2,
                            hbm_mask,
                            0,
                            height,
                            Some(mbuf.as_mut_ptr() as *mut core::ffi::c_void),
                            &mut mbmi as *mut BITMAPINFO,
                            DIB_RGB_COLORS,
                        );
                        let _ = DeleteDC(hdc2);
                    }
                    if got != 0 { Some(mbuf) } else { None }
                } else {
                    None
                };

                for i in 0..count {
                    let b = buf[i * 4];
                    let g = buf[i * 4 + 1];
                    let r = buf[i * 4 + 2];
                    let a = match &mask_alpha {
                        Some(m) => 255 - m[i * 4], // 掩码：白=透明，黑=不透明
                        None => 255,
                    };
                    rgba[i * 4] = r;
                    rgba[i * 4 + 1] = g;
                    rgba[i * 4 + 2] = b;
                    rgba[i * 4 + 3] = a;
                }
            }

            let png = crate::rgba_to_png_bytes(&rgba, width, height).ok()?;
            Some(format!("data:image/png;base64,{}", crate::encode_base64(&png)))
        })();

        if !hbm_color.is_invalid() {
            let _ = DeleteObject(hbm_color.into());
        }
        if !hbm_mask.is_invalid() {
            let _ = DeleteObject(hbm_mask.into());
        }
        result
    }
}

// 在 COM 线程上批量提取缺失的图标，写回条目（Some(data_url) 成功，Some("") 失败占位不再重试）
fn enrich_icons(items: &mut [LauncherItem]) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

        let to_extract: Vec<(usize, String)> = items
            .iter()
            .enumerate()
            .filter(|(_, i)| i.icon.is_none())
            .map(|(idx, i)| (idx, i.path.clone()))
            .collect();
        if to_extract.is_empty() {
            return;
        }

        let handle = std::thread::spawn(move || -> Vec<(usize, Option<String>)> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            let mut results = Vec::with_capacity(to_extract.len());
            for (idx, path) in to_extract {
                let url = extract_icon_data_url(&path);
                results.push((idx, url));
            }
            unsafe {
                CoUninitialize();
            }
            results
        });
        if let Ok(results) = handle.join() {
            for (idx, url) in results {
                if let Some(item) = items.get_mut(idx) {
                    item.icon = Some(url.unwrap_or_default());
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = items;
    }
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
            cmd.spawn().map_err(|e| format!("启动失败: {}", e))?;
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
pub fn launcher_load(app: AppHandle) -> Result<LauncherState, String> {
    let mut state = load_state(&app);
    let had_missing = state.items.iter().any(|i| i.icon.is_none());
    if had_missing {
        enrich_icons(&mut state.items);
        persist_state(&app, &state);
    }
    Ok(state)
}

#[tauri::command]
pub fn launcher_save(app: AppHandle, state: LauncherState) -> Result<LauncherState, String> {
    let mut state = state;
    if !state.groups.iter().any(|g| g.id == DEFAULT_GROUP_ID) {
        state.groups.push(LauncherGroup {
            id: DEFAULT_GROUP_ID.to_string(),
            name: "常用".to_string(),
            order: 0,
        });
    }
    let known: std::collections::HashSet<&str> = state.groups.iter().map(|g| g.id.as_str()).collect();
    for item in state.items.iter_mut() {
        if item.group_id.as_deref().map_or(true, |id| !known.contains(id)) {
            item.group_id = None;
        }
    }
    state.groups.sort_by_key(|g| (g.order, g.name.to_lowercase()));
    state.items.sort_by_key(|i| (i.order, i.name.to_lowercase()));
    persist_state(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn launcher_add_paths(app: AppHandle, paths: Vec<String>) -> Result<LauncherState, String> {
    let mut state = load_state(&app);
    let mut next_order = state.items.iter().map(|i| i.order).max().unwrap_or(0) + 1;
    for raw in paths {
        if let Some(mut item) = build_item_from_path(&raw, next_order) {
            next_order += 1;
            item.group_id = None;
            state.items.push(item);
        }
    }
    enrich_icons(&mut state.items);
    state.items.sort_by_key(|i| (i.order, i.name.to_lowercase()));
    persist_state(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn launcher_launch(app: AppHandle, id: String) -> Result<(), String> {
    let state = load_state(&app);
    let item = state
        .items
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
