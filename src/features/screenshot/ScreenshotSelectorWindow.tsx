import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

type Point = {
  x: number;
  y: number;
};

type RectShape = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function normalizeRect(start: Point, end: Point): RectShape {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function ScreenshotSelectorWindow() {
  const imageRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef<Point | null>(null);
  const draggingRef = useRef(false);

  const [imageData, setImageData] = useState("");
  const [selection, setSelection] = useState<RectShape | null>(null);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    invoke<string>("get_latest_screenshot")
      .then(setImageData)
      .catch((err) => {
        const message = err instanceof Error ? err.message : "读取截图失败";
        setError(message);
      });
  }, []);

  const getImageMetrics = () => {
    const image = imageRef.current;
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height || !image.naturalWidth || !image.naturalHeight) return null;
    return {
      rect,
      scaleX: image.naturalWidth / rect.width,
      scaleY: image.naturalHeight / rect.height,
    };
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancelSelection();
      } else if (event.key === "Enter") {
        event.preventDefault();
        void confirmSelection();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const getImagePoint = (event: ReactMouseEvent<HTMLDivElement>) => {
    const metrics = getImageMetrics();
    if (!metrics) return null;

    const x = Math.min(Math.max(event.clientX, metrics.rect.left), metrics.rect.right);
    const y = Math.min(Math.max(event.clientY, metrics.rect.top), metrics.rect.bottom);

    return {
      x: (x - metrics.rect.left) * metrics.scaleX,
      y: (y - metrics.rect.top) * metrics.scaleY,
    };
  };

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const point = getImagePoint(event);
    if (!point) return;
    draggingRef.current = true;
    dragStartRef.current = point;
    setSelection(normalizeRect(point, point));
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !dragStartRef.current) return;
    const point = getImagePoint(event);
    if (!point) return;
    setSelection(normalizeRect(dragStartRef.current, point));
  };

  const handleMouseUp = () => {
    draggingRef.current = false;
    dragStartRef.current = null;
  };

  const confirmSelection = async () => {
    if (!imageData) return;

    setIsSubmitting(true);
    try {
      let nextImage = imageData;

      if (selection && selection.width > 8 && selection.height > 8) {
        const source = new Image();
        source.src = imageData;
        await new Promise<void>((resolve, reject) => {
          source.onload = () => resolve();
          source.onerror = () => reject(new Error("截图载入失败"));
        });

        const canvas = document.createElement("canvas");
        canvas.width = Math.round(selection.width);
        canvas.height = Math.round(selection.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("无法创建裁剪画布");

        ctx.drawImage(
          source,
          selection.x,
          selection.y,
          selection.width,
          selection.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        nextImage = canvas.toDataURL("image/png");
      }

      await invoke("confirm_screenshot_capture", { dataUrl: nextImage });
    } catch (err) {
      const message = err instanceof Error ? err.message : "区域截图失败";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancelSelection = async () => {
    await invoke("cancel_screenshot_capture");
  };

  const selectionStyle = (() => {
    const imageMetrics = getImageMetrics();
    if (!selection || !imageMetrics) return undefined;
    return {
      left: `${selection.x / imageMetrics.scaleX}px`,
      top: `${selection.y / imageMetrics.scaleY}px`,
      width: `${selection.width / imageMetrics.scaleX}px`,
      height: `${selection.height / imageMetrics.scaleY}px`,
    };
  })();

  return (
    <div className="screenshot-selector-root">
      <div className="screenshot-selector-toolbar">
        <div>
          <div className="screenshot-selector-title">区域截图</div>
          <div className="screenshot-selector-hint">拖出选区后回车确认，Esc 取消</div>
        </div>
        <div className="screenshot-selector-actions">
          <button className="screenshot-top-btn ghost" onClick={cancelSelection} disabled={isSubmitting}>
            取消
          </button>
          <button className="screenshot-top-btn" onClick={confirmSelection} disabled={isSubmitting || !imageData}>
            {selection ? "使用选区" : "整屏继续"}
          </button>
        </div>
      </div>

      {error && <div className="hardware-monitor-error">{error}</div>}

      <div
        className="screenshot-selector-stage"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {imageData ? (
          <div className="screenshot-selector-image-wrap">
            <img
              ref={imageRef}
              className="screenshot-selector-image"
              src={imageData}
              alt="截图选区"
              draggable={false}
            />
            <div className="screenshot-selector-mask" />
            {selectionStyle && <div className="screenshot-selector-box" style={selectionStyle} />}
          </div>
        ) : (
          <div className="screenshot-editor-empty">正在准备截图...</div>
        )}
      </div>
    </div>
  );
}

export default ScreenshotSelectorWindow;
