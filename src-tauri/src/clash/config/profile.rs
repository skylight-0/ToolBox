//! Profile 配置文件管理
//! 
//! 管理订阅、本地配置文件等

use anyhow::Result;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, SystemTime},
};
use tauri::AppHandle;

/// 生成 nanoid
fn generate_uid() -> String {
    nanoid::nanoid!(8)
}

/// Profile 类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrfType {
    /// 远程订阅
    Remote,
    /// 本地文件
    Local,
}

impl Default for PrfType {
    fn default() -> Self {
        Self::Local
    }
}

/// Profile 配置项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrfItem {
    /// 唯一标识
    pub uid: String,
    /// Profile 类型
    #[serde(rename = "type")]
    pub item_type: PrfType,
    /// 名称
    pub name: String,
    /// 描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    /// 文件路径 (本地) 或 URL (远程)
    pub file: Option<String>,
    /// URL (远程订阅)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 更新间隔 (秒)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u64>,
    /// 上次更新时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<u64>,
    /// 是否选中
    pub selected: bool,
    /// 额外信息
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

impl PrfItem {
    /// 创建新的远程订阅 Profile
    pub fn new_remote(name: &str, url: &str) -> Self {
        Self {
            uid: generate_uid(),
            item_type: PrfType::Remote,
            name: name.to_string(),
            desc: None,
            file: None,
            url: Some(url.to_string()),
            interval: Some(86400), // 默认每天更新
            updated: None,
            selected: false,
            extra: HashMap::new(),
        }
    }
}

/// Profile 管理器
pub struct ProfileManager {
    /// Profile 列表
    profiles: RwLock<Vec<PrfItem>>,
    /// 当前选中的 Profile UID
    current: RwLock<Option<String>>,
    /// 配置文件目录
    config_dir: RwLock<Option<PathBuf>>,
    /// 应用句柄
    app_handle: RwLock<Option<AppHandle>>,
}

impl Default for ProfileManager {
    fn default() -> Self {
        Self {
            profiles: RwLock::new(Vec::new()),
            current: RwLock::new(None),
            config_dir: RwLock::new(None),
            app_handle: RwLock::new(None),
        }
    }
}

impl ProfileManager {
    fn new() -> Self {
        Self::default()
    }

    /// 初始化（从磁盘加载持久化的 Profile 列表）
    pub fn init(&self, app_handle: AppHandle, config_dir: PathBuf) {
        *self.app_handle.write() = Some(app_handle);
        *self.config_dir.write() = Some(config_dir.clone());
        self.load_from_disk();
    }

    /// 持久化 Profile 列表到 profiles.yaml
    fn save_to_disk(&self) {
        let dir = self.config_dir.read();
        let Some(dir) = dir.as_ref() else { return };
        let path = dir.join("profiles.yaml");
        let profiles = self.profiles.read().clone();
        let current = self.current.read().clone();

        #[derive(Serialize)]
        struct ProfilesStore {
            profiles: Vec<PrfItem>,
            current: Option<String>,
        }
        let store = ProfilesStore { profiles, current };
        if let Ok(yaml) = serde_yaml_ng::to_string(&store) {
            if let Err(e) = std::fs::write(&path, yaml) {
                log::warn!("[Profile] 持久化失败: {}", e);
            }
        }
    }

