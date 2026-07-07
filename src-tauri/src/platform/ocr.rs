use windows::core::Interface;
use windows::Foundation::Rect;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::Buffer;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::IBufferByteAccess;

use crate::{OcrLineOut, OcrOutput, OcrWordOut};

/// 在已裁剪的物理像素 RGBA 上执行 Windows.Media.Ocr 识别。
/// 返回的行/词 bounding box 均为物理像素，原点为裁剪区域左上角。
/// 必须在阻塞线程中调用（spawn_blocking），内部用 join() 同步等待 WinRT 异步结果。
pub fn run_ocr(rgba: &[u8], width: u32, height: u32) -> Result<OcrOutput, String> {
    if width == 0 || height == 0 {
        return Err("OCR 输入区域为空".to_string());
    }

    // 确保当前线程进入 MTA（spawn_blocking 池线程默认无 COM 初始化）。
    // WinRT 异步完成回调运行在 WinRT 线程池上，get_results 由本线程调用，需 MTA。
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    // SoftwareBitmap 需要 BGRA8；捕获数据为 RGBA，逐像素交换 R/B
    let pixel_count = (width as usize) * (height as usize);
    let mut bgra = Vec::with_capacity(pixel_count * 4);
    for i in 0..pixel_count {
        bgra.push(rgba[i * 4 + 2]); // B
        bgra.push(rgba[i * 4 + 1]); // G
        bgra.push(rgba[i * 4 + 0]); // R
        bgra.push(rgba[i * 4 + 3]); // A
    }
    let len = bgra.len() as u32;

    let buffer = Buffer::Create(len).map_err(|e| format!("Buffer::Create 失败: {}", e))?;
    unsafe {
        let byte_access: IBufferByteAccess = buffer
            .cast()
            .map_err(|e| format!("获取 Buffer 内存访问接口失败: {}", e))?;
        let ptr = byte_access
            .Buffer()
            .map_err(|e| format!("获取 Buffer 指针失败: {}", e))?;
        std::ptr::copy_nonoverlapping(bgra.as_ptr(), ptr, len as usize);
        buffer
            .SetLength(len)
            .map_err(|e| format!("Buffer::SetLength 失败: {}", e))?;
    }

    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
        BitmapAlphaMode::Premultiplied,
    )
    .map_err(|e| format!("创建 SoftwareBitmap 失败: {}", e))?;

    let engine = pick_engine()?;
    let op = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("RecognizeAsync 失败: {}", e))?;
    let result = op
        .join()
        .map_err(|e| format!("OCR 识别失败: {}", e))?;

    let text = normalize_ocr_text(&result.Text().map(|s| s.to_string()).unwrap_or_default());

    let lines_view = result
        .Lines()
        .map_err(|e| format!("读取 OCR 行失败: {}", e))?;
    let line_count = lines_view
        .Size()
        .map_err(|e| format!("读取行数失败: {}", e))?;

    let mut lines_out = Vec::with_capacity(line_count as usize);
    for i in 0..line_count {
        let line = lines_view
            .GetAt(i)
            .map_err(|e| format!("读取第 {} 行失败: {}", i, e))?;
        let line_text = normalize_ocr_text(&line.Text().map(|s| s.to_string()).unwrap_or_default());

        let (mut min_x, mut min_y, mut max_x, mut max_y) =
            (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        let mut words_out = Vec::new();
        if let Ok(words_view) = line.Words() {
            let wcount = words_view.Size().unwrap_or(0);
            for j in 0..wcount {
                if let Ok(word) = words_view.GetAt(j) {
                    let wtext = word.Text().map(|s| s.to_string()).unwrap_or_default();
                    let r: Rect = word.BoundingRect().unwrap_or_default();
                    min_x = min_x.min(r.X);
                    min_y = min_y.min(r.Y);
                    max_x = max_x.max(r.X + r.Width);
                    max_y = max_y.max(r.Y + r.Height);
                    words_out.push(OcrWordOut {
                        text: wtext,
                        x: r.X as f64,
                        y: r.Y as f64,
                        w: r.Width as f64,
                        h: r.Height as f64,
                    });
                }
            }
        }

        let (bx, by, bw, bh) = if min_x == f32::MAX {
            (0.0_f64, 0.0, 0.0, 0.0)
        } else {
            (
                min_x as f64,
                min_y as f64,
                (max_x - min_x) as f64,
                (max_y - min_y) as f64,
            )
        };

        lines_out.push(OcrLineOut {
            text: line_text,
            x: bx,
            y: by,
            w: bw,
            h: bh,
            words: words_out,
        });
    }

    Ok(OcrOutput {
        text,
        lines: lines_out,
    })
}

