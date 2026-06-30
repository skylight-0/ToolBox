import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  cropToDataUrl,
  dataUrlToBytes,
  loadImage,
  normalizeRect,
  type ActiveScreenshotPayload,
  type CropRect,
} from "./screenshotModel";

export default function ScreenshotOverlay() {
  const overlayWindow = getCurrentWebviewWindow();
  const [payload, setPayload] = useState<ActiveScreenshotPayload | null>(null);
  const [error, setError] = useState("");
  const [rect, setRect] = useState<CropRect | null>(null);
  const [busy, setBusy] = useState(false);
  const drawingRef = useRef<{ x: number; y: number } | null>(null);
  const imageElRef = useRef<HTMLImageElement | null>(null);
  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const shownRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    invoke<ActiveScreenshotPayload>("get_active_screenshot")
      .then(async (data) => {
        if (cancelled) return;
        setPayload(data);
        const image = await loadImage(data.imageDataUrl);
        if (cancelled) return;
        sourceImageRef.current = image;
      })
      .catch((invokeError) => {
        if (!cancelled) setError(String(invokeError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showOverlay = useCallback(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    overlayWindow.show().catch(console.error);
  }, [overlayWindow]);

  const cancel = useCallback(async () => {
    await invoke("cancel_screenshot").catch(console.error);
  }, []);

  const switchMonitor = useCallback(
    async (direction: number) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setRect(null);
      try {
        const next = await invoke<ActiveScreenshotPayload>("switch_screenshot_monitor", {
          direction,
        });
        setPayload(next);
        sourceImageRef.current = await loadImage(next.imageDataUrl);
      } catch (switchError) {
        setError(String(switchError));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void cancel();
      } else if (event.key === "Enter") {
        void confirmCopy();
      } else if (event.key === "ArrowLeft") {
        void switchMonitor(-1);
      } else if (event.key === "ArrowRight") {
        void switchMonitor(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancel, switchMonitor, rect, payload]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drawingRef.current = { x: event.clientX, y: event.clientY };
    setRect({ x: event.clientX, y: event.clientY, w: 0, h: 0 });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drawingRef.current;
    if (!start) return;
    setRect(normalizeRect(start.x, start.y, event.clientX, event.clientY));
  };

  const onPointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = null;
    setRect((current) => {
      if (current && (current.w < 4 || current.h < 4)) return null;
      return current;
    });
  };

  const finish = useCallback(
    async (action: "copy" | "save" | "pin") => {
      if (busyRef.current) return;
      const activeRect = rect;
      const source = sourceImageRef.current;
      const activePayload = payload;
      if (!activeRect || !source || !activePayload) {
        return;
      }
      busyRef.current = true;
      setBusy(true);
      try {
        const dataUrl = await cropToDataUrl(source, activePayload.scaleFactor, activeRect);
        if (action === "copy") {
          const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
          await writeImage(dataUrlToBytes(dataUrl));
        } else if (action === "save") {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: `screenshot-${Date.now()}.png`,
            filters: [{ name: "PNG", extensions: ["png"] }],
          });
          if (path) {
            await invoke("save_image_data", { path, dataUrl });
          } else {
            busyRef.current = false;
            setBusy(false);
            return;
          }
        } else {
          const sf = activePayload.scaleFactor;
          await invoke("create_pin_window", {
            imageDataUrl: dataUrl,
            cropX: Math.round(activeRect.x * sf),
            cropY: Math.round(activeRect.y * sf),
            cropWidth: Math.round(activeRect.w * sf),
            cropHeight: Math.round(activeRect.h * sf),
          });
        }
        await cancel();
      } catch (actionError) {
        setError(String(actionError));
        busyRef.current = false;
        setBusy(false);
      }
    },
    [rect, payload, cancel],
  );

  const confirmCopy = useCallback(() => finish("copy"), [finish]);

  if (error) {
    return (
      <div className="screenshot-overlay screenshot-error">
        <div>截图失败: {error}</div>
        <button className="screenshot-error-btn" onClick={() => void cancel()}>
          关闭
        </button>
      </div>
    );
  }

  if (!payload) {
    return <div className="screenshot-overlay screenshot-loading" />;
  }

  const hasSelection = !!rect && rect.w >= 4 && rect.h >= 4;
  const logicalWidth = payload.logicalWidth;
  const logicalHeight = payload.logicalHeight;

  // 工具栏尽量贴在选区右下方，靠近边缘时翻转到选区内侧
  let toolbarLeft = rect ? rect.x + rect.w : 0;
  let toolbarTop = rect ? rect.y + rect.h + 8 : 0;
  if (rect) {
    if (toolbarTop + 48 > logicalHeight) toolbarTop = Math.max(0, rect.y - 44);
    if (toolbarLeft + 220 > logicalWidth) toolbarLeft = Math.max(0, logicalWidth - 220);
  }

  return (
    <div
      className="screenshot-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <img
        ref={imageElRef}
        className="screenshot-bg"
        src={payload.imageDataUrl}
        draggable={false}
        onLoad={showOverlay}
      />

      {hasSelection && rect && (
        <div
          className="screenshot-rect"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          <span className="screenshot-size">
            {Math.round(rect.w * payload.scaleFactor)} × {Math.round(rect.h * payload.scaleFactor)}
          </span>
        </div>
      )}

      {hasSelection && rect && (
        <div className="screenshot-toolbar" style={{ left: toolbarLeft, top: toolbarTop }}>
          <button disabled={busy} onClick={() => void finish("copy")}>
            复制
          </button>
          <button disabled={busy} onClick={() => void finish("save")}>
            保存
          </button>
          <button disabled={busy} onClick={() => void finish("pin")}>
            钉图
          </button>
          <button disabled={busy} onClick={() => void cancel()}>
            取消
          </button>
        </div>
      )}

      {payload.monitorCount > 1 && (
        <div className="screenshot-monitor-switch">
          <button onClick={() => void switchMonitor(-1)} disabled={busy}>
            ◀
          </button>
          <span>
            {payload.monitorIndex + 1} / {payload.monitorCount}
          </span>
          <button onClick={() => void switchMonitor(1)} disabled={busy}>
            ▶
          </button>
        </div>
      )}

      {!hasSelection && (
        <div className="screenshot-hint">
          拖拽选择区域 · Enter 复制 · Esc 取消{payload.monitorCount > 1 ? " · ← → 切换屏幕" : ""}
        </div>
      )}
    </div>
  );
}
