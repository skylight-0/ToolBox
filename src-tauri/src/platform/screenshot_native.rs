//! 纯 Rust（Win32）实现的截图功能。
//!
//! 取代原先“前端 WebView 画布 + Rust 后端传 RGBA”的方案：抓屏、背景渲染、
//! 选区绘制、工具栏、裁剪、复制/保存/钉图全部在一个独立的 Win32 线程中完成，
//! 完全不经过 WebView，避免兆级像素在 IPC 之间多次拷贝造成的卡顿。

use std::ffi::c_void;
use std::sync::Once;
use std::time::{Duration, Instant};

use tauri::Manager;

use windows_sys::core::PCWSTR;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    AlphaBlend, BeginPaint, BitBlt, ClientToScreen, CreateCompatibleDC, CreateDIBSection,
    CreateFontW, CreatePen, CreateSolidBrush, DeleteDC, DeleteObject, EndPaint, FillRect,
    GetDC, GetTextExtentPoint32W, InvalidateRect, LineTo, MoveToEx, ReleaseDC, SelectObject,
    SetBkMode, SetStretchBltMode, SetTextColor, StretchBlt, TextOutW, UpdateWindow,
    BLENDFUNCTION, BITMAPINFO, BITMAPINFOHEADER, HBITMAP, HFONT, HGDIOBJ, HDC, PAINTSTRUCT,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu,
    DispatchMessageW, GetCursorPos, GetMessageW, GetWindowLongPtrW, GetWindowRect,
    IsWindow, IsWindowVisible, LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassExW,
    SetCursor, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    TrackPopupMenu, TranslateMessage, CREATESTRUCTW, IDC_ARROW, MSG, WNDCLASSEXW,
};

use crate::MonitorInfo;

// ---- 常量（Win32 宏的数值形式，避免依赖具名常量的特性门控）-----------------

const WS_POPUP: u32 = 0x8000_0000;
const WS_EX_TOPMOST: u32 = 0x0000_0008;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const CS_HREDRAW: u32 = 0x0002;
const CS_VREDRAW: u32 = 0x0001;
const CS_DBLCLKS: u32 = 0x0008;
const SW_HIDE: i32 = 0;
const SW_SHOW: i32 = 5;
const SW_SHOWNA: i32 = 8;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const GWLP_USERDATA: i32 = -21;
const MF_STRING: u32 = 0;
const TPM_LEFTALIGN: u32 = 0x0000;
const TPM_TOPALIGN: u32 = 0x0000;
const TPM_RETURNCMD: u32 = 0x0100;
const VK_ESCAPE: i32 = 0x1B;
const VK_RETURN: i32 = 0x0D;
const SRCCOPY: u32 = 0x00CC_0020;
const PS_SOLID: i32 = 0;
const TRANSPARENT: i32 = 1;
const HALFTONE: i32 = 4;
const AC_SRC_OVER: u8 = 0;
const DIB_RGB_COLORS: u32 = 0;

const WM_CREATE: u32 = 0x0001;
const WM_DESTROY: u32 = 0x0002;
const WM_PAINT: u32 = 0x000F;
const WM_ERASEBKGND: u32 = 0x0014;
const WM_SETCURSOR: u32 = 0x0020;
const WM_KEYDOWN: u32 = 0x0100;
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_LBUTTONDBLCLK: u32 = 0x0203;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_MOUSEWHEEL: u32 = 0x020A;
const WM_NCCREATE: u32 = 0x0081;
const WM_CLOSE: u32 = 0x0010;

// 钉图右键菜单命令 ID
const MENU_COPY: usize = 1;
const MENU_SAVE: usize = 2;
const MENU_RESET: usize = 3;
const MENU_CLOSE: usize = 4;

static CLASS_REGISTER: Once = Once::new();

// 当前 overlay 窗口句柄（同一时刻最多一个 overlay），供取消/重入判定。
// 用模块级 static 避免 Tauri State 借用生命周期在窗口过程中的限制。
static OVERLAY_HWND: std::sync::Mutex<Option<isize>> = std::sync::Mutex::new(None);

fn set_overlay_hwnd(hwnd: HWND) {
    if let Ok(mut g) = OVERLAY_HWND.lock() {
        *g = Some(hwnd as isize);
    }
}
fn clear_overlay_hwnd(hwnd: HWND) {
    if let Ok(mut g) = OVERLAY_HWND.lock() {
        if *g == Some(hwnd as isize) {
            *g = None;
        }
    }
}
fn read_overlay_hwnd() -> isize {
    OVERLAY_HWND.lock().ok().and_then(|g| *g).unwrap_or(0)
}

thread_local! {
    static WINDOW_COUNT: std::cell::Cell<i32> = std::cell::Cell::new(0);
}

fn window_count_inc() {
    WINDOW_COUNT.with(|c| c.set(c.get() + 1));
}
fn window_count_dec_and_maybe_quit() {
    WINDOW_COUNT.with(|c| {
        let n = c.get() - 1;
        c.set(n);
        if n <= 0 {
            unsafe {
                PostQuitMessage(0);
            }
        }
    });
}

fn null_hwnd() -> HWND {
    std::ptr::null_mut()
}

/// 从 LPARAM 中取出鼠标客户区坐标（带符号）。
fn mouse_xy(lparam: LPARAM) -> (i32, i32) {
    let l = lparam as i32;
    let x = (l as u16) as i16 as i32;
    let y = ((l >> 16) as u16) as i16 as i32;
    (x, y)
}