fn pick_engine() -> Result<OcrEngine, String> {
    // 枚举已安装语言，优先中文，其次英文，再退而取首个
    let langs = OcrEngine::AvailableRecognizerLanguages()
        .map_err(|e| format!("枚举 OCR 语言失败: {}", e))?;
    let count = langs
        .Size()
        .map_err(|e| format!("读取 OCR 语言数量失败: {}", e))?;
    if count == 0 {
        return Err(
            "系统未安装 OCR 语言包，请在 Windows 设置 > 时间和语言 > 语言 中添加中文/英文语言包"
                .to_string(),
        );
    }

    let mut zh: Option<Language> = None;
    let mut en: Option<Language> = None;
    let mut fallback: Option<Language> = None;
    for i in 0..count {
        let lang = langs
            .GetAt(i)
            .map_err(|e| format!("读取语言失败: {}", e))?;
        let tag = lang.LanguageTag().map(|s| s.to_string()).unwrap_or_default();
        if zh.is_none() && tag.starts_with("zh") {
            zh = Some(lang);
        } else if en.is_none() && tag.starts_with("en") {
            en = Some(lang);
        } else if fallback.is_none() {
            fallback = Some(lang);
        }
    }
    let chosen = zh.or(en).or(fallback).unwrap();

    let engine = OcrEngine::TryCreateFromLanguage(&chosen)
        .map_err(|e| format!("创建 OCR 引擎失败: {}", e))?;
    if engine.as_raw().is_null() {
        return Err("创建 OCR 引擎失败：所选语言不可用".to_string());
    }
    Ok(engine)
}

fn normalize_ocr_text(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut normalized = String::with_capacity(text.len());

    for (idx, ch) in chars.iter().copied().enumerate() {
        if is_inline_space(ch) {
            let prev = previous_non_space(&chars, idx);
            let next = next_non_space(&chars, idx + 1);
            if should_suppress_ocr_space(prev, next) {
                continue;
            }
        }
        normalized.push(ch);
    }

    normalized
}

fn previous_non_space(chars: &[char], end: usize) -> Option<char> {
    chars[..end]
        .iter()
        .rev()
        .copied()
        .find(|ch| !is_inline_space(*ch))
}

fn next_non_space(chars: &[char], start: usize) -> Option<char> {
    chars[start..]
        .iter()
        .copied()
        .find(|ch| !is_inline_space(*ch))
}

fn should_suppress_ocr_space(prev: Option<char>, next: Option<char>) -> bool {
    match (prev, next) {
        (Some(left), Some(right)) => {
            (is_cjk(left) && (is_cjk(right) || is_cjk_punctuation(right)))
                || (is_cjk_punctuation(left) && is_cjk(right))
        }
        _ => false,
    }
}

fn is_inline_space(ch: char) -> bool {
    ch.is_whitespace() && ch != '\n' && ch != '\r'
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x3040..=0x30FF
            | 0xAC00..=0xD7AF
    )
}

fn is_cjk_punctuation(ch: char) -> bool {
    matches!(
        ch,
        '，' | '。' | '、' | '；' | '：' | '！' | '？' | '（' | '）' | '《' | '》' | '“'
            | '”' | '‘' | '’' | '【' | '】' | '「' | '」' | '『' | '』'
    )
}
