use serde::{Deserialize, Serialize};

const AZURE_ENDPOINT: &str = "https://api.cognitive.microsofttranslator.com";
const API_VERSION: &str = "3.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TranslateRequestItem {
    #[serde(rename = "Text")]
    text: String,
}

#[derive(Debug, Clone, Deserialize)]
struct TranslateResponseItem {
    translations: Vec<TranslateTranslation>,
}

#[derive(Debug, Clone, Deserialize)]
struct TranslateTranslation {
    text: String,
}

/// Azure 翻译所需的配置（从 app_settings 读取）。
#[derive(Debug, Clone)]
pub struct TranslateConfig {
    pub azure_key: String,
    pub azure_region: String,
    pub target_lang: String,
}

/// 调用 Azure Text Translation v3.2，把 text 翻译到 target_lang（BCP-47，如 zh-Hans、en）。
/// 必须在 spawn_blocking 线程中调用（ureq 是同步 IO）。
pub fn translate(text: &str, config: &TranslateConfig) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if config.azure_key.trim().is_empty() {
        return Err("未配置 Azure 翻译密钥".to_string());
    }
    if config.target_lang.trim().is_empty() {
        return Err("未配置目标语言".to_string());
    }

    let url = format!(
        "{}/translate?api-version={}&to={}",
        AZURE_ENDPOINT, API_VERSION, config.target_lang
    );

    let body = vec![TranslateRequestItem {
        text: text.to_string(),
    }];

    let response = ureq::post(&url)
        .set("Ocp-Apim-Subscription-Key", &config.azure_key)
        .set("Ocp-Apim-Subscription-Region", &config.azure_region)
        .set("Content-Type", "application/json; charset=UTF-8")
        .send_json(serde_json::to_value(&body).map_err(|e| format!("序列化请求失败: {}", e))?)
        .map_err(|e| format!("Azure 翻译请求失败: {}", e))?;

    let parsed: Vec<TranslateResponseItem> = response
        .into_json()
        .map_err(|e| format!("解析 Azure 翻译响应失败: {}", e))?;

    let translated = parsed
        .into_iter()
        .next()
        .and_then(|item| item.translations.into_iter().next())
        .map(|t| t.text)
        .ok_or_else(|| "Azure 翻译响应为空".to_string())?;

    Ok(translated)
}
