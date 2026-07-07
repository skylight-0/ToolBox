#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub mod screenshot_native;

#[cfg(target_os = "windows")]
pub mod ocr;

pub mod translate;

#[cfg(not(target_os = "windows"))]
pub mod ocr {
    use crate::OcrOutput;
    pub fn run_ocr(_rgba: &[u8], _width: u32, _height: u32) -> Result<OcrOutput, String> {
        Err("OCR 仅支持 Windows 平台".to_string())
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
