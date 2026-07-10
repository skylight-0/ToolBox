//! Clash Tauri 命令
//! 
//! 暴露给前端的 IPC 命令

use crate::clash::{
    config::ClashInfo,
    config::profile::{ProfileManager, PrfItem},
    core::manager::{CoreManager, RunningMode},
    core::sysopt::{Sysopt, SysproxyConfig},
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// ==================== 内核管理 ====================

/// 启动内核
#[tauri::command]
pub async fn clash_start_core(app: AppHandle) -> Result<(), String> {
    log::info!("[Clash] clash_start_core 被调用");
    CoreManager::global().init(app);
    CoreManager::global().start_core().await
        .map_err(|e| {
            let msg = format!("启动内核失败: {}", e);
            log::error!("[Clash] {}", msg);
            msg
        })
}

/// 停止内核
#[tauri::command]
pub async fn clash_stop_core() -> Result<(), String> {
    log::info!("[Clash] clash_stop_core 被调用，当前模式={}", CoreManager::global().get_running_mode());
    CoreManager::global().stop_core().await
        .map_err(|e| {
            let msg = format!("停止内核失败: {}", e);
            log::error!("[Clash] {}", msg);
            msg
        })
}

/// 重启内核
#[tauri::command]
pub async fn clash_restart_core(app: AppHandle) -> Result<(), String> {
    CoreManager::global().init(app);
    CoreManager::global().restart_core().await
        .map_err(|e| format!("重启内核失败: {}", e))
}

/// 获取运行模式
#[tauri::command]
pub fn clash_get_running_mode() -> RunningMode {
    CoreManager::global().get_running_mode()
}

/// 获取 Clash 信息
#[tauri::command]
pub fn clash_get_info() -> ClashInfo {
    let state = CoreManager::global().get_state();
    ClashInfo {
        is_running: state.is_running,
        running_mode: state.running_mode.to_string(),
        mixed_port: state.mixed_port,
        http_port: state.http_port,
        socks_port: state.socks_port,
        controller: state.controller,
        secret: state.secret,
    }
}

// ==================== 系统代理 ====================

/// 获取系统代理配置
#[tauri::command]
pub fn clash_get_sysproxy() -> SysproxyConfig {
    Sysopt::global().get_sysproxy()
}

/// 设置系统代理
#[tauri::command]
pub fn clash_set_sysproxy(config: SysproxyConfig) -> Result<(), String> {
    Sysopt::global().set_sysproxy(config)
        .map_err(|e| format!("设置系统代理失败: {}", e))
}

/// 重置系统代理
#[tauri::command]
pub fn clash_reset_sysproxy() -> Result<(), String> {
    Sysopt::global().reset_sysproxy()
        .map_err(|e| format!("重置系统代理失败: {}", e))
}

// ==================== Profile 管理 ====================

/// 获取所有 Profile
#[tauri::command]
pub fn clash_get_profiles() -> Vec<PrfItem> {
    ProfileManager::global().get_profiles()
}

/// 导入远程订阅
#[tauri::command]
pub async fn clash_import_profile(url: String, name: Option<String>) -> Result<PrfItem, String> {
    ProfileManager::global().import_remote(&url, name.as_deref()).await
        .map_err(|e| format!("导入订阅失败: {}", e))
}

/// 删除 Profile (若删除的是当前选中且内核在运行，则自动重启内核以应用回退)
#[tauri::command]
pub async fn clash_delete_profile(app: AppHandle, uid: String) -> Result<(), String> {
    let pm = ProfileManager::global();
    let was_current = pm
        .get_current()
        .as_ref()
        .map(|p| p.uid == uid)
        .unwrap_or(false);
    pm.delete_profile(&uid).map_err(|e| format!("删除配置失败: {}", e))?;

    // 若删除的是当前选中订阅且内核正在运行，重启内核以应用“无选中→自动选中首个”回退逻辑，
    // 避免 UI 与内核实际配置脱节
    if was_current && CoreManager::global().get_running_mode() != RunningMode::NotRunning {
        CoreManager::global().init(app);
        if let Err(e) = CoreManager::global().restart_core().await {
            log::warn!("[Clash] 删除当前订阅后重启内核失败: {}", e);
        }
    }
    Ok(())
}

/// 选中 Profile
#[tauri::command]
pub fn clash_select_profile(uid: String) -> Result<(), String> {
    ProfileManager::global().select_profile(&uid)
        .map_err(|e| format!("选择配置失败: {}", e))
}

/// 更新远程订阅
#[tauri::command]
pub async fn clash_update_profile(uid: String) -> Result<(), String> {
    ProfileManager::global().update_remote(&uid).await
        .map_err(|e| format!("更新订阅失败: {}", e))
}

// ==================== 延迟测试 ====================

/// 延迟测试结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelayResult {
    pub url: String,
    pub delay: Option<u64>,
    pub error: Option<String>,
}

