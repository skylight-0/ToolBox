use std::process::Command;

use tauri::WebviewWindow;
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{FindWindowExW, FindWindowW, ShowWindow, SW_HIDE, SW_SHOWNA},
    },
};
use crate::LaunchTargetRequest;

pub fn toggle_desktop(show: bool) -> Result<(), String> {
    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null()).unwrap_or_default();
        let mut defview =
            FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), PCWSTR::null())
                .unwrap_or_default();

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
}

pub fn toggle_taskbar(window: WebviewWindow, show: bool) -> Result<(), String> {
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
            let _ = window.set_always_on_top(false);
            let _ = window.set_always_on_top(true);
        }

        Ok(())
    }
}

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

pub fn launch_program(_window: WebviewWindow, request: LaunchTargetRequest) -> Result<(), String> {
    let mut cmd = Command::new("cmd");
    let item_type = request.item_type.unwrap_or_else(|| "app".to_string());
    let mut command = format!("start \"\" \"{}\"", request.target.replace('"', "\"\""));
    if matches!(item_type.as_str(), "app" | "script") && request.args.as_deref().unwrap_or("").trim().len() > 0 {
        command.push(' ');
        command.push_str(request.args.as_deref().unwrap_or("").trim());
    }
    cmd.args(["/c", &command]);

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.spawn().map_err(|e| format!("启动目标失败: {}", e))?;
    Ok(())
}

pub async fn extract_program_icon(path: String) -> Result<String, String> {
    let mut cmd = Command::new("powershell");
    let ps_script = format!(
        "Add-Type -AssemblyName System.Drawing; try {{ $icon = [System.Drawing.Icon]::ExtractAssociatedIcon('{}'); if ($icon) {{ $bmp = $icon.ToBitmap(); $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }} }} catch {{}}",
        path.replace('\'', "''")
    );
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps_script]);

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| format!("提取图标失败: {}", e))?;
    let base64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if base64.is_empty() {
        Err("无法提取图标".to_string())
    } else {
        Ok(format!("data:image/png;base64,{}", base64))
    }
}
