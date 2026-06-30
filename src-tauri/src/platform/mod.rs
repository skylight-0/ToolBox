#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub mod screenshot;

#[cfg(not(target_os = "windows"))]
pub mod screenshot {
    pub struct MonitorRect {
        pub x: i32,
        pub y: i32,
        pub width: i32,
        pub height: i32,
    }

    pub struct CaptureOutput {
        pub png_bytes: Vec<u8>,
        pub width: i32,
        pub height: i32,
    }

    pub fn capture_screens(_monitors: &[MonitorRect]) -> Result<Vec<CaptureOutput>, String> {
        Err("截图仅支持 Windows 平台".to_string())
    }
}

use tauri::WebviewWindow;
use crate::LaunchTargetRequest;

#[cfg(target_os = "windows")]
pub fn toggle_desktop(show: bool) -> Result<(), String> {
    windows::toggle_desktop(show)
}

#[cfg(not(target_os = "windows"))]
pub fn toggle_desktop(_show: bool) -> Result<(), String> {
    Err("仅支持 Windows 平台".to_string())
}

#[cfg(target_os = "windows")]
pub fn toggle_taskbar(window: WebviewWindow, show: bool) -> Result<(), String> {
    windows::toggle_taskbar(window, show)
}

#[cfg(not(target_os = "windows"))]
pub fn toggle_taskbar(_window: WebviewWindow, _show: bool) -> Result<(), String> {
    Err("仅支持 Windows 平台".to_string())
}

#[cfg(target_os = "windows")]
pub fn launch_program(window: WebviewWindow, request: LaunchTargetRequest) -> Result<(), String> {
    windows::launch_program(window, request)
}

#[cfg(not(target_os = "windows"))]
pub fn launch_program(_window: WebviewWindow, _request: LaunchTargetRequest) -> Result<(), String> {
    Err("仅支持 Windows 平台".to_string())
}

#[cfg(target_os = "windows")]
pub async fn extract_program_icon(path: String) -> Result<String, String> {
    windows::extract_program_icon(path).await
}

#[cfg(not(target_os = "windows"))]
pub async fn extract_program_icon(_path: String) -> Result<String, String> {
    Err("仅支持 Windows 平台".to_string())
}