    /// 从 profiles.yaml 加载 Profile 列表
    fn load_from_disk(&self) {
        let dir = self.config_dir.read();
        let Some(dir) = dir.as_ref() else { return };
        let path = dir.join("profiles.yaml");
        if !path.exists() {
            return;
        }
        #[derive(Deserialize)]
        struct ProfilesStore {
            profiles: Vec<PrfItem>,
            current: Option<String>,
        }
        match std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_yaml_ng::from_str::<ProfilesStore>(&s).ok())
        {
            Some(store) => {
                let total = store.profiles.len();
                // 只保留文件仍存在的 Profile，避免引用已删除的 YAML
                let valid: Vec<PrfItem> = store
                    .profiles
                    .into_iter()
                    .filter(|p| {
                        // 远程订阅必须有 file 且文件存在
                        if p.item_type == PrfType::Remote {
                            p.file.as_ref()
                                .map(|f| PathBuf::from(f).exists())
                                .unwrap_or(false)
                        } else {
                            true
                        }
                    })
                    .collect();
                log::info!("[Profile] 从磁盘加载 {} 个 Profile（共 {} 个）", valid.len(), total);
                *self.profiles.write() = valid;
                *self.current.write() = store.current;
            }
            None => {
                log::warn!("[Profile] profiles.yaml 解析失败，已忽略");
            }
        }
    }

    /// 获取所有 Profile
    pub fn get_profiles(&self) -> Vec<PrfItem> {
        self.profiles.read().clone()
    }

    /// 获取当前选中的 Profile
    pub fn get_current(&self) -> Option<PrfItem> {
        let profiles = self.profiles.read();
        let current = self.current.read();
        current.as_ref().and_then(|uid| {
            profiles.iter().find(|p| &p.uid == uid).cloned()
        })
    }

    /// 添加 Profile
    pub fn add_profile(&self, mut item: PrfItem) -> Result<String> {
        if item.uid.is_empty() {
            item.uid = generate_uid();
        }
        let uid = item.uid.clone();
        self.profiles.write().push(item);
        self.save_to_disk();
        Ok(uid)
    }

    /// 更新 Profile
    pub fn update_profile(&self, uid: &str, item: PrfItem) -> Result<()> {
        let mut profiles = self.profiles.write();
        if let Some(index) = profiles.iter().position(|p| p.uid == uid) {
            profiles[index] = item;
            drop(profiles);
            self.save_to_disk();
            Ok(())
        } else {
            Err(anyhow::anyhow!("Profile 不存在: {}", uid))
        }
    }

    /// 删除 Profile (同时清理磁盘上的 yaml 文件)
    pub fn delete_profile(&self, uid: &str) -> Result<()> {
        let mut profiles = self.profiles.write();

        // 先记录被删条目的文件路径，便于清理磁盘上的 yaml 文件
        let removed_item = profiles.iter().find(|p| p.uid == uid).cloned();

        let current = self.current.read();
        if let Some(current_uid) = current.as_ref() {
            if current_uid == uid {
                *self.current.write() = None;
            }
        }
        drop(current);

        profiles.retain(|p| p.uid != uid);
        drop(profiles);

        // 删除对应的磁盘配置文件，避免长期累积垃圾
        if let Some(item) = &removed_item {
            if let Some(file) = &item.file {
                let path = PathBuf::from(file);
                if path.exists() {
                    if let Err(e) = std::fs::remove_file(&path) {
                        log::warn!("[Profile] 删除配置文件失败: {} ({})", file, e);
                    }
                }
            }
        }
        self.save_to_disk();
        Ok(())
    }

    /// 选中 Profile
    pub fn select_profile(&self, uid: &str) -> Result<()> {
        let profiles = self.profiles.read();
        if !profiles.iter().any(|p| p.uid == uid) {
            return Err(anyhow::anyhow!("Profile 不存在: {}", uid));
        }

        // 取消之前的选中
        drop(profiles);
        let mut profiles = self.profiles.write();
        for p in profiles.iter_mut() {
            p.selected = false;
        }

        // 选中新 Profile
        if let Some(p) = profiles.iter_mut().find(|p| p.uid == uid) {
            p.selected = true;
        }

        *self.current.write() = Some(uid.to_string());
        drop(profiles);
        self.save_to_disk();
        Ok(())
    }

    /// 下载远程订阅内容，返回 (内容, 推断名称)
    async fn download_remote(url: &str, name: Option<&str>) -> Result<(String, String)> {
        // 多数订阅服务商要求 Clash UA 才会返回 Clash 格式配置
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?
            .get(url)
            .header("User-Agent", "clash.meta/v1.0")
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("下载配置失败: {}", e))?;

        let content = response
            .text()
            .await
            .map_err(|e| anyhow::anyhow!("读取配置失败: {}", e))?;

        let config_name = name
            .map(|n| n.to_string())
            .or_else(|| {
                // 尝试从 YAML 中解析名称
                if let Ok(yaml) = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&content) {
                    yaml.get("name")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "未命名配置".to_string());

        Ok((content, config_name))
    }

    /// 写入配置文件到 config_dir，返回文件路径字符串
    fn write_profile_file(&self, content: &str) -> Result<String> {
        let dir = self
            .config_dir
            .read()
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("配置目录未初始化"))?
            .clone();
        std::fs::create_dir_all(&dir)
            .map_err(|e| anyhow::anyhow!("创建配置目录失败: {}", e))?;

        let file_name = format!("{}.yaml", generate_uid());
        let file_path = dir.join(&file_name);
        std::fs::write(&file_path, content)
            .map_err(|e| anyhow::anyhow!("保存配置文件失败: {}", e))?;
        Ok(file_path.to_string_lossy().to_string())
    }

    fn now_secs() -> Option<u64> {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs())
    }

    /// 导入远程订阅
    pub async fn import_remote(&self, url: &str, name: Option<&str>) -> Result<PrfItem> {
        log::info!("[Profile] 导入远程订阅: {}", url);

        let (content, config_name) = Self::download_remote(url, name).await?;

        // 校验下载到的内容确为 YAML mapping，避免 base64/v2ray JSON 被静默写入
        match serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&content) {
            Ok(v) if v.is_mapping() => {}
            Ok(_) => return Err(anyhow::anyhow!("订阅内容并非 Clash 配置 YAML (顶层非 mapping)")),
            Err(e) => return Err(anyhow::anyhow!("订阅内容解析 YAML 失败: {}", e)),
        }

        let file = self.write_profile_file(&content)?;

        let mut item = PrfItem::new_remote(&config_name, url);
        item.file = Some(file);
        item.updated = Self::now_secs();

        let uid = item.uid.clone();
        self.add_profile(item.clone())?;
        // 自动选中新导入的 Profile，避免用户忘记点击导致启动内核时 config 为空
        let _ = self.select_profile(&uid);

        log::info!("[Profile] 远程订阅导入成功: {} ({})", config_name, uid);
        Ok(item)
    }

    /// 更新远程订阅（就地刷新，不再插入新条目）
    pub async fn update_remote(&self, uid: &str) -> Result<()> {
        let item = {
            let profiles = self.profiles.read();
            profiles
                .iter()
                .find(|p| p.uid == uid)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Profile 不存在: {}", uid))?
        };

        if item.item_type != PrfType::Remote {
            return Err(anyhow::anyhow!("只能更新远程订阅"));
        }

        let url = item
            .url
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("订阅 URL 为空"))?
            .clone();

        let (content, config_name) = Self::download_remote(&url, Some(&item.name)).await?;

        // 校验 YAML
        match serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&content) {
            Ok(v) if v.is_mapping() => {}
            Ok(_) => return Err(anyhow::anyhow!("订阅内容并非 Clash 配置 YAML (顶层非 mapping)")),
            Err(e) => return Err(anyhow::anyhow!("订阅内容解析 YAML 失败: {}", e)),
        }

        // 先写入新文件，再删除旧文件，避免中断时丢失配置
        let new_file = self.write_profile_file(&content)?;
        if let Some(old) = &item.file {
            let old_path = PathBuf::from(old);
            if old_path.exists() {
                let _ = std::fs::remove_file(&old_path);
            }
        }
        let was_selected = item.selected;

        let mut update = item.clone();
        update.name = config_name;
        update.file = Some(new_file);
        update.url = Some(url);
        update.updated = Self::now_secs();

        // 直接更新原有条目，保留 UID 与选中状态，不再调用会自动选中的 import_remote
        self.update_profile(uid, update)?;
        if was_selected {
            let _ = self.select_profile(uid);
        }
        log::info!("[Profile] 远程订阅更新成功: {}", uid);
        Ok(())
    }
}

// 全局单例
use std::sync::OnceLock;
static PROFILE_MANAGER: OnceLock<ProfileManager> = OnceLock::new();

impl ProfileManager {
    pub fn global() -> &'static ProfileManager {
        PROFILE_MANAGER.get_or_init(ProfileManager::new)
    }
}
