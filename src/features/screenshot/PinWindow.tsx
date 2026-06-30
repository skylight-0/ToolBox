import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import { loadImage, type PinImageData } from "./screenshotModel";

export default function PinWindow() {
  const pinWindow = getCurrentWebviewWindow();
  const [data, setData] = useState<PinImageData | null>(null);
  const [scale, setScale] = useState(1);
  const baseSizeRef = useRef<{ w: number; h: number } | null>(null);
  const lastClickRef = useRef(0);

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
    // 手动判定双击：300ms 内连续两次左键按下则关闭，避免 startDrag 抢占双击事件
    const now = Date.now();
    if (now - lastClickRef.current < 300) {
      lastClickRef.current = 0;
      void invoke("close_pin_image", { label: pinWindow.label }).catch(console.error);
      void pinWindow.close().catch(console.error);
      return;
    }
    lastClickRef.current = now;
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

  const onContextMenu = async (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    // 用独立顶层菜单窗口，避免被钉图窗口物理边界裁剪
    // event.clientX/Y 是窗口内逻辑坐标，需转屏幕物理坐标
    const factor = await pinWindow.scaleFactor().catch(() => 1);
    const pos = await pinWindow.outerPosition().catch(() => ({ x: 0, y: 0 }));
    const screenX = Math.round(pos.x + event.clientX * factor);
    const screenY = Math.round(pos.y + event.clientY * factor);
    void invoke("show_pin_menu", {
      sourceLabel: pinWindow.label,
      x: screenX,
      y: screenY,
    }).catch(console.error);
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
    </div>
  );
}