/// 测试单个代理节点的延迟（通过 mihomo API /proxies/:name/delay）
#[tauri::command]
pub async fn clash_test_proxy_delay(
    proxy: String,
    test_url: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<DelayResult, String> {
    let (Some(controller), Some(secret)) = (
        CoreManager::global().controller(),
        CoreManager::global().secret(),
    ) else {
        return Ok(DelayResult {
            url: test_url.unwrap_or_default(),
            delay: None,
            error: Some("内核未运行".to_string()),
        });
    };

    let url = test_url.unwrap_or_else(|| "https://www.gstatic.com/generate_204".to_string());
    let timeout = timeout_ms.unwrap_or(5000);
    let endpoint = format!(
        "http://{}/proxies/{}/delay?url={}&timeout={}",
        controller,
        urlencode(&proxy),
        urlencode(&url),
        timeout
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout + 1000))
        .no_proxy()
        .build()
        .map_err(|e| format!("创建客户端失败: {}", e))?;

    let start = std::time::Instant::now();
    let req = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {}", secret));

    match req.send().await {
        Ok(resp) => {
            if resp.status().is_success() {
                #[derive(Deserialize)]
                struct DelayResp {
                    delay: Option<u64>,
                }
                let raw = start.elapsed().as_millis() as u64;
                let body = resp.text().await.unwrap_or_default();
                let parsed: DelayResp = serde_json::from_str(&body).unwrap_or(DelayResp { delay: None });
                Ok(DelayResult {
                    url: url.clone(),
                    delay: parsed.delay.or(Some(raw)),
                    error: None,
                })
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                let msg = parse_delay_error(&body).unwrap_or_else(|| format!("HTTP {}", status));
                Ok(DelayResult {
                    url: url.clone(),
                    delay: None,
                    error: Some(msg),
                })
            }
        }
        Err(e) => Ok(DelayResult {
            url: url.clone(),
            delay: None,
            error: Some(e.to_string()),
        }),
    }
}