/// 带 NUL 终止的 UTF-16 字符串（用于临时 PCWSTR）。
fn wide_vec(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 泄漏一个 UTF-16 字符串得到 'static PCWSTR，用于窗口类名（进程级常驻）。
fn leak_wide(s: &str) -> PCWSTR {
    let v = s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let v = std::mem::ManuallyDrop::new(v);
    v.as_ptr()
}

fn rect_border(r: RECT) -> [POINT; 5] {
    [
        POINT { x: r.left, y: r.top },
        POINT { x: r.right, y: r.top },
        POINT { x: r.right, y: r.bottom },
        POINT { x: r.left, y: r.bottom },
        POINT { x: r.left, y: r.top },
    ]
}

// ---------------------------------------------------------------------------
// 屏幕捕获：保留 HBITMAP（DIB section），既可 BitBlt 渲染，又可读取像素裁剪。
// ---------------------------------------------------------------------------

struct NativeCapture {
    origin_x: i32,
    origin_y: i32,
    width: i32,
    height: i32,
    mem_dc: HDC,
    bitmap: HBITMAP,
    _old_obj: HGDIOBJ,
}

impl Drop for NativeCapture {
    fn drop(&mut self) {
        unsafe {
            if !self.mem_dc.is_null() {
                let _ = SelectObject(self.mem_dc, self._old_obj);
                let _ = DeleteDC(self.mem_dc);
            }
            if !self.bitmap.is_null() {
                let _ = DeleteObject(self.bitmap);
            }
        }
    }
}

unsafe fn capture_monitor(hdc_screen: HDC, x: i32, y: i32, w: i32, h: i32) -> Result<NativeCapture, String> {
    if w <= 0 || h <= 0 {
        return Err("无效的屏幕尺寸".to_string());
    }
    let mem_dc = CreateCompatibleDC(hdc_screen);
    if mem_dc.is_null() {
        return Err("CreateCompatibleDC 失败".to_string());
    }

    let mut bi: BITMAPINFO = std::mem::zeroed();
    bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h; // 负高度 → 自顶向下 DIB
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = 0; // BI_RGB

    let mut bits: *mut c_void = std::ptr::null_mut();
    let bitmap = CreateDIBSection(hdc_screen, &bi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
    if bitmap.is_null() {
        let _ = DeleteDC(mem_dc);
        return Err("CreateDIBSection 失败".to_string());
    }

    let old_obj = SelectObject(mem_dc, bitmap);
    if BitBlt(mem_dc, 0, 0, w, h, hdc_screen, x, y, SRCCOPY) == 0 {
        let _ = SelectObject(mem_dc, old_obj);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(mem_dc);
        return Err("BitBlt 失败".to_string());
    }

    Ok(NativeCapture {
        origin_x: x,
        origin_y: y,
        width: w,
        height: h,
        mem_dc,
        bitmap,
        _old_obj: old_obj,
    })
}

fn capture_all(monitors: &[MonitorInfo]) -> Result<Vec<NativeCapture>, String> {
    unsafe {
        let hdc_screen = GetDC(null_hwnd());
        if hdc_screen.is_null() {
            return Err("获取屏幕 DC 失败".to_string());
        }
        let mut out = Vec::with_capacity(monitors.len());
        for m in monitors {
            match capture_monitor(hdc_screen, m.x, m.y, m.width, m.height) {
                Ok(c) => out.push(c),
                Err(e) => log::error!("捕获屏幕 ({},{}) 失败: {}", m.x, m.y, e),
            }
        }
        let _ = ReleaseDC(null_hwnd(), hdc_screen);
        if out.is_empty() {
            return Err("没有成功捕获任何屏幕".to_string());
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// 裁剪结果：把选区从各屏捕获合成到一张 DIB。
// ---------------------------------------------------------------------------

struct CroppedImage {
    mem_dc: HDC,
    bitmap: HBITMAP,
    bits: *mut u8, // BGRA，自顶向下
    width: i32,
    height: i32,
    _old_obj: HGDIOBJ,
}

impl Drop for CroppedImage {
    fn drop(&mut self) {
        unsafe {
            if !self.mem_dc.is_null() {
                let _ = SelectObject(self.mem_dc, self._old_obj);
                let _ = DeleteDC(self.mem_dc);
            }
            if !self.bitmap.is_null() {
                let _ = DeleteObject(self.bitmap);
            }
        }
    }
}

unsafe fn create_dib(w: i32, h: i32) -> Result<(HDC, HBITMAP, *mut u8, HGDIOBJ), String> {
    let dc = CreateCompatibleDC(null_hwnd());
    if dc.is_null() {
        return Err("CreateCompatibleDC 失败".to_string());
    }
    let mut bi: BITMAPINFO = std::mem::zeroed();
    bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = 0;
    let mut bits: *mut c_void = std::ptr::null_mut();
    let bmp = CreateDIBSection(null_hwnd(), &bi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
    if bmp.is_null() {
        let _ = DeleteDC(dc);
        return Err("CreateDIBSection 失败".to_string());
    }
    let old = SelectObject(dc, bmp);
    Ok((dc, bmp, bits as *mut u8, old))
}

unsafe fn crop_selection(
    captures: &[NativeCapture],
    vx: i32,
    vy: i32,
    sel: RECT,
) -> Result<CroppedImage, String> {
    let w = (sel.right - sel.left).max(1);
    let h = (sel.bottom - sel.top).max(1);
    let (dc, bmp, bits, old) = create_dib(w, h)?;
    for cap in captures {
        let cx = cap.origin_x - vx;
        let cy = cap.origin_y - vy;
        let ox = sel.left.max(cx);
        let oy = sel.top.max(cy);
        let ox2 = sel.right.min(cx + cap.width);
        let oy2 = sel.bottom.min(cy + cap.height);
        if ox < ox2 && oy < oy2 {
            let dx = ox - sel.left;
            let dy = oy - sel.top;
            let sx = ox - cx;
            let sy = oy - cy;
            let _ = BitBlt(dc, dx, dy, ox2 - ox, oy2 - oy, cap.mem_dc, sx, sy, SRCCOPY);
        }
    }
    Ok(CroppedImage {
        mem_dc: dc,
        bitmap: bmp,
        bits,
        width: w,
        height: h,
        _old_obj: old,
    })
}

/// 把 BGRA 自顶向下像素转为 RGBA（alpha 补 255）。
unsafe fn bgra_to_rgba(bits: *const u8, count: usize) -> Vec<u8> {
    let src = std::slice::from_raw_parts(bits, count * 4);
    let mut out = Vec::with_capacity(count * 4);
    for i in 0..count {
        out.push(src[i * 4 + 2]); // R
        out.push(src[i * 4 + 1]); // G
        out.push(src[i * 4 + 0]); // B
        out.push(255); // A
    }
    out
}

// ---------------------------------------------------------------------------
// GDI 资源包：背景合成缓冲、绘制缓冲、半透明遮罩、字体。
// ---------------------------------------------------------------------------

struct GdiBuffers {
    base_dc: HDC,
    base_bmp: HBITMAP,
    base_old: HGDIOBJ,
    paint_dc: HDC,
    paint_bmp: HBITMAP,
    paint_old: HGDIOBJ,
    dim_dc: HDC,
    dim_bmp: HBITMAP,
    dim_old: HGDIOBJ,
    font: HFONT,
    vw: i32,
    vh: i32,
}

impl Drop for GdiBuffers {
    fn drop(&mut self) {
        unsafe {
            if !self.font.is_null() {
                let _ = DeleteObject(self.font);
            }
            if !self.dim_dc.is_null() {
                let _ = SelectObject(self.dim_dc, self.dim_old);
                let _ = DeleteDC(self.dim_dc);
            }
            if !self.dim_bmp.is_null() {
                let _ = DeleteObject(self.dim_bmp);
            }
            if !self.paint_dc.is_null() {
                let _ = SelectObject(self.paint_dc, self.paint_old);
                let _ = DeleteDC(self.paint_dc);
            }
            if !self.paint_bmp.is_null() {
                let _ = DeleteObject(self.paint_bmp);
            }
            if !self.base_dc.is_null() {
                let _ = SelectObject(self.base_dc, self.base_old);
                let _ = DeleteDC(self.base_dc);
            }
            if !self.base_bmp.is_null() {
                let _ = DeleteObject(self.base_bmp);
            }
        }
    }
}

unsafe fn build_buffers(captures: &[NativeCapture], vx: i32, vy: i32, vw: i32, vh: i32) -> Result<GdiBuffers, String> {
    let (base_dc, base_bmp, _base_bits, base_old) = create_dib(vw, vh)?;
    for cap in captures {
        let dx = cap.origin_x - vx;
        let dy = cap.origin_y - vy;
        let _ = BitBlt(base_dc, dx, dy, cap.width, cap.height, cap.mem_dc, 0, 0, SRCCOPY);
    }

    let (paint_dc, paint_bmp, _paint_bits, paint_old) = create_dib(vw, vh)?;

    let (dim_dc, dim_bmp, dim_bits, dim_old) = create_dib(1, 1)?;
    let dim_bytes = std::slice::from_raw_parts_mut(dim_bits, 4);
    dim_bytes[0] = 0;
    dim_bytes[1] = 0;
    dim_bytes[2] = 0;
    dim_bytes[3] = 255;

    let face = wide_vec("Microsoft YaHei");
    let font = CreateFontW(
        -14, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, face.as_ptr(),
    );
    if font.is_null() {
        return Err("CreateFontW 失败".to_string());
    }

    Ok(GdiBuffers {
        base_dc,
        base_bmp,
        base_old,
        paint_dc,
        paint_bmp,
        paint_old,
        dim_dc,
        dim_bmp,
        dim_old,
        font,
        vw,
        vh,
    })
}

unsafe fn dim_rect(hdc: HDC, buf: &GdiBuffers, x: i32, y: i32, w: i32, h: i32, alpha: u8) {
    if w <= 0 || h <= 0 {
        return;
    }
    let bf = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER,
        BlendFlags: 0,
        SourceConstantAlpha: alpha,
        AlphaFormat: 0,
    };
    let _ = AlphaBlend(hdc, x, y, w, h, buf.dim_dc, 0, 0, 1, 1, bf);
}

unsafe fn draw_border(dc: HDC, r: RECT, color: u32) {
    let pen = CreatePen(PS_SOLID, 1, color);
    if pen.is_null() {
        return;
    }
    let old = SelectObject(dc, pen);
    let pts = rect_border(r);
    let _ = MoveToEx(dc, pts[0].x, pts[0].y, std::ptr::null_mut());
    for p in &pts[1..] {
        let _ = LineTo(dc, p.x, p.y);
    }
    let _ = SelectObject(dc, old);
    let _ = DeleteObject(pen);
}

unsafe fn draw_text_centered(hdc: HDC, buf: &GdiBuffers, text: &str, rc: RECT, text_color: u32) {
    let _ = SelectObject(hdc, buf.font);
    let _ = SetBkMode(hdc, TRANSPARENT);
    let _ = SetTextColor(hdc, text_color);
    let wide = wide_vec(text);
    let len = (wide.len() - 1) as i32;
    let mut size = SIZE { cx: 0, cy: 0 };
    let _ = GetTextExtentPoint32W(hdc, wide.as_ptr(), len, &mut size);
    let tx = rc.left + ((rc.right - rc.left) - size.cx) / 2;
    let ty = rc.top + ((rc.bottom - rc.top) - size.cy) / 2;
    let _ = TextOutW(hdc, tx, ty, wide.as_ptr(), len);
}

// ---------------------------------------------------------------------------
// 截图 overlay 窗口状态。
// ---------------------------------------------------------------------------

struct OverlayState {
    app: tauri::AppHandle,
    captures: Vec<NativeCapture>,
    buf: GdiBuffers,
    vx: i32,
    vy: i32,
    vw: i32,
    vh: i32,
    hwnd: HWND,
    selection: Option<RECT>,
    drawing: Option<POINT>,
    cursor: POINT,
    has_cursor: bool,
    buttons: Vec<(RECT, &'static str)>,
    hover_btn: i32,
    was_main_visible: bool,
    last_paint: Instant,
}

impl OverlayState {
    fn recompute_buttons(&mut self) {
        self.buttons.clear();
        let sel = match self.selection {
            Some(r) if (r.right - r.left) >= 4 && (r.bottom - r.top) >= 4 => r,
            _ => return,
        };
        const BW: i32 = 64;
        const BH: i32 = 32;
        const GAP: i32 = 6;
        let labels: [&'static str; 4] = ["复制", "保存", "钉图", "取消"];
        let n = labels.len() as i32;
        let total = n * BW + (n - 1) * GAP;
        let mut tx = sel.right - total;
        let mut ty = sel.bottom + 8;
        if ty + BH > self.vh {
            ty = sel.top - BH - 8;
        }
        if tx < 0 {
            tx = 0;
        }
        if tx + total > self.vw {
            tx = self.vw - total;
        }
        for (i, label) in labels.iter().enumerate() {
            let x0 = tx + (i as i32) * (BW + GAP);
            self.buttons.push((
                RECT {
                    left: x0,
                    top: ty,
                    right: x0 + BW,
                    bottom: ty + BH,
                },
                label,
            ));
        }
    }

    fn hit_button(&self, x: i32, y: i32) -> Option<usize> {
        for (i, (r, _)) in self.buttons.iter().enumerate() {
            if x >= r.left && x < r.right && y >= r.top && y < r.bottom {
                return Some(i);
            }
        }
        None
    }

    fn invalidate_throttled(&mut self) {
        if self.last_paint.elapsed() >= Duration::from_millis(8) {
            self.last_paint = Instant::now();
            unsafe {
                let _ = InvalidateRect(self.hwnd, std::ptr::null(), 0);
            }
        }
    }
}

fn normalize_rect(x0: i32, y0: i32, x1: i32, y1: i32) -> RECT {
    RECT {
        left: x0.min(x1),
        top: y0.min(y1),
        right: x0.max(x1),
        bottom: y0.max(y1),
    }
}

// ---------------------------------------------------------------------------
// overlay 窗口过程。
// ---------------------------------------------------------------------------

unsafe extern "system" fn overlay_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_NCCREATE => {
            let cs = lparam as *const CREATESTRUCTW;
            let state_ptr = (*cs).lpCreateParams as *mut OverlayState;
            let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        WM_CREATE => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
            if !state_ptr.is_null() {
                (*state_ptr).hwnd = hwnd;
                set_overlay_hwnd(hwnd);
            }
            window_count_inc();
            return 0;
        }
        WM_ERASEBKGND => return 1,
        WM_SETCURSOR => {
            let _ = SetCursor(LoadCursorW(std::ptr::null_mut(), IDC_ARROW));
            return 1;
        }
        WM_PAINT => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
            if !state_ptr.is_null() {
                paint_overlay(state_ptr, hwnd);
            }
            return 0;
        }
        WM_MOUSEMOVE => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
            if state_ptr.is_null() {
                return 0;
            }
            let (x, y) = mouse_xy(lparam);
            let st = &mut *state_ptr;
            st.cursor = POINT { x, y };
            st.has_cursor = true;
            if let Some(start) = st.drawing {
                st.selection = Some(normalize_rect(start.x, start.y, x, y));
                st.recompute_buttons();
            } else {
                let new_hover = st.hit_button(x, y).map(|i| i as i32).unwrap_or(-1);
                if new_hover != st.hover_btn {
                    st.hover_btn = new_hover;
                    let _ = InvalidateRect(hwnd, std::ptr::null(), 0);
                }
            }
            st.invalidate_throttled();
            return 0;
        }
        WM_LBUTTONDOWN => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
            if state_ptr.is_null() {
                return 0;
            }
            let (x, y) = mouse_xy(lparam);
            let st = &mut *state_ptr;
            if let Some(idx) = st.hit_button(x, y) {
                let action = match st.buttons[idx].1 {
                    "复制" => "copy",
                    "保存" => "save",
                    "钉图" => "pin",
                    "取消" => "cancel",
                    _ => "",
                };
                perform_action(state_ptr, action);
                return 0;
            }
            st.drawing = Some(POINT { x, y });
            st.selection = Some(RECT { left: x, top: y, right: x, bottom: y });
            st.buttons.clear();
            st.hover_btn = -1;
            let _ = SetCapture(hwnd);
            st.invalidate_throttled();
            return 0;
        }
        WM_LBUTTONUP => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
            if state_ptr.is_null() {
                return 0;
            }
            let st = &mut *state_ptr;
            if st.drawing.take().is_some() {
                let _ = ReleaseCapture();
                if let Some(r) = st.selection {
                    if (r.right - r.left) < 4 || (r.bottom - r.top) < 4 {
                        st.selection = None;
                    }
                }
                st.recompute_buttons();
                let _ = InvalidateRect(hwnd, std::ptr::null(), 0);
            }
            return 0;
        }
        WM_LBUTTONDBLCLK => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
            if state_ptr.is_null() {
                return 0;
            }
            let (x, y) = mouse_xy(lparam);
            let st = &mut *state_ptr;
            if let Some(r) = st.selection {
                if x >= r.left && x < r.right && y >= r.top && y < r.bottom {
                    perform_action(state_ptr, "copy");
                    return 0;
                }
            }
            return 0;
        }
        WM_RBUTTONUP => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
            if !state_ptr.is_null() {
                perform_action(state_ptr, "cancel");
            }
            return 0;
        }
        WM_KEYDOWN => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
            if state_ptr.is_null() {
                return 0;
            }
            let vk = wparam as i32;
            if vk == VK_ESCAPE {
                perform_action(state_ptr, "cancel");
            } else if vk == VK_RETURN {
                perform_action(state_ptr, "copy");
            }
            return 0;
        }
        WM_DESTROY => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
            if !state_ptr.is_null() {
                let st = &mut *state_ptr;
                clear_overlay_hwnd(hwnd);
                let was_main_visible = st.was_main_visible;
                if was_main_visible {
                    let app2 = st.app.clone();
                    let _ = st.app.run_on_main_thread(move || {
                        crate::show_sidebar_window(&app2, &app2.state::<crate::AppState>());
                    });
                }
                let _ = Box::from_raw(state_ptr);
            }
            window_count_dec_and_maybe_quit();
            return 0;
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

