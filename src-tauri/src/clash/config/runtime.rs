//! 运行时配置生成
//!
//! 在启动 Mihomo 内核前，根据当前选中的 Profile 文件 + ToolBox 的基础配置
//! （external-controller / secret / mixed-port 等），生成 mihomo 可加载的运行时
//! `config.yaml` 并写入运行时数据目录。

use anyhow::{Context, Result};
use serde_yaml_ng::Value;
use std::path::PathBuf;

/// 运行时配置参数
pub struct RuntimeConfigParams {
    /// Profile 文件的实际路径 (YAML)
    pub profile_path: Option<PathBuf>,
    /// Clash 工作目录 (mihomo -d 参数)
    pub data_dir: PathBuf,
    /// Mixed 端口
    pub mixed_port: u16,
    /// External Controller 监听地址 (127.0.0.1:9090)
    pub external_controller: String,
    /// External Controller 密钥
    pub secret: String,
}

impl RuntimeConfigParams {
    /// 默认参数
    pub fn default(data_dir: PathBuf) -> Self {
        Self {
            profile_path: None,
            data_dir,
            mixed_port: 7890,
            external_controller: "127.0.0.1:9090".to_string(),
            secret: nanoid::nanoid!(16),
        }
    }
}

/// 构建运行时 config.yaml 并写入 data_dir/config.yaml
///
/// 覆盖优先级：ToolBox 基础配置 > Profile YAML（用户原始配置）
/// 注意：external-controller / secret / mixed-port 由 ToolBox 统一管理，
/// Profile 中的同名键会被覆盖，避免订阅自带配置导致无法与本程序对接。
pub fn build_runtime_config(params: &RuntimeConfigParams) -> Result<PathBuf> {
    let mut root: Value = if let Some(ref path) = params.profile_path {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("读取 Profile 失败: {}", path.display()))?;
        match serde_yaml_ng::from_str::<Value>(&content) {
            Ok(v) => v,
            Err(_) => Value::Mapping(serde_yaml_ng::Mapping::new()),
        }
    } else {
        Value::Mapping(serde_yaml_ng::Mapping::new())
    };

    // 确保是 mappings，否则无法注入键
    if !root.is_mapping() {
        anyhow::bail!("Profile 顶层不是 YAML mapping，无法注入运行时配置");
    }
    let mapping = root.as_mapping_mut().unwrap();

    // 注入 ToolBox 统一管理的基础配置
    mapping.insert(
        Value::String("mixed-port".into()),
        Value::Number(params.mixed_port.into()),
    );
    mapping.insert(
        Value::String("external-controller".into()),
        Value::String(params.external_controller.clone()),
    );
    mapping.insert(
        Value::String("secret".into()),
        Value::String(params.secret.clone()),
    );
    // 允许外部程序与 LAN 设备使用 API（按需）
    mapping.insert(
        Value::String("allow-lan".into()),
        Value::Bool(false),
    );
    // 默认日志级别
    if !mapping.contains_key(&Value::String("log-level".into())) {
        mapping.insert(
            Value::String("log-level".into()),
            Value::String("info".into()),
        );
    }

    // 写入 data_dir/config.yaml
    if !params.data_dir.exists() {
        std::fs::create_dir_all(&params.data_dir)
            .with_context(|| format!("创建数据目录失败: {}", params.data_dir.display()))?;
    }
    let config_path = params.data_dir.join("config.yaml");
    let yaml_text = serde_yaml_ng::to_string(&root)
        .context("序列化运行时配置失败")?;
    std::fs::write(&config_path, yaml_text)
        .with_context(|| format!("写入 config.yaml 失败: {}", config_path.display()))?;

    Ok(config_path)
}