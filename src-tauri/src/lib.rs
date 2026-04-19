use serde::Serialize;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{LogicalPosition, LogicalSize, Manager, Position, Size, State};
use tauri_plugin_global_shortcut::ShortcutState;

struct AppState {
    sidebar_width: Mutex<u32>,
    hardware_metrics_cache: Mutex<Option<CachedHardwareMetrics>>,
}

struct CachedHardwareMetrics {
    metrics: HardwareMetrics,
    sampled_at: Instant,
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
        UI::WindowsAndMessaging::{FindWindowExW, FindWindowW, ShowWindow, SW_HIDE, SW_SHOWNA},
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

#[derive(Clone, Serialize)]
struct HardwareMetrics {
    cpu_usage: Option<f64>,
    gpu_usage: Option<f64>,
    memory_usage: Option<f64>,
    memory_used_gb: Option<f64>,
    memory_total_gb: Option<f64>,
    cpu_temperature: Option<f64>,
    gpu_temperature: Option<f64>,
    updated_at: Option<String>,
}

fn parse_metric(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(|v| v.as_f64())
}

#[cfg(target_os = "windows")]
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

fn collect_hardware_metrics() -> Result<HardwareMetrics, String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
$ErrorActionPreference = 'SilentlyContinue'

$cpuUsage = $null
$cpuCounter = Get-Counter '\Processor Information(_Total)\% Processor Utility'
if ($cpuCounter -and $cpuCounter.CounterSamples.Count -gt 0) {
  $cpuUsage = [math]::Round($cpuCounter.CounterSamples[0].CookedValue, 1)
}
if ($null -eq $cpuUsage) {
  $fallbackCpu = Get-Counter '\Processor(_Total)\% Processor Time'
  if ($fallbackCpu -and $fallbackCpu.CounterSamples.Count -gt 0) {
    $cpuUsage = [math]::Round($fallbackCpu.CounterSamples[0].CookedValue, 1)
  }
}

$gpuUsage = $null
$gpuCounters = Get-Counter '\GPU Engine(*)\Utilization Percentage'
if ($gpuCounters) {
  $sum = 0.0
  foreach ($sample in $gpuCounters.CounterSamples) {
    if ($sample.InstanceName -notlike '*_Total*') {
      $sum += $sample.CookedValue
    }
  }
  $gpuUsage = [math]::Round([math]::Min(100, [math]::Max(0, $sum)), 1)
}

$os = Get-CimInstance Win32_OperatingSystem
$memoryTotalGb = $null
$memoryUsedGb = $null
$memoryUsage = $null
if ($os) {
  $totalKb = [double]$os.TotalVisibleMemorySize
  $freeKb = [double]$os.FreePhysicalMemory
  if ($totalKb -gt 0) {
    $usedKb = $totalKb - $freeKb
    $memoryTotalGb = [math]::Round($totalKb / 1MB, 1)
    $memoryUsedGb = [math]::Round($usedKb / 1MB, 1)
    $memoryUsage = [math]::Round(($usedKb / $totalKb) * 100, 1)
  }
}

$cpuTemp = $null
$thermal = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature
if ($thermal) {
  $firstTemp = $thermal | Select-Object -First 1
  if ($firstTemp -and $firstTemp.CurrentTemperature) {
    $cpuTemp = [math]::Round(($firstTemp.CurrentTemperature / 10) - 273.15, 1)
  }
}

$gpuTemp = $null
$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvidiaSmi) {
  $tempText = & $nvidiaSmi.Source --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1
  if ($tempText) {
    $parsedGpuTemp = 0.0
    if ([double]::TryParse($tempText.Trim(), [ref]$parsedGpuTemp)) {
      $gpuTemp = [math]::Round($parsedGpuTemp, 1)
    }
  }
}