unsafe fn paint_overlay(state_ptr: *mut OverlayState, hwnd: HWND) {
    let st = &mut *state_ptr;
    let mut ps: PAINTSTRUCT = std::mem::zeroed();
    let hdc = BeginPaint(hwnd, &mut ps);
    if hdc.is_null() {
        return;
    }
    let buf = &st.buf;

    let _ = BitBlt(buf.paint_dc, 0, 0, st.vw, st.vh, buf.base_dc, 0, 0, SRCCOPY);
    let dc = buf.paint_dc;
    let _ = SelectObject(dc, buf.font);

    let has_sel = matches!(st.selection, Some(r) if (r.right - r.left) >= 4 && (r.bottom - r.top) >= 4);

    if has_sel {
        if let Some(sel) = st.selection {
            dim_rect(dc, buf, 0, 0, st.vw, sel.top, 130);
            dim_rect(dc, buf, 0, sel.bottom, st.vw, st.vh - sel.bottom, 130);
            dim_rect(dc, buf, 0, sel.top, sel.left, sel.bottom - sel.top, 130);
            dim_rect(dc, buf, sel.right, sel.top, st.vw - sel.right, sel.bottom - sel.top, 130);

            draw_border(dc, sel, 0x00D77800);

            let label = format!("{} × {}", sel.right - sel.left, sel.bottom - sel.top);
            let label_w = (label.chars().count() as i32) * 9 + 16;
            let label_h = 20;
            let mut ly = sel.top - label_h - 2;
            if ly < 0 {
                ly = sel.bottom + 2;
            }
            let label_rc = RECT {
                left: sel.left,
                top: ly,
                right: sel.left + label_w,
                bottom: ly + label_h,
            };
            let bg = CreateSolidBrush(0x0000_0000);
            let _ = FillRect(dc, &label_rc, bg);
            let _ = DeleteObject(bg);
            draw_text_centered(dc, buf, &label, label_rc, 0x00FF_FFFF);

            for (i, (r, label)) in st.buttons.iter().enumerate() {
                let hover = i as i32 == st.hover_btn;
                let bg_color = if hover { 0x00D77800 } else { 0x0030_3030 };
                let brush = CreateSolidBrush(bg_color);
                let _ = FillRect(dc, r, brush);
                let _ = DeleteObject(brush);
                draw_border(dc, *r, 0x0050_5050);
                draw_text_centered(dc, buf, label, *r, 0x00FF_FFFF);
            }
        }
    } else {
        dim_rect(dc, buf, 0, 0, st.vw, st.vh, 90);
        draw_crosshair(dc, st);
        draw_hint(dc, buf, st);
    }

    let _ = BitBlt(hdc, 0, 0, st.vw, st.vh, dc, 0, 0, SRCCOPY);
    let _ = EndPaint(hwnd, &ps);
}

