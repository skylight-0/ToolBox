import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
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
  const rectRef = useRef<CropRect | null>(null);
  const payloadRef = useRef<ActiveScreenshotPayload | null>(null);
  const busyRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 复用 ImageData 缓冲区，避免每次唤出分配 ~14MB 导致 GC 卡顿
  const imageDataRef = useRef<ImageData | null>(null);
  // 复用 ArrayBuffer 接收缓冲区，避免每次 fetch 分配新 14MB
  const recvBufferRef = useRef<Uint8Array | null>(null);

  const commitRect = useCallback((next: CropRect | null) => {
    rectRef.current = next;
    setRect(next);
  }, []);

  const applyPayload = useCallback(async (data: ActiveScreenshotPayload) => {
    const t0 = performance.now();
    console.log(`[perf] 收到 payload frameId=${data.frameId}`);
    payloadRef.current = data;
    setPayload(data);
    commitRect(null);
    setImageReady(false);
    // 每次收到新截图时重置 busy，避免上一次操作遗留的 busy 状态导致按钮禁用
    busyRef.current = false;
    setBusy(false);
    // 直接拉取原始 RGBA 字节，用 putImageData 绘制，跳过 PNG 编/解码
    // 复用接收缓冲区和 ImageData，避免每次分配 ~28MB 导致 GC 卡顿
    try {
      const tFetch = performance.now();
      const response = await fetch(
        `http://screenshot-frame.localhost/active?v=${data.frameId}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const expectedSize = data.physicalWidth * data.physicalHeight * 4;
      // 复用接收缓冲区，尺寸变化时才重新分配
      if (!recvBufferRef.current || recvBufferRef.current.length < expectedSize) {
        recvBufferRef.current = new Uint8Array(expectedSize);
      }
      const recv = recvBufferRef.current;
      const reader = response.body?.getReader();
      if (reader) {
        let offset = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          recv.set(value, offset);
          offset += value.length;
        }
      } else {
        // fallback：不支持流式时用 arrayBuffer
        const buf = await response.arrayBuffer();
        recv.set(new Uint8Array(buf), 0);
      }
      console.log(`[perf] fetch 完成 耗时=${(performance.now() - tFetch).toFixed(1)}ms`);
      const tRender = performance.now();
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = data.physicalWidth;
        canvas.height = data.physicalHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          // 复用 ImageData，尺寸变化时才重新分配
          if (
            !imageDataRef.current ||
            imageDataRef.current.width !== data.physicalWidth ||
            imageDataRef.current.height !== data.physicalHeight
          ) {
            imageDataRef.current = new ImageData(
              data.physicalWidth,
              data.physicalHeight,
            );
          }
          const imageData = imageDataRef.current;
          // 直接从接收缓冲区拷贝到 ImageData
          new Uint8Array(imageData.data.buffer).set(
            recv.subarray(0, expectedSize),
          );
          ctx.putImageData(imageData, 0, 0);
        }
      }
      setImageReady(true);
      console.log(`[perf] putImageData 完成 耗时=${(performance.now() - tRender).toFixed(1)}ms`);
      console.log(`[perf] 背景渲染就绪 总耗时=${(performance.now() - t0).toFixed(1)}ms`);
    } catch (loadError) {
      setError(`加载截图失败: ${String(loadError)}`);
    }
  }, [commitRect]);

  // 监听 Rust 推送过来的截图数据；overlay 常驻后由事件驱动刷新
  useEffect(() => {
    let unlistenPayload: (() => void) | undefined;
    let unlistenReset: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const [unsubscribePayload, unsubscribeReset] = await Promise.all([
        listen<ActiveScreenshotPayload>("screenshot-payload", (event) => {
          if (!cancelled) void applyPayload(event.payload);
        }),
        listen<void>("screenshot-reset", () => {
          if (cancelled) return;
          setPayload(null);
          setRect(null);
          setPointer(null);
          setImageReady(false);
          setError("");
          setBusy(false);
          drawingRef.current = null;
          rectRef.current = null;
          payloadRef.current = null;
          busyRef.current = false;
          imageDataRef.current = null;
          recvBufferRef.current = null;
        }),
      ]);
      unlistenPayload = unsubscribePayload;
      unlistenReset = unsubscribeReset;
    })().catch((listenError) => {
      if (!cancelled) setError(`监听截图事件失败: ${String(listenError)}`);
    });
    return () => {
      cancelled = true;
      unlistenPayload?.();
      unlistenReset?.();
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
      try {
        // Rust 会移动 overlay 并通过 screenshot-payload 事件回推新屏数据
        await invoke("switch_screenshot_monitor", { direction });
      } catch (switchError) {
        setError(String(switchError));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [],
  );

  const finish = useCallback(
    async (action: "copy" | "save" | "pin") => {
      if (busyRef.current) return;
      const activeRect = rectRef.current;
      const activePayload = payloadRef.current;
      if (!activeRect || !activePayload) return;
      busyRef.current = true;
      setBusy(true);
      const tFinish = performance.now();
      console.log(`[perf] 点击${action} 按下`);
      try {
        const tInvoke = performance.now();
        await invoke("apply_screenshot_action", {
          payload: {
            action,
            rect: {
              x: activeRect.x,
              y: activeRect.y,
              w: activeRect.w,
              h: activeRect.h,
            },
          },
        });
        console.log(`[perf] invoke 完成 耗时=${(performance.now() - tInvoke).toFixed(1)}ms`);
        // save 动作由 Rust 端自行隐藏 overlay 弹对话框，
        // 无论成功/取消都需关闭会话；其余动作 fire-and-forget 关闭，减少 IPC 往返等待
        void cancel();
        console.log(`[perf] ${action} 全流程完成 总耗时=${(performance.now() - tFinish).toFixed(1)}ms`);
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

  useEffect(() => {
    const onWindowBlur = () => {
      // 失焦时若仍在绘图状态，丢弃当前选区，避免悬浮状态
      drawingRef.current = null;
    };
    overlayWindow.onFocusChanged(({ payload: focused }) => {
      if (!focused) onWindowBlur();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      onContextMenu={(event) => {
        event.preventDefault();
        void cancel();
      }}
    >
      <canvas ref={canvasRef} className="screenshot-bg" />

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