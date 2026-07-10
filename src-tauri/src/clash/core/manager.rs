//! Clash 内核管理器
//! 
//! 负责 Mihomo 内核的启动、停止、状态管理

use anyhow::Result;
use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex as TokioMutex;

use crate::clash::config::runtime::{build_runtime_config, RuntimeConfigParams};
use crate::clash::core::sysopt::{SysproxyConfig, Sysopt};

/// 运行模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum RunningMode {
    /// 服务模式 (通过系统服务运行)
    Service,
    /// Sidecar 模式 (作为子进程运行)
    Sidecar,
    /// 未运行
    NotRunning,
}

impl Default for RunningMode {
    fn default() -> Self {
        Self::NotRunning
    }
}

impl std::fmt::Display for RunningMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Service => write!(f, "Service"),
            Self::Sidecar => write!(f, "Sidecar"),
            Self::NotRunning => write!(f, "NotRunning"),
        }
    }
}

/// 内核状态
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreState {
    pub running_mode: RunningMode,
    pub is_running: bool,
    pub mixed_port: Option<u16>,
    pub socks_port: Option<u16>,
    pub http_port: Option<u16>,
    pub controller: Option<String>,
    pub secret: Option<String>,
}

impl Default for CoreState {
    fn default() -> Self {
        Self {
            running_mode: RunningMode::NotRunning,
            is_running: false,
            mixed_port: None,
            socks_port: None,
            http_port: None,
            controller: None,
            secret: None,
        }
    }
}

/// 内核管理器
pub struct CoreManager {
    /// 当前运行模式
    running_mode: RwLock<RunningMode>,
    /// Sidecar 子进程句柄
    child_sidecar: RwLock<Option<tauri_plugin_shell::process::CommandChild>>,
    /// 生命周期锁 (防止并发 start/stop)
    lifecycle_lock: TokioMutex<()>,
    /// 应用句柄
    app_handle: RwLock<Option<AppHandle>>,
    /// mihomo 数据目录 (-d 参数指向的目录)
    data_dir: RwLock<Option<PathBuf>>,
    /// External Controller 地址 (例如 127.0.0.1:9090)
    controller: RwLock<Option<String>>,
    /// External Controller 密钥
    secret: RwLock<Option<String>>,
    /// Mixed 端口
    mixed_port: RwLock<Option<u16>>,
    /// 当前内核"代"标识：每次成功 spawn 一个新 child 时自增，
    /// 后台监听线程用它判断 Terminated 事件是否属于"当前"的 child，
    /// 从而避免旧 child 的退出事件覆盖新 child 的运行状态（参见问题 4）。
    generation: AtomicU64,
}

impl Default for CoreManager {
    fn default() -> Self {
        Self {
            running_mode: RwLock::new(RunningMode::NotRunning),
            child_sidecar: RwLock::new(None),
            lifecycle_lock: TokioMutex::new(()),
            app_handle: RwLock::new(None),
            data_dir: RwLock::new(None),
            controller: RwLock::new(None),
            secret: RwLock::new(None),
            mixed_port: RwLock::new(None),
            generation: AtomicU64::new(0),
        }
    }
}

impl CoreManager {
    /// 创建新的内核管理器
    fn new() -> Self {
        Self::default()
    }

    /// 初始化应用句柄
    pub fn init(&self, app_handle: AppHandle) {
        *self.app_handle.write() = Some(app_handle);
    }

    /// 获取当前运行模式
    pub fn get_running_mode(&self) -> RunningMode {
        *self.running_mode.read()
    }

    /// 获取当前状态
    pub fn get_state(&self) -> CoreState {
        let mode = *self.running_mode.read();
        CoreState {
            running_mode: mode,
            is_running: mode != RunningMode::NotRunning,
            mixed_port: *self.mixed_port.read(),
            socks_port: None,
            http_port: *self.mixed_port.read(),
            controller: self.controller.read().clone(),
            secret: self.secret.read().clone(),
        }
    }