unsafe fn draw_crosshair(dc: HDC, st: &OverlayState) {
    if !st.has_cursor {
        return;
    }
    let pen = CreatePen(PS_SOLID, 1, 0x00FF_FFFF);
    if pen.is_null() {
        return;
    }
    let old = SelectObject(dc, pen);
    let _ = MoveToEx(dc, 0, st.cursor.y, std::ptr::null_mut());
    let _ = LineTo(dc, st.vw, st.cursor.y);
    let _ = MoveToEx(dc, st.cursor.x, 0, std::ptr::null_mut());
    let _ = LineTo(dc, st.cursor.x, st.vh);
    let _ = SelectObject(dc, old);
    let _ = DeleteObject(pen);
}

unsafe fn draw_hint(dc: HDC, buf: &GdiBuffers, st: &OverlayState) {
    let hint = "拖拽选择区域 · Enter 复制 · Esc 取消";
    let wide = wide_vec(hint);
    let _ = SelectObject(dc, buf.font);
    let mut size = SIZE { cx: 0, cy: 0 };
    let _ = GetTextExtentPoint32W(dc, wide.as_ptr(), (wide.len() - 1) as i32, &mut size);
    let pad = 10;
    let rc = RECT {
        left: (st.vw - size.cx) / 2 - pad,
        top: st.vh - size.cy - 24 - pad,
        right: (st.vw + size.cx) / 2 + pad,
        bottom: st.vh - 24 + pad,
    };
    let bg = CreateSolidBrush(0x0030_3030);
    let _ = FillRect(dc, &rc, bg);
    let _ = DeleteObject(bg);
    let _ = SetBkMode(dc, TRANSPARENT);
    let _ = SetTextColor(dc, 0x00FF_FFFF);
    let _ = TextOutW(dc, rc.left + pad, rc.top + pad, wide.as_ptr(), (wide.len() - 1) as i32);
}

