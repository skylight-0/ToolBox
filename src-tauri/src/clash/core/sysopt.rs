//! 系统代理设置模块
//! 
//! 负责设置、取消、守卫系统代理

use anyhow::Result;
use parking_lot::RwLock;


/// 系统代理配置
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SysproxyConfig {
    pub enable: bool,
    pub host: String,
    pub port: u16,
    pub bypass: String,
}

impl Default for SysproxyConfig {
    fn default() -> Self {
        Self {
            enable: false,
            host: "127.0.0.1".to_string(),
            port: 7890,
            bypass: DEFAULT_BYPASS.to_string(),
        }
    }
}

#[cfg(target_os = "windows")]
static DEFAULT_BYPASS: &str = "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>";

#[cfg(target_os = "linux")]
static DEFAULT_BYPASS: &str = "localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,::1";

#[cfg(target_os = "macos")]
static DEFAULT_BYPASS: &str = "127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,localhost,*.local,*.crashlytics.com,<local>";

/// 系统代理管理器
pub struct Sysopt {
    /// 当前系统代理配置
    sysproxy: RwLock<SysproxyConfig>,
}

impl Default for Sysopt {
    fn default() -> Self {
        Self {
            sysproxy: RwLock::new(SysproxyConfig::default()),
        }
    }
}

impl Sysopt {
    fn new() -> Self {
        Self::default()
    }

    /// 获取当前系统代理配置
    pub fn get_sysproxy(&self) -> SysproxyConfig {
        #[cfg(target_os = "windows")]
        {
            // 同步读取注册表，避免重启后内存默认值与系统状态不同步
            if let Some(read) = read_windows_sysproxy() {
                *self.sysproxy.write() = read.clone();
                return read;
            }
        }
        self.sysproxy.read().clone()
    }

    /// 设置系统代理
    pub fn set_sysproxy(&self, config: SysproxyConfig) -> Result<()> {
        log::info!("[SysProxy] 设置系统代理: enable={}, host={}, port={}", 
            config.enable, config.host, config.port);

        #[cfg(target_os = "windows")]
        {
            self.set_windows_sysproxy(&config)?;
        }

        #[cfg(target_os = "macos")]
        {
            self.set_macos_sysproxy(&config)?;
        }

        #[cfg(target_os = "linux")]
        {
            self.set_linux_sysproxy(&config)?;
        }

        *self.sysproxy.write() = config;
        Ok(())
    }

    /// 重置系统代理 (关闭代理)
    pub fn reset_sysproxy(&self) -> Result<()> {
        log::info!("[SysProxy] 重置系统代理");
        
        let mut config = self.sysproxy.read().clone();
        config.enable = false;
        self.set_sysproxy(config)
    }

