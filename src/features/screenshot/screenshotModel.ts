import { Image as TauriImage } from "@tauri-apps/api/image";

export type ActiveScreenshotPayload = {
  imageDataUrl: string;
  monitorIndex: number;
  monitorCount: number;
  scaleFactor: number;
  physicalWidth: number;
  physicalHeight: number;
  logicalWidth: number;
  logicalHeight: number;
};

export type PinImageData = {
  imageDataUrl: string;
  width: number;
  height: number;
};

export type CropRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

// 将 PNG/SVG 等 data URL 转为可写入系统剪贴板的 Image 资源，理由同上。
// 不能直接传 Uint8Array（会触发 JsImage::Bytes 的 PNG 解码路径，本项目没有启用特性）。
export async function imageDataUrlToImage(dataUrl: string): Promise<TauriImage> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建 Canvas 上下文");
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return TauriImage.new(
    new Uint8Array(imageData.data.buffer),
    canvas.width,
    canvas.height,
  );
}

export function normalizeRect(startX: number, startY: number, endX: number, endY: number): CropRect {
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  const w = Math.abs(endX - startX);
  const h = Math.abs(endY - startY);
  return { x, y, w, h };
}

function drawCropCanvas(
  sourceImage: HTMLImageElement,
  scaleFactor: number,
  rect: CropRect,
): HTMLCanvasElement {
  const sx = Math.max(0, Math.round(rect.x * scaleFactor));
  const sy = Math.max(0, Math.round(rect.y * scaleFactor));
  const sw = Math.max(1, Math.round(rect.w * scaleFactor));
  const sh = Math.max(1, Math.round(rect.h * scaleFactor));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建 Canvas 上下文");
  context.drawImage(sourceImage, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

// 返回裁剪后的 RGBA 像素与尺寸，用于写入系统剪贴板。
// writeImage 收到 Uint8Array 会走 JsImage::Bytes 分支，需要 tauri 启用
// image-png/image-ico 才解码，本项目没启用；所以这里改用 Image.new(rgba, w, h)
// 显式构造 RGBA，绕开对 PNG 解码特性的依赖。
export async function cropToClipboardImage(
  sourceImage: HTMLImageElement,
  scaleFactor: number,
  rect: CropRect,
): Promise<TauriImage> {
  const canvas = drawCropCanvas(sourceImage, scaleFactor, rect);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建 Canvas 上下文");
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return TauriImage.new(
    new Uint8Array(imageData.data.buffer),
    canvas.width,
    canvas.height,
  );
}

export async function cropToDataUrl(
  sourceImage: HTMLImageElement,
  scaleFactor: number,
  rect: CropRect,
): Promise<string> {
  const canvas = drawCropCanvas(sourceImage, scaleFactor, rect);
  return canvas.toDataURL("image/png");
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}