// ---------------------------------------------------------------------------
// 动作执行。
// ---------------------------------------------------------------------------

unsafe fn perform_action(state_ptr: *mut OverlayState, action: &str) {
    let st = &mut *state_ptr;
    match action {
        "cancel" => {
            let _ = PostMessageW(st.hwnd, WM_CLOSE, 0, 0);
        }
        "copy" => {
            if let Some(sel) = st.selection {
                if (sel.right - sel.left) >= 4 && (sel.bottom - sel.top) >= 4 {
                    if let Ok(cropped) = crop_selection(&st.captures, st.vx, st.vy, sel) {
                        let count = (cropped.width as usize) * (cropped.height as usize);
                        let rgba = bgra_to_rgba(cropped.bits, count);
                        let img = tauri::image::Image::new_owned(rgba, cropped.width as u32, cropped.height as u32);
                        use tauri_plugin_clipboard_manager::ClipboardExt;
                        let _ = st.app.clipboard().write_image(&img);
                    }
                }
            }
            let _ = PostMessageW(st.hwnd, WM_CLOSE, 0, 0);
        }
        "save" => {
            let _ = ShowWindow(st.hwnd, SW_HIDE);
            if let Some(sel) = st.selection {
                if (sel.right - sel.left) >= 4 && (sel.bottom - sel.top) >= 4 {
                    if let Ok(cropped) = crop_selection(&st.captures, st.vx, st.vy, sel) {
                        let count = (cropped.width as usize) * (cropped.height as usize);
                        let rgba = bgra_to_rgba(cropped.bits, count);
                        if let Ok(png) = crate::rgba_to_png_bytes(&rgba, cropped.width as u32, cropped.height as u32) {
                            use tauri_plugin_dialog::{DialogExt, FilePath};
                            let app = st.app.clone();
                            let ts = crate::chrono_like_timestamp();
                            let chosen = app
                                .dialog()
                                .file()
                                .add_filter("PNG", &["png"])
                                .set_file_name(&format!("screenshot-{}.png", ts))
                                .blocking_save_file();
                            if let Some(FilePath::Path(path)) = chosen {
                                let _ = std::fs::write(&path, &png);
                            }
                        }
                    }
                }
            }
            let _ = PostMessageW(st.hwnd, WM_CLOSE, 0, 0);
        }
        "pin" => {
            if let Some(sel) = st.selection {
                if (sel.right - sel.left) >= 4 && (sel.bottom - sel.top) >= 4 {
                    if let Ok(cropped) = crop_selection(&st.captures, st.vx, st.vy, sel) {
                        let phys_x = st.vx + sel.left;
                        let phys_y = st.vy + sel.top;
                        let _ = create_pin_window(st.app.clone(), cropped, phys_x, phys_y);
                    }
                }
            }
            let _ = PostMessageW(st.hwnd, WM_CLOSE, 0, 0);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// 钉图窗口。
// ---------------------------------------------------------------------------

struct PinState {
    app: tauri::AppHandle,
    mem_dc: HDC,
    bitmap: HBITMAP,
    bits: *mut u8,
    base_w: i32,
    base_h: i32,
    scale: f64,
    hwnd: HWND,
    dragging: bool,
    drag_cursor: POINT,
    drag_win_pos: POINT,
    last_click: Option<Instant>,
}

impl Drop for PinState {
    fn drop(&mut self) {
        unsafe {
            if !self.mem_dc.is_null() {
                let _ = DeleteDC(self.mem_dc);
            }
            if !self.bitmap.is_null() {
                let _ = DeleteObject(self.bitmap);
            }
        }
    }
}

unsafe fn create_pin_window(
    app: tauri::AppHandle,
    cropped: CroppedImage,
    phys_x: i32,
    phys_y: i32,
) -> Result<(), String> {
    let w = cropped.width;
    let h = cropped.height;
    let state = PinState {
        app: app.clone(),
        mem_dc: cropped.mem_dc,
        bitmap: cropped.bitmap,
        bits: cropped.bits,
        base_w: w,
        base_h: h,
        scale: 1.0,
        hwnd: null_hwnd(),
        dragging: false,
        drag_cursor: POINT { x: 0, y: 0 },
        drag_win_pos: POINT { x: 0, y: 0 },
        last_click: None,
    };
    // 所有权转移到 PinState，避免 CroppedImage::drop 释放资源。
    std::mem::forget(cropped);

    let state_ptr = Box::into_raw(Box::new(state));
    let hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        overlay_class_name(),
        std::ptr::null(),
        WS_POPUP,
        phys_x,
        phys_y,
        w,
        h,
        null_hwnd(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        state_ptr as *const c_void,
    );
    if hwnd.is_null() {
        let _ = Box::from_raw(state_ptr);
        return Err("创建钉图窗口失败".to_string());
    }

    window_count_inc();
    (*state_ptr).hwnd = hwnd;
    let _ = ShowWindow(hwnd, SW_SHOWNA);
    let _ = UpdateWindow(hwnd);
    Ok(())
}

unsafe extern "system" fn pin_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_NCCREATE => {
            let cs = lparam as *const CREATESTRUCTW;
            let state_ptr = (*cs).lpCreateParams as *mut PinState;
            let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        WM_ERASEBKGND => return 1,
        WM_SETCURSOR => {
            let _ = SetCursor(LoadCursorW(std::ptr::null_mut(), IDC_ARROW));
            return 1;
        }
        WM_PAINT => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PinState;
            if state_ptr.is_null() {
                return 0;
            }
            let st = &*state_ptr;
            let mut ps: PAINTSTRUCT = std::mem::zeroed();
            let hdc = BeginPaint(hwnd, &mut ps);
            if !hdc.is_null() {
                let _ = SetStretchBltMode(hdc, HALFTONE);
                let cw = (st.base_w as f64 * st.scale).round() as i32;
                let ch = (st.base_h as f64 * st.scale).round() as i32;
                let _ = StretchBlt(hdc, 0, 0, cw, ch, st.mem_dc, 0, 0, st.base_w, st.base_h, SRCCOPY);
                let _ = EndPaint(hwnd, &ps);
            }
            return 0;
        }
        WM_LBUTTONDOWN => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PinState;
            if state_ptr.is_null() {
                return 0;
            }
            let st = &mut *state_ptr;
            if let Some(t) = st.last_click {
                if t.elapsed() < Duration::from_millis(300) {
                    st.last_click = None;
                    let _ = PostMessageW(hwnd, WM_CLOSE, 0, 0);
                    return 0;
                }
            }
            st.last_click = Some(Instant::now());
            let mut cur = POINT { x: 0, y: 0 };
            let _ = GetCursorPos(&mut cur);
            let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            let _ = GetWindowRect(hwnd, &mut r);
            st.dragging = true;
            st.drag_cursor = cur;
            st.drag_win_pos = POINT { x: r.left, y: r.top };
            let _ = SetCapture(hwnd);
            return 0;
        }
        WM_MOUSEMOVE => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PinState;
            if state_ptr.is_null() {
                return 0;
            }
            let st = &mut *state_ptr;
            if st.dragging {
                let mut cur = POINT { x: 0, y: 0 };
                let _ = GetCursorPos(&mut cur);
                let nx = st.drag_win_pos.x + (cur.x - st.drag_cursor.x);
                let ny = st.drag_win_pos.y + (cur.y - st.drag_cursor.y);
                let _ = SetWindowPos(hwnd, null_hwnd(), nx, ny, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE);
            }
            return 0;
        }
        WM_LBUTTONUP => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PinState;
            if !state_ptr.is_null() {
                let st = &mut *state_ptr;
                if st.dragging {
                    st.dragging = false;
                    let _ = ReleaseCapture();
                }
            }
            return 0;
        }
        WM_RBUTTONUP => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PinState;
            if state_ptr.is_null() {
                return 0;
            }
            let menu = CreatePopupMenu();
            if !menu.is_null() {
                let copy = wide_vec("复制图片");
                let save = wide_vec("另存为");
                let reset = wide_vec("重置大小");
                let close = wide_vec("关闭");
                let _ = AppendMenuW(menu, MF_STRING, MENU_COPY, copy.as_ptr());
                let _ = AppendMenuW(menu, MF_STRING, MENU_SAVE, save.as_ptr());
                let _ = AppendMenuW(menu, MF_STRING, MENU_RESET, reset.as_ptr());
                let _ = AppendMenuW(menu, MF_STRING, MENU_CLOSE, close.as_ptr());
                let (x, y) = mouse_xy(lparam);
                let mut pt = POINT { x, y };
                let _ = ClientToScreen(hwnd, &mut pt);
                let cmd = TrackPopupMenu(
                    menu,
                    TPM_LEFTALIGN | TPM_TOPALIGN | TPM_RETURNCMD,
                    pt.x,
                    pt.y,
                    0,
                    hwnd,
                    std::ptr::null(),
                );
                let _ = DestroyMenu(menu);
                if cmd != 0 {
                    handle_pin_menu(state_ptr, cmd as usize);
                }
            }
            return 0;
        }
        WM_MOUSEWHEEL => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PinState;
            if state_ptr.is_null() {
                return 0;
            }
            let st = &mut *state_ptr;
            let delta = (wparam as i32 >> 16) as i16 as i32;
            let factor = if delta > 0 { 1.1f64 } else { 1.0 / 1.1 };
            st.scale = (st.scale * factor).clamp(0.2, 8.0);
            let cw = (st.base_w as f64 * st.scale).round() as i32;
            let ch = (st.base_h as f64 * st.scale).round() as i32;
            let _ = SetWindowPos(hwnd, null_hwnd(), 0, 0, cw, ch, SWP_NOZORDER | SWP_NOACTIVATE);
            let _ = InvalidateRect(hwnd, std::ptr::null(), 0);
            return 0;
        }
        WM_DESTROY => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PinState;
            if !state_ptr.is_null() {
                let _ = Box::from_raw(state_ptr);
            }
            window_count_dec_and_maybe_quit();
            return 0;
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