    #[cfg(target_os = "windows")]
    fn refresh_windows_proxy(&self) -> Result<()> {
        use windows_sys::Win32::Networking::WinInet::{
            InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            HWND_BROADCAST, SendMessageTimeoutW, SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_SETTINGCHANGE,
        };

        unsafe {
            // 通知 WinINet 注册表已变更，使其立即重新读取设置
            let _ = InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null(), 0);
            let _ = InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_REFRESH, std::ptr::null(), 0);
            // 通知顶层窗口刷新环境。改用 SendMessageTimeoutW（带 SMTO_ABORTIFHUNG），
            // 避免被某个挂起/无响应窗口的窗口过程同步阻塞，导致调用方主线程卡死 UI 未响应。
            let mut result: usize = 0;
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                0,
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                1000,
                &mut result,
            );
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn set_windows_sysproxy(&self, config: &SysproxyConfig) -> Result<()> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let settings = hkcu
            .open_subkey_with_flags(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                KEY_SET_VALUE,
            )
            .map_err(|e| anyhow::anyhow!("打开注册表失败: {}", e))?;

        if config.enable {
            // 启用代理
            settings
                .set_value("ProxyEnable", &1u32)
                .map_err(|e| anyhow::anyhow!("设置 ProxyEnable 失败: {}", e))?;
            settings
                .set_value("ProxyServer", &format!("{}:{}", config.host, config.port))
                .map_err(|e| anyhow::anyhow!("设置 ProxyServer 失败: {}", e))?;
            settings
                .set_value("ProxyOverride", &config.bypass)
                .map_err(|e| anyhow::anyhow!("设置 ProxyOverride 失败: {}", e))?;
        } else {
            // 禁用代理（仅切换 ProxyEnable，保留 ProxyServer/Override 以便下次开启时复用）
            settings
                .set_value("ProxyEnable", &0u32)
                .map_err(|e| anyhow::anyhow!("设置 ProxyEnable 失败: {}", e))?;
        }

        // 刷新系统代理设置
        self.refresh_windows_proxy()?;

        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn set_macos_sysproxy(&self, config: &SysproxyConfig) -> Result<()> {
        use std::process::Command;

        // macOS 使用 networksetup 命令设置代理
        let network_services = Command::new("networksetup")
            .args(["-listallnetworkservices"])
            .output()
            .map_err(|e| anyhow::anyhow!("获取网络服务列表失败: {}", e))?;

        let output = String::from_utf8_lossy(&network_services.stdout);
        for line in output.lines().skip(1) { // 跳过第一行标题
            let service = line.trim();
            if service.is_empty() || service.starts_with('*') {
                continue;
            }

            if config.enable {
                // 设置 HTTP 代理
                let _ = Command::new("networksetup")
                    .args(["-setwebproxy", service, &config.host, &config.port.to_string()])
                    .output();

                // 设置 HTTPS 代理
                let _ = Command::new("networksetup")
                    .args(["-setsecurewebproxy", service, &config.host, &config.port.to_string()])
                    .output();

                // 设置 SOCKS 代理
                let _ = Command::new("networksetup")
                    .args(["-setsocksfirewallproxy", service, &config.host, &config.port.to_string()])
                    .output();

                // 启用代理
                let _ = Command::new("networksetup")
                    .args(["-setwebproxystate", service, "on"])
                    .output();
                let _ = Command::new("networksetup")
                    .args(["-setsecurewebproxystate", service, "on"])
                    .output();
                let _ = Command::new("networksetup")
                    .args(["-setsocksfirewallproxystate", service, "on"])
                    .output();
            } else {
                // 禁用代理
                let _ = Command::new("networksetup")
                    .args(["-setwebproxystate", service, "off"])
                    .output();
                let _ = Command::new("networksetup")
                    .args(["-setsecurewebproxystate", service, "off"])
                    .output();
                let _ = Command::new("networksetup")
                    .args(["-setsocksfirewallproxystate", service, "off"])
                    .output();
            }
        }

        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn set_linux_sysproxy(&self, config: &SysproxyConfig) -> Result<()> {
        // Linux 代理设置通常通过环境变量或桌面环境特定的配置
        // 这里提供一个基本实现，实际可能需要根据不同桌面环境调整
        
        if config.enable {
            std::env::set_var("http_proxy", format!("http://{}:{}", config.host, config.port));
            std::env::set_var("https_proxy", format!("http://{}:{}", config.host, config.port));
            std::env::set_var("all_proxy", format!("socks5://{}:{}", config.host, config.port));
            std::env::set_var("no_proxy", &config.bypass);
        } else {
            std::env::remove_var("http_proxy");
            std::env::remove_var("https_proxy");
            std::env::remove_var("all_proxy");
            std::env::remove_var("no_proxy");
        }

        Ok(())
    }
}

// 全局单例
use std::sync::OnceLock;
static SYSOPT: OnceLock<Sysopt> = OnceLock::new();

impl Sysopt {
    pub fn global() -> &'static Sysopt {
        SYSOPT.get_or_init(Sysopt::new)
    }
}

/// 读取 Windows 注册表中的当前系统代理配置 (用于跨会话同步内存状态)
#[cfg(target_os = "windows")]
fn read_windows_sysproxy() -> Option<SysproxyConfig> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu
        .open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
            KEY_QUERY_VALUE,
        )
        .ok()?;

    let enable: u32 = settings.get_value("ProxyEnable").unwrap_or(0);
    let proxy_server: String = settings.get_value("ProxyServer").unwrap_or_default();
    let bypass: String = settings.get_value("ProxyOverride").unwrap_or_default();

    let (host, port) = parse_proxy_server(&proxy_server);
    let port = port.unwrap_or(SysproxyConfig::default().port);

    Some(SysproxyConfig {
        enable: enable != 0,
        host,
        port,
        bypass,
    })
}

/// 解析 ProxyServer 字符串
/// 支持 "host:port" 或 "scheme=host:port;scheme=host:port" 等形式
#[cfg(target_os = "windows")]
fn parse_proxy_server(raw: &str) -> (String, Option<u16>) {
    let raw = raw.trim();
    if raw.is_empty() {
        return ("127.0.0.1".to_string(), None);
    }

    // 多协议形式 "http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891"
    if raw.contains('=') || raw.contains(';') {
        for part in raw.split(';') {
            let part = part.trim();
            if let Some(rest) = part
                .strip_prefix("http=")
                .or_else(|| part.strip_prefix("https="))
                .or_else(|| part.strip_prefix("socks="))
                .or_else(|| part.strip_prefix("all="))
            {
                if let Some((h, p)) = rest.rsplit_once(':') {
                    if let Ok(port) = p.parse::<u16>() {
                        return (h.to_string(), Some(port));
                    }
                }
            } else if let Some((h, p)) = part.rsplit_once(':') {
                if let Ok(port) = p.parse::<u16>() {
                    return (h.to_string(), Some(port));
                }
            }
        }
        return ("127.0.0.1".to_string(), None);
    }

    // 单一 "host:port" 形式
    if let Some((h, p)) = raw.rsplit_once(':') {
        if let Ok(port) = p.parse::<u16>() {
            return (h.to_string(), Some(port));
        }
    }
    (raw.to_string(), None)
}