    /// 启动内核 (Sidecar 模式)
    pub async fn start_core(&self) -> Result<()> {
        let _lock = self.lifecycle_lock.lock().await;

        if *self.running_mode.read() != RunningMode::NotRunning {
            log::info!("[Clash] 内核已在运行中");
            return Ok(());
        }

        let app_handle = self.app_handle.read().clone();
        let app_handle = app_handle.ok_or_else(|| anyhow::anyhow!("应用句柄未初始化"))?;

        log::info!("[Clash] 启动 Mihomo 内核...");

        // 解析当前选中的 Profile 路径
        let pm = crate::clash::config::profile::ProfileManager::global();
        let mut profile_item = pm.get_current();
        if profile_item.is_none() {
            // 兜底：无选中时自动选中列表中的第一个 Profile
            let first = pm.get_profiles().into_iter().next();
            if let Some(item) = first {
                let uid = item.uid.clone();
                let _ = pm.select_profile(&uid);
                profile_item = Some(item);
                log::info!("[Clash] 无选中订阅，已自动选中: {}", uid);
            }
        }
        let profile_path = profile_item
            .as_ref()
            .and_then(|item| item.file.as_ref())
            .map(PathBuf::from);

        // 数据目录 = app_data_dir / "clash"
        let data_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| anyhow::anyhow!("读取应用数据目录失败: {}", e))?
            .join("clash");
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| anyhow::anyhow!("创建数据目录失败: {}", e))?;

        // 选择可用端口，避免订阅残留 7890/9090 或与系统已占用端口冲突导致内核启动失败
        let mixed_port = crate::clash::utils::find_available_port(7890);
        let controller_port = crate::clash::utils::find_available_port(9090);
        let external_controller = format!("127.0.0.1:{}", controller_port);

        // 生成运行时 config.yaml
        let mut params = RuntimeConfigParams::default(data_dir.clone());
        params.profile_path = profile_path;
        params.mixed_port = mixed_port;
        params.external_controller = external_controller.clone();
        let _config_path = build_runtime_config(&params)
            .map_err(|e| anyhow::anyhow!("生成运行时配置失败: {}", e))?;

        // 记录控制器信息，供 API 客户端使用
        *self.data_dir.write() = Some(data_dir.clone());
        *self.controller.write() = Some(params.external_controller.clone());
        *self.secret.write() = Some(params.secret.clone());
        *self.mixed_port.write() = Some(params.mixed_port);

        // 使用 sidecar 方式运行 mihomo，并通过 -d 指定数据目录
        let sidecar = app_handle
            .shell()
            .sidecar("mihomo")
            .map_err(|e| anyhow::anyhow!("创建 sidecar 失败: {}", e))?
            .args(["-d", &data_dir.to_string_lossy()]);

        let (mut rx, child) = sidecar
            .spawn()
            .map_err(|e| anyhow::anyhow!("启动 sidecar 失败: {}", e))?;

        // 每次成功 spawn 一个新内核，代号自增；后台线程捕获此代号，
        // 用于在 Terminated 事件到来时判断"是不是当前这个 child"在退出。
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        *self.child_sidecar.write() = Some(child);
        *self.running_mode.write() = RunningMode::Sidecar;

        // 在后台监听内核输出
        tokio::spawn(async move {
            use tauri_plugin_shell::process::CommandEvent;
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        log::debug!("[Mihomo stdout] {}", String::from_utf8_lossy(&line));
                    }
                    CommandEvent::Stderr(line) => {
                        log::debug!("[Mihomo stderr] {}", String::from_utf8_lossy(&line));
                    }
                    CommandEvent::Error(err) => {
                        log::error!("[Mihomo error] {}", err);
                    }
                    CommandEvent::Terminated(payload) => {
                        log::warn!("[Mihomo] 进程退出: code={:?}, signal={:?}",
                            payload.code, payload.signal);
                        let mgr = CoreManager::global();
                        // 代号守卫：若退出的是旧代 child（已被随后的 start_core 覆盖），
                        // 不要重置状态——否则会把"刚刚启动的新内核"误判为未运行。
                        let cur = mgr.generation.load(Ordering::SeqCst);
                        if cur != gen {
                            log::info!(
                                "[Mihomo] 忽略旧代 child 退出事件 (gen={} cur={})",
                                gen, cur
                            );
                            continue;
                        }
                        // 自动重置内核状态
                        *mgr.child_sidecar.write() = None;
                        *mgr.running_mode.write() = RunningMode::NotRunning;
                        *mgr.controller.write() = None;
                        *mgr.secret.write() = None;
                        *mgr.mixed_port.write() = None;
                        // 内核异常退出时同步关闭系统代理，避免遗留指向已死端口的
                        // 无效代理导致用户全网不通（mihomo-demo 退出清理的同款逻辑）。
                        if let Err(e) = Sysopt::global().reset_sysproxy() {
                            log::warn!("[SysProxy] 内核退出后清理系统代理失败: {}", e);
                        }
                    }
                    _ => {}
                }
            }
        });

        // 等待控制器就绪 (轮询健康检查地址)
        let controller = params.external_controller.clone();
        let secret = params.secret.clone();
        let ready = wait_controller_ready(&controller, &secret, Duration::from_secs(5)).await;
        if !ready {
            log::warn!("[Clash] external-controller 5s 内未就绪，继续启动流程（内核可能仍在初始化）");
        } else {
            log::info!("[Clash] external-controller 已就绪: {}", controller);
        }

        log::info!("[Clash] Mihomo 内核启动成功 (Sidecar 模式)");
        Ok(())
    }

    /// 停止内核
    pub async fn stop_core(&self) -> Result<()> {
        let _lock = self.lifecycle_lock.lock().await;

        let mode = *self.running_mode.read();
        if mode == RunningMode::NotRunning {
            log::info!("[Clash] 内核未运行");
            return Ok(());
        }

        log::info!("[Clash] 停止 Mihomo 内核...");

        if let Some(child) = self.child_sidecar.write().take() {
            let _ = child.kill();
        }

        *self.running_mode.write() = RunningMode::NotRunning;
        *self.controller.write() = None;
        *self.secret.write() = None;
        *self.mixed_port.write() = None;
        log::info!("[Clash] Mihomo 内核已停止");

        // 与 mihomo-demo 的退出清理一致：停止内核时同步关闭系统代理，
        // 避免留下一副指向已死 mixed_port 的无效代理。这条后端兜底覆盖了
        // 所有非 UI 入口（崩溃、外部 kill、删订阅自动重启等），前端在
        // toggleCore 中也做了同样的事，重复调用是幂等的。
        if let Err(e) = Sysopt::global().reset_sysproxy() {
            log::warn!("[SysProxy] 停止内核后清理系统代理失败: {}", e);
        }
        Ok(())
    }

    /// 退出进程时的同步清理：直接 kill 当前 child 并重置系统代理。
    ///
    /// 不走 async lifecycle_lock——此时 tokio runtime 可能已经停止，无法 await。
    /// 仅供 `RunEvent::Exit` 钩子调用。
    pub fn force_cleanup_sync(&self) {
        if let Some(child) = self.child_sidecar.write().take() {
            let _ = child.kill();
            log::info!("[Clash] 退出清理：已 kill mihomo 子进程");
        }
        *self.running_mode.write() = RunningMode::NotRunning;
        *self.controller.write() = None;
        *self.secret.write() = None;
        *self.mixed_port.write() = None;
        if let Err(e) = Sysopt::global().reset_sysproxy() {
            log::warn!("[SysProxy] 退出清理系统代理失败: {}", e);
        }
    }

    /// 重启内核
    ///
    /// 仅"内核重启"不会重新打开系统代理——因为 stop_core 会把系统代理关掉，
    /// 这是问题 3 的安全保证（避免新 mixed_port 与注册表里旧端口失配）。
    /// 但用户视角的"重启"通常希望系统代理继续生效，因此这里在重启前先
    /// 记下系统代理原本是否启用，重启成功后用 **新** 的 mixed_port 重新打
    /// 开它，保证 UI 体验不变且端口始终一致。
    pub async fn restart_core(&self) -> Result<()> {
        log::info!("[Clash] 重启 Mihomo 内核...");
        let was_sysproxy_on = Sysopt::global().get_sysproxy().enable;
        self.stop_core().await?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        self.start_core().await?;
        if was_sysproxy_on {
            if let Some(port) = *self.mixed_port.read() {
                let new_cfg = SysproxyConfig {
                    enable: true,
                    host: "127.0.0.1".to_string(),
                    port,
                    bypass: SysproxyConfig::default().bypass,
                };
                if let Err(e) = Sysopt::global().set_sysproxy(new_cfg) {
                    log::warn!("[SysProxy] 重启后恢复系统代理失败: {}", e);
                } else {
                    log::info!("[SysProxy] 内核重启后已用新端口 {} 恢复系统代理", port);
                }
            }
        }
        Ok(())
    }

    /// 获取控制器地址（供 API 客户端使用）
    pub fn controller(&self) -> Option<String> {
        self.controller.read().clone()
    }

    /// 获取控制器密钥
    pub fn secret(&self) -> Option<String> {
        self.secret.read().clone()
    }
}

/// 轮询等待 mihomo external-controller 就绪
async fn wait_controller_ready(controller: &str, secret: &str, timeout: Duration) -> bool {
    let url = format!("http://{}/version", controller);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        let mut req = client.get(&url);
        if !secret.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", secret));
        }
        if let Ok(resp) = req.send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    false
}

// 全局单例
use std::sync::OnceLock;
static CORE_MANAGER: OnceLock<CoreManager> = OnceLock::new();

impl CoreManager {
    pub fn global() -> &'static CoreManager {
        CORE_MANAGER.get_or_init(CoreManager::new)
    }
}