unsafe fn handle_pin_menu(state_ptr: *mut PinState, cmd: usize) {
    match cmd {
        MENU_COPY => {
            let st = &*state_ptr;
            let count = (st.base_w as usize) * (st.base_h as usize);
            let rgba = bgra_to_rgba(st.bits, count);
            let img = tauri::image::Image::new_owned(rgba, st.base_w as u32, st.base_h as u32);
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let _ = st.app.clipboard().write_image(&img);
        }
        MENU_SAVE => {
            let st = &*state_ptr;
            let count = (st.base_w as usize) * (st.base_h as usize);
            let rgba = bgra_to_rgba(st.bits, count);
            if let Ok(png) = crate::rgba_to_png_bytes(&rgba, st.base_w as u32, st.base_h as u32) {
                use tauri_plugin_dialog::{DialogExt, FilePath};
                let app = st.app.clone();
                let ts = crate::chrono_like_timestamp();
                let chosen = app
                    .dialog()
                    .file()
                    .add_filter("PNG", &["png"])
                    .set_file_name(&format!("pin-{}.png", ts))
                    .blocking_save_file();
                if let Some(FilePath::Path(path)) = chosen {
                    let _ = std::fs::write(&path, &png);
                }
            }
        }
        MENU_RESET => {
            let st = &mut *state_ptr;
            st.scale = 1.0;
            let _ = SetWindowPos(st.hwnd, null_hwnd(), 0, 0, st.base_w, st.base_h, SWP_NOZORDER | SWP_NOACTIVATE);
            let _ = InvalidateRect(st.hwnd, std::ptr::null(), 0);
        }
        MENU_CLOSE => {
            let st = &*state_ptr;
            let _ = PostMessageW(st.hwnd, WM_CLOSE, 0, 0);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// 类注册 + 入口。
// ---------------------------------------------------------------------------

fn overlay_class_name() -> PCWSTR {
    static mut NAME: PCWSTR = std::ptr::null();
    static ONCE: Once = Once::new();
    unsafe {
        ONCE.call_once(|| {
            NAME = leak_wide("ToolBoxScreenshotOverlay");
        });
        NAME
    }
}

fn pin_class_name() -> PCWSTR {
    static mut NAME: PCWSTR = std::ptr::null();
    static ONCE: Once = Once::new();
    unsafe {
        ONCE.call_once(|| {
            NAME = leak_wide("ToolBoxPinWindow");
        });
        NAME
    }
}

unsafe fn register_classes() {
    let hcursor = LoadCursorW(std::ptr::null_mut(), IDC_ARROW);
    let overlay_cls = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
        lpfnWndProc: Some(overlay_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: std::ptr::null_mut(),
        hIcon: std::ptr::null_mut(),
        hCursor: hcursor,
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: overlay_class_name(),
        hIconSm: std::ptr::null_mut(),
    };
    let _ = RegisterClassExW(&overlay_cls);

    let pin_cls = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
        lpfnWndProc: Some(pin_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: std::ptr::null_mut(),
        hIcon: std::ptr::null_mut(),
        hCursor: hcursor,
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: pin_class_name(),
        hIconSm: std::ptr::null_mut(),
    };
    let _ = RegisterClassExW(&pin_cls);
}

/// 启动纯原生截图：在独立线程抓屏、显示 overlay、处理选区与动作。
/// 线程内同时承载钉图窗口的消息循环，overlay 关闭后钉图仍可继续存在。
pub fn start_native_screenshot(app: tauri::AppHandle, monitors: Vec<MonitorInfo>, was_main_visible: bool) {
    std::thread::spawn(move || {
        unsafe {
            CLASS_REGISTER.call_once(|| {
                register_classes();
            });

            let captures = match capture_all(&monitors) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("截图抓屏失败: {}", e);
                    if was_main_visible {
                        let app2 = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            crate::show_sidebar_window(&app2, &app2.state::<crate::AppState>());
                        });
                    }
                    return;
                }
            };

            let vx = monitors.iter().map(|m| m.x).min().unwrap_or(0);
            let vy = monitors.iter().map(|m| m.y).min().unwrap_or(0);
            let vw = monitors.iter().map(|m| m.x + m.width).max().unwrap_or(0) - vx;
            let vh = monitors.iter().map(|m| m.y + m.height).max().unwrap_or(0) - vy;
            if vw <= 0 || vh <= 0 {
                log::error!("虚拟屏幕尺寸无效");
                return;
            }

            let buf = match build_buffers(&captures, vx, vy, vw, vh) {
                Ok(b) => b,
                Err(e) => {
                    log::error!("构建截图缓冲失败: {}", e);
                    return;
                }
            };

            let state = OverlayState {
                app: app.clone(),
                captures,
                buf,
                vx,
                vy,
                vw,
                vh,
                hwnd: null_hwnd(),
                selection: None,
                drawing: None,
                cursor: POINT { x: 0, y: 0 },
                has_cursor: false,
                buttons: Vec::new(),
                hover_btn: -1,
                was_main_visible,
                last_paint: Instant::now(),
            };
            let state_ptr = Box::into_raw(Box::new(state));

            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                overlay_class_name(),
                std::ptr::null(),
                WS_POPUP,
                vx,
                vy,
                vw,
                vh,
                null_hwnd(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                state_ptr as *const c_void,
            );
            if hwnd.is_null() {
                log::error!("创建截图窗口失败");
                let _ = Box::from_raw(state_ptr);
                if was_main_visible {
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        crate::show_sidebar_window(&app2, &app2.state::<crate::AppState>());
                    });
                }
                return;
            }

            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = UpdateWindow(hwnd);

            // 消息循环：overlay 与钉图窗口共享，全部关闭后退出
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_hwnd(), 0, 0) > 0 {
                let _ = TranslateMessage(&msg);
                let _ = DispatchMessageW(&msg);
            }
        }
    });
}

/// 当前原生 overlay 是否处于活动状态。
pub fn is_overlay_active() -> bool {
    let h = read_overlay_hwnd();
    if h == 0 {
        return false;
    }
    unsafe {
        let hwnd = h as *mut c_void as HWND;
        IsWindow(hwnd) != 0 && IsWindowVisible(hwnd) != 0
    }
}

/// 聚焦当前 overlay（重入时调用）。
pub fn focus_overlay() {
    let h = read_overlay_hwnd();
    if h != 0 {
        unsafe {
            let hwnd = h as *mut c_void as HWND;
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

/// 取消截图：向 overlay 窗口发送 WM_CLOSE。
pub fn cancel_native_screenshot() {
    let h = read_overlay_hwnd();
    if h != 0 {
        unsafe {
            let hwnd = h as *mut c_void as HWND;
            let _ = PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
    }
}