/// 测试整组所有节点延迟（通过 mihomo API /group/:name/delay）
/// 返回每个节点的延迟（毫秒），0 或缺失表示不可达（转为 None）
#[tauri::command]
pub async fn clash_test_group_delay(
    group: String,
    test_url: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<std::collections::HashMap<String, Option<u64>>, String> {
    let (Some(controller), Some(secret)) = (
        CoreManager::global().controller(),
        CoreManager::global().secret(),
    ) else {
        return Ok(std::collections::HashMap::new());
    };

    let url = test_url.unwrap_or_else(|| "https://www.gstatic.com/generate_204".to_string());
    let timeout = timeout_ms.unwrap_or(5000);
    let endpoint = format!(
        "http://{}/group/{}/delay?url={}&timeout={}",
        controller,
        urlencode(&group),
        urlencode(&url),
        timeout
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout + 1000))
        .no_proxy()
        .build()
        .map_err(|e| format!("创建客户端失败: {}", e))?;

    let resp = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {}", secret))
        .send()
        .await
        .map_err(|e| format!("请求组测速失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let msg = parse_delay_error(&body).unwrap_or_else(|| format!("HTTP {}", status));
        return Err(format!("组测速失败: {}", msg));
    }

    // mihomo 返回 {"节点名": delay_number_or_0}，宽松解析以兼容 null/缺失
    let raw: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析组测速响应失败: {}", e))?;

    let mut out = std::collections::HashMap::new();
    if let Some(obj) = raw.as_object() {
        for (name, val) in obj {
            let delay = val.as_u64().filter(|&d| d > 0);
            out.insert(name.clone(), delay);
        }
    }
    Ok(out)
}

fn parse_delay_error(body: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct DelayErrResp {
        message: Option<String>,
    }
    serde_json::from_str::<DelayErrResp>(body)
        .ok()
        .and_then(|d| d.message)
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ==================== 配置管理 ====================

/// 代理组信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyGroupInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub group_type: String,
    pub proxies: Vec<String>,
    pub now: Option<String>,
}

/// 获取代理组列表
#[tauri::command]
pub async fn clash_get_proxy_groups() -> Result<Vec<ProxyGroupInfo>, String> {
    let (Some(controller), Some(secret)) = (
        CoreManager::global().controller(),
        CoreManager::global().secret(),
    ) else {
        // 内核未运行时返回空列表，前端会提示
        return Ok(Vec::new());
    };

    #[derive(Deserialize)]
    struct ProxiesResp {
        proxies: std::collections::HashMap<String, ProxyEntry>,
    }
    #[derive(Deserialize)]
    struct ProxyEntry {
        #[serde(rename = "type")]
        item_type: String,
        now: Option<String>,
        all: Option<Vec<String>>,
    }

    let endpoint = format!("http://{}/proxies", controller);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(2000))
        .no_proxy()
        .build()
        .map_err(|e| format!("创建客户端失败: {}", e))?;
    let resp = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {}", secret))
        .send()
        .await
        .map_err(|e| format!("请求代理组失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("mihomo API 返回错误: {}", resp.status()));
    }

    let parsed: ProxiesResp = resp
        .json()
        .await
        .map_err(|e| format!("解析代理组响应失败: {}", e))?;

    // 只返回代理组 (Selector / URLTest / Fallback / LoadBalance / Relay)
    const GROUP_TYPES: &[&str] = &["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"];
    let mut groups = Vec::new();
    for (name, entry) in parsed.proxies.iter() {
        if !GROUP_TYPES.contains(&entry.item_type.as_str()) {
            continue;
        }
        groups.push(ProxyGroupInfo {
            name: name.clone(),
            group_type: entry.item_type.clone(),
            proxies: entry.all.clone().unwrap_or_default(),
            now: entry.now.clone(),
        });
    }
    // 按名称稳定排序，避免每次刷新顺序抖动
    groups.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(groups)
}

/// 选择代理
#[tauri::command]
pub async fn clash_select_proxy(group: String, proxy: String) -> Result<(), String> {
    let (Some(controller), Some(secret)) = (
        CoreManager::global().controller(),
        CoreManager::global().secret(),
    ) else {
        return Err("内核未运行".to_string());
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(2000))
        .no_proxy()
        .build()
        .map_err(|e| format!("创建客户端失败: {}", e))?;

    // 先查询该组的类型，仅 Selector 组支持手动选择，避免对 URLTest/Fallback 等返回 4xx
    let info_endpoint = format!("http://{}/proxies/{}", controller, urlencode(&group));
    let info_resp = client
        .get(&info_endpoint)
        .header("Authorization", format!("Bearer {}", secret))
        .send()
        .await
        .map_err(|e| format!("查询代理组失败: {}", e))?;
    if !info_resp.status().is_success() {
        return Err(format!("代理组 {} 不存在", group));
    }
    #[derive(Deserialize)]
    struct GroupInfoResp {
        #[serde(rename = "type")]
        group_type: String,
    }
    let info: GroupInfoResp = info_resp
        .json()
        .await
        .map_err(|e| format!("解析代理组失败: {}", e))?;
    if info.group_type != "Selector" {
        return Err(format!(
            "代理组 {} 类型为 {}，仅 Selector 组支持手动切换",
            group, info.group_type
        ));
    }

    let endpoint = info_endpoint;

    let payload = serde_json::json!({ "name": proxy });
    let resp = client
        .put(&endpoint)
        .header("Authorization", format!("Bearer {}", secret))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("切换代理失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("切换代理失败: {} ({})", status, body));
    }
    log::info!("[Clash] 已切换代理组 {} -> {}", group, proxy);
    Ok(())
}
