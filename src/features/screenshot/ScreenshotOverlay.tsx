import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  cropToClipboardImage,
  cropToDataUrl,
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
  const [imageReady, setImageReady] = useState(false);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const drawingRef = useRef<{ x: number; y: number } | null>(null);
  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const rectRef = useRef<CropRect | null>(null);
  const payloadRef = useRef<ActiveScreenshotPayload | null>(null);
  const busyRef = useRef(false);

  const commitRect = useCallback((next: CropRect | null) => {
    rectRef.current = next;
    setRect(next);
  }, []);

  useEffect(() => {
    overlayWindow.show().catch(console.error);
    let cancelled = false;
    invoke<ActiveScreenshotPayload>("get_active_screenshot")
      .then(async (data) => {
        if (cancelled) return;
        payloadRef.current = data;
        setPayload(data);
        const image = await loadImage(data.imageDataUrl);
        if (cancelled) return;
        sourceImageRef.current = image;
        setImageReady(true);
      })
      .catch((invokeError) => {
        if (!cancelled) setError(String(invokeError));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = useCallback(async () => {
    await invoke("cancel_screenshot").catch(console.error);
  }, []);

  const switchMonitor = useCallback(
    async (direction: number) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setImageReady(false);
      commitRect(null);
      try {
        const next = await invoke<ActiveScreenshotPayload>("switch_screenshot_monitor", {
          direction,
        });
        payloadRef.current = next;
        setPayload(next);
        const image = await loadImage(next.imageDataUrl);
        sourceImageRef.current = image;
        setImageReady(true);
      } catch (switchError) {
        setError(String(switchError));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [commitRect],
  );

  const finish = useCallback(
    async (action: "copy" | "save" | "pin") => {
      if (busyRef.current) return;
      const activeRect = rectRef.current;
      const source = sourceImageRef.current;
      const activePayload = payloadRef.current;
      if (!activeRect || !source || !activePayload) return;
      busyRef.current = true;
      setBusy(true);
      try {
        if (action === "copy") {
          const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
          const image = await cropToClipboardImage(source, activePayload.scaleFactor, activeRect);
          await writeImage(image);
          await image.close().catch(() => {});
        } else if (action === "save") {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: `screenshot-${Date.now()}.png`,
            filters: [{ name: "PNG", extensions: ["png"] }],
          });
          if (!path) {
            busyRef.current = false;
            setBusy(false);
            return;
          }
          const dataUrl = await cropToDataUrl(source, activePayload.scaleFactor, activeRect);
          await invoke("save_image_data", { path, dataUrl });
        } else {
          const sf = activePayload.scaleFactor;
          const dataUrl = await cropToDataUrl(source, activePayload.scaleFactor, activeRect);
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
    [cancel],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void cancel();
      } else if (event.key === "Enter") {
        void finish("copy");
      } else if (event.key === "ArrowLeft") {
        void switchMonitor(-1);
      } else if (event.key === "ArrowRight") {
        void switchMonitor(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, finish, switchMonitor]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".screenshot-no-draw")) return;
    const x = event.clientX;
    const y = event.clientY;
    drawingRef.current = { x, y };
    commitRect({ x, y, w: 0, h: 0 });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    setPointer({ x: event.clientX, y: event.clientY });
    const start = drawingRef.current;
    if (!start) return;
    commitRect(normalizeRect(start.x, start.y, event.clientX, event.clientY));
  };

  const onPointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = null;
    const current = rectRef.current;
    if (current && (current.w < 4 || current.h < 4)) {
      commitRect(null);
    }
  };

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

  const hasSelection = !!rect && rect.w >= 4 && rect.h >= 4;
  const logicalWidth = payload?.logicalWidth ?? window.innerWidth;
  const logicalHeight = payload?.logicalHeight ?? window.innerHeight;
  const scaleFactor = payload?.scaleFactor ?? 1;

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
        className="screenshot-bg"
        src={payload?.imageDataUrl ?? ""}
        draggable={false}
        onLoad={() => setImageReady(true)}
      />

      {!imageReady && <div className="screenshot-dim" />}

      {imageReady && !hasSelection && <div className="screenshot-dim" />}

      {imageReady && hasSelection && rect && (
        <>
          <div
            className="screenshot-mask-band"
            style={{ left: 0, top: 0, width: "100%", height: Math.max(0, rect.y) }}
          />
          <div
            className="screenshot-mask-band"
            style={{
              left: 0,
              top: rect.y + rect.h,
              width: "100%",
              height: Math.max(0, logicalHeight - rect.y - rect.h),
            }}
          />
          <div
            className="screenshot-mask-band"
            style={{ left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h }}
          />
          <div
            className="screenshot-mask-band"
            style={{
              left: rect.x + rect.w,
              top: rect.y,
              width: Math.max(0, logicalWidth - rect.x - rect.w),
              height: rect.h,
            }}
          />
        </>
      )}

      {imageReady && !hasSelection && pointer && (
        <>
          <div className="screenshot-crosshair-h" style={{ top: pointer.y }} />
          <div className="screenshot-crosshair-v" style={{ left: pointer.x }} />
        </>
      )}

      {imageReady && hasSelection && rect && (
        <div
          className="screenshot-rect"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          <span className="screenshot-size">
            {Math.round(rect.w * scaleFactor)} × {Math.round(rect.h * scaleFactor)}
          </span>
        </div>
      )}

      {imageReady && hasSelection && rect && (
        <div
          className="screenshot-toolbar screenshot-no-draw"
          style={{ left: toolbarLeft, top: toolbarTop }}
          onPointerDown={(event) => event.stopPropagation()}
        >
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

      {imageReady && payload && payload.monitorCount > 1 && (
        <div
          className="screenshot-monitor-switch screenshot-no-draw"
          onPointerDown={(event) => event.stopPropagation()}
        >
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

      {imageReady && !hasSelection && (
        <div className="screenshot-hint">
          拖拽选择区域 · Enter 复制 · Esc 取消
          {payload && payload.monitorCount > 1 ? " · ← → 切换屏幕" : ""}
        </div>
      )}
    </div>
  );
}
