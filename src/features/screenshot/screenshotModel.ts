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

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function normalizeRect(startX: number, startY: number, endX: number, endY: number): CropRect {
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  const w = Math.abs(endX - startX);
  const h = Math.abs(endY - startY);
  return { x, y, w, h };
}

export async function cropToDataUrl(
  sourceImage: HTMLImageElement,
  scaleFactor: number,
  rect: CropRect,
): Promise<string> {
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