[PSCustomObject]@{
  cpu_usage = $cpuUsage
  gpu_usage = $gpuUsage
  memory_usage = $memoryUsage
  memory_used_gb = $memoryUsedGb
  memory_total_gb = $memoryTotalGb
  cpu_temperature = $cpuTemp
  gpu_temperature = $gpuTemp
  updated_at = (Get-Date -Format 'HH:mm:ss')
} | ConvertTo-Json -Compress
"#;

        let output = run_hidden_powershell(script)?;
        let parsed: serde_json::Value =
            serde_json::from_str(&output).map_err(|e| format!("解析硬件信息失败: {}", e))?;

        Ok(HardwareMetrics {
            cpu_usage: parse_metric(parsed.get("cpu_usage")),
            gpu_usage: parse_metric(parsed.get("gpu_usage")),
            memory_usage: parse_metric(parsed.get("memory_usage")),
            memory_used_gb: parse_metric(parsed.get("memory_used_gb")),
            memory_total_gb: parse_metric(parsed.get("memory_total_gb")),
            cpu_temperature: parse_metric(parsed.get("cpu_temperature")),
            gpu_temperature: parse_metric(parsed.get("gpu_temperature")),
            updated_at: parsed
                .get("updated_at")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("仅支持 Windows 平台".to_string())
    }
}

#[tauri::command]
fn get_hardware_metrics(state: State<'_, AppState>) -> Result<HardwareMetrics, String> {
    const HARDWARE_CACHE_TTL: Duration = Duration::from_secs(5);

    if let Ok(cache) = state.hardware_metrics_cache.lock() {
        if let Some(cached) = &*cache {
            if cached.sampled_at.elapsed() < HARDWARE_CACHE_TTL {
                return Ok(cached.metrics.clone());
            }
        }
    }

    match collect_hardware_metrics() {
        Ok(metrics) => {
            if let Ok(mut cache) = state.hardware_metrics_cache.lock() {
                *cache = Some(CachedHardwareMetrics {
                    metrics: metrics.clone(),
                    sampled_at: Instant::now(),
                });
            }
            Ok(metrics)
        }
        Err(error) => {
            if let Ok(cache) = state.hardware_metrics_cache.lock() {
                if let Some(cached) = &*cache {
                    return Ok(cached.metrics.clone());
                }
            }
            Err(error)
        }
    }
}

// 执行快捷系统调用
#[tauri::command]
fn system_action(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "lock_screen" => {
            // 利用 Windows 原生的 rundll32 命令锁屏，避免额外引入 API
            let _ = Command::new("rundll32.exe")
                .args(["user32.dll,LockWorkStation"])
                .spawn();
        }
        "settings" => {
            let _ = Command::new("cmd")
                .args(["/c", "start", "ms-settings:"])
                .spawn();
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

// 启动指定路径的程序（快捷访问功能）
#[tauri::command]
fn launch_program(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "start", "", &path]);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(|e| format!("启动程序失败: {}", e))?;
    let _ = window.emit("hide-sidebar", ());
    Ok(())
}

// 提取程序图标为 base64 PNG 数据（通过 PowerShell 调用 .NET 的 System.Drawing）
#[tauri::command]
async fn extract_program_icon(path: String) -> Result<String, String> {
    let mut cmd = Command::new("powershell");
    let ps_script = format!(
        "Add-Type -AssemblyName System.Drawing; try {{ $icon = [System.Drawing.Icon]::ExtractAssociatedIcon('{}'); if ($icon) {{ $bmp = $icon.ToBitmap(); $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }} }} catch {{}}",
        path.replace('\'', "''")
    );
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps_script]);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| format!("提取图标失败: {}", e))?;
    let base64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if base64.is_empty() {
        Err("无法提取图标".to_string())
    } else {
        Ok(format!("data:image/png;base64,{}", base64))
    }
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
            system_action,
            launch_program,
            extract_program_icon,
            get_hardware_metrics
        ])
        .setup(|app| {
            // 初始化状态管理器
            app.manage(AppState {
                sidebar_width: Mutex::new(400),
                hardware_metrics_cache: Mutex::new(None),
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
