import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import { imageDataUrlToImage, loadImage, type PinImageData } from "./screenshotModel";

export default function PinWindow() {
  const pinWindow = getCurrentWebviewWindow();
  const [data, setData] = useState<PinImageData | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const baseSizeRef = useRef<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<PinImageData>("get_pin_image", { label: pinWindow.label })
      .then(async (pinData) => {
        if (cancelled) return;
        baseSizeRef.current = { w: pinData.width, h: pinData.height };
        // 预加载图片，加载完成后再显示窗口，避免出现空白闪烁
        await loadImage(pinData.imageDataUrl);
        if (cancelled) return;
        setData(pinData);
        await pinWindow.show().catch(console.error);
      })
      .catch((error) => {
        console.error("加载钉图数据失败", error);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (menu) {
      setMenu(null);
      return;
    }
    void pinWindow.startDragging().catch(console.error);
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const base = baseSizeRef.current;
    if (!base) return;
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.max(0.2, Math.min(8, scale * factor));
    setScale(next);
    void pinWindow
      .setSize(new LogicalSize(Math.round(base.w * next), Math.round(base.h * next)))
      .catch(console.error);
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };

  const close = async () => {
    setMenu(null);
    await invoke("close_pin_image", { label: pinWindow.label }).catch(console.error);
    await pinWindow.close().catch(console.error);
  };

  const resetSize = () => {
    setMenu(null);
    const base = baseSizeRef.current;
    if (!base) return;
    setScale(1);
    void pinWindow.setSize(new LogicalSize(base.w, base.h)).catch(console.error);
  };

  const copyImage = async () => {
    setMenu(null);
    if (!data) return;
    try {
      const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
      const image = await imageDataUrlToImage(data.imageDataUrl);
      await writeImage(image);
      await image.close().catch(() => {});
    } catch (error) {
      console.error(error);
    }
  };

  const saveImage = async () => {
    setMenu(null);
    if (!data) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `pin-${Date.now()}.png`,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (path) {
        await invoke("save_image_data", { path, dataUrl: data.imageDataUrl });
      }
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <div
      className="pin-window"
      onMouseDown={startDrag}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
    >
      {data && (
        <img className="pin-image" src={data.imageDataUrl} draggable={false} alt="" />
      )}
      {menu && (
        <div
          className="pin-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button onClick={() => void copyImage()}>复制图片</button>
          <button onClick={() => void saveImage()}>另存为</button>
          <button onClick={resetSize}>重置大小</button>
          <button onClick={() => void close()}>关闭</button>
        </div>
      )}
    </div>
  );
}
