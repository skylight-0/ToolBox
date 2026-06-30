use std::io::Cursor;
use std::ptr;

use image::{DynamicImage, ImageFormat, RgbImage};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, HGDIOBJ, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HDC, SRCCOPY,
};

pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub struct CaptureOutput {
    pub png_bytes: Vec<u8>,
    pub width: i32,
    pub height: i32,
}

pub fn capture_screens(monitors: &[MonitorRect]) -> Result<Vec<CaptureOutput>, String> {
    unsafe {
        let hdc_screen = GetDC(None);
        if hdc_screen.is_invalid() {
            return Err("获取屏幕 DC 失败".to_string());
        }

        let mut results = Vec::with_capacity(monitors.len());
        for monitor in monitors {
            match capture_monitor(hdc_screen, monitor.x, monitor.y, monitor.width, monitor.height) {
                Ok(bytes) => results.push(CaptureOutput {
                    png_bytes: bytes,
                    width: monitor.width,
                    height: monitor.height,
                }),
                Err(error) => {
                    eprintln!("捕获屏幕 ({},{}) 失败: {}", monitor.x, monitor.y, error);
                }
            }
        }

        let _ = ReleaseDC(None, hdc_screen);

        if results.is_empty() {
            return Err("没有成功捕获任何屏幕".to_string());
        }
        Ok(results)
    }
}

unsafe fn capture_monitor(
    hdc_screen: HDC,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<Vec<u8>, String> {
    if width <= 0 || height <= 0 {
        return Err("无效的屏幕尺寸".to_string());
    }

    let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
    if hdc_mem.is_invalid() {
        return Err("CreateCompatibleDC 失败".to_string());
    }

    let mut bitmap_info: BITMAPINFO = std::mem::zeroed();
    bitmap_info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bitmap_info.bmiHeader.biWidth = width;
    // 负的高度表示自顶向下的 DIB，避免额外的垂直翻转
    bitmap_info.bmiHeader.biHeight = -height;
    bitmap_info.bmiHeader.biPlanes = 1;
    bitmap_info.bmiHeader.biBitCount = 32;
    bitmap_info.bmiHeader.biCompression = 0; // BI_RGB

    let mut bits: *mut std::ffi::c_void = ptr::null_mut();
    let bitmap = CreateDIBSection(
        Some(hdc_screen),
        &bitmap_info,
        DIB_RGB_COLORS,
        &mut bits,
        None,
        0,
    )
    .map_err(|error| format!("CreateDIBSection 失败: {}", error))?;

    let previous_object = SelectObject(hdc_mem, HGDIOBJ::from(bitmap));
    let copied = BitBlt(
        hdc_mem,
        0,
        0,
        width,
        height,
        Some(hdc_screen),
        x,
        y,
        SRCCOPY,
    )
    .is_ok();
    if !copied {
        let _ = SelectObject(hdc_mem, previous_object);
        let _ = DeleteObject(HGDIOBJ::from(bitmap));
        let _ = DeleteDC(hdc_mem);
        return Err("BitBlt 失败".to_string());
    }

    let pixel_count = (width as usize) * (height as usize);
    let src = std::slice::from_raw_parts(bits as *const u8, pixel_count * 4);
    // GDI 32 位 DIB 的内存布局为 BGRA，这里转换为 PNG 需要的 RGB 顺序
    let mut rgb = Vec::with_capacity(pixel_count * 3);
    for index in 0..pixel_count {
        rgb.push(src[index * 4 + 2]); // R
        rgb.push(src[index * 4 + 1]); // G
        rgb.push(src[index * 4 + 0]); // B
    }

    let _ = SelectObject(hdc_mem, previous_object);
    let _ = DeleteObject(HGDIOBJ::from(bitmap));
    let _ = DeleteDC(hdc_mem);

    let image = RgbImage::from_raw(width as u32, height as u32, rgb)
        .ok_or_else(|| "构造图像缓冲区失败".to_string())?;
    let dynamic = DynamicImage::ImageRgb8(image);

    let mut buffer = Cursor::new(Vec::with_capacity((pixel_count * 3) / 2));
    dynamic
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|error| format!("PNG 编码失败: {}", error))?;
    Ok(buffer.into_inner())
}
