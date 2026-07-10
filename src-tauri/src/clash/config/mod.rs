//! Clash 配置管理模块
//! 
//! 提供配置文件管理、运行时配置等功能

pub mod profile;
pub mod runtime;

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// Clash 配置结构
///
/// 注意：当前 ToolBox 的运行时配置注入直接通过 `serde_yaml_ng::Value` 操作订阅文件，
/// 不经此结构体。保留它作为后续强类型解析的占位，故整体 `allow(dead_code)`。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub struct ClashConfig {
    /// Mixed 端口 (HTTP + SOCKS5)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mixed_port: Option<u16>,
    /// HTTP 代理端口
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// SOCKS5 代理端口
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socks_port: Option<u16>,
    /// 控制端口
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_controller: Option<String>,
    /// API 密钥
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// 运行模式 (rule/global/direct)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// 日志级别
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    /// 代理组
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_groups: Option<Vec<ProxyGroup>>,
    /// 代理节点
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxies: Option<Vec<Proxy>>,
    /// 规则
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<String>>,
    /// DNS 配置
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dns: Option<DnsConfig>,
}

/// 代理组
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub struct ProxyGroup {
    pub name: String,
    #[serde(rename = "type")]
    pub group_type: String,
    pub proxies: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tolerance: Option<u32>,
}

/// 代理节点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub struct Proxy {
    pub name: String,
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub server: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alter_id: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cipher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// DNS 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub struct DnsConfig {
    pub enable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enhanced_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nameserver: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<Vec<String>>,
}

/// Clash 运行时信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClashInfo {
    /// 是否正在运行
    pub is_running: bool,
    /// 运行模式
    pub running_mode: String,
    /// Mixed 端口
    pub mixed_port: Option<u16>,
    /// HTTP 端口
    pub http_port: Option<u16>,
    /// SOCKS 端口
    pub socks_port: Option<u16>,
    /// 控制器地址
    pub controller: Option<String>,
    /// API 密钥
    pub secret: Option<String>,
}
