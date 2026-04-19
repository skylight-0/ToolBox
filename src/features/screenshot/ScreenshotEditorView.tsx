import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import SubViewHeader from "../../components/SubViewHeader";

type ScreenshotEditorViewProps = {
  onBack: () => void;
  refreshToken: number;
  isDialogOpenRef: MutableRefObject<boolean>;
};

type Point = {
  x: number;
  y: number;
};

type Stroke = {
  color: string;
  width: number;
  points: Point[];
};

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function ScreenshotEditorView({
  onBack,
  refreshToken,
  isDialogOpenRef,
}: ScreenshotEditorViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDrawingRef = useRef(false);
  const [baseImage, setBaseImage] = useState("");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<Stroke | null>(null);
  const [brushColor, setBrushColor] = useState("#ff4d4f");
  const [brushWidth, setBrushWidth] = useState(4);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const fetchScreenshot = async () => {
      setIsLoading(true);
      try {
        const dataUrl = await invoke<string>("get_latest_screenshot");
        setBaseImage(dataUrl);
        setStrokes([]);
        setActiveStroke(null);
        setError("");
      } catch (err) {
        const message = err instanceof Error ? err.message : "读取截图失败";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchScreenshot();
  }, [refreshToken]);

  useEffect(() => {
    const draw = async () => {
      if (!baseImage || !canvasRef.current || !containerRef.current) return;

      const image = await loadImage(baseImage);
      const container = containerRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const nextScale = Math.min(1, container.clientWidth / image.width || 1);
      setScale(nextScale);
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.style.width = `${image.width * nextScale}px`;
      canvas.style.height = `${image.height * nextScale}px`;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);

      const drawStroke = (stroke: Stroke) => {
        if (stroke.points.length < 2) return;
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (const point of stroke.points.slice(1)) {
          ctx.lineTo(point.x, point.y);
        }
        ctx.stroke();
      };

      strokes.forEach(drawStroke);
      if (activeStroke) {
        drawStroke(activeStroke);
      }
    };

    draw().catch(() => {});
  }, [activeStroke, baseImage, strokes]);

  const getCanvasPoint = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  };

  const startStroke = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!baseImage) return;
    isDrawingRef.current = true;
    const point = getCanvasPoint(event);
    setActiveStroke({
      color: brushColor,
      width: brushWidth,
      points: [point, point],
    });
  };

  const extendStroke = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const point = getCanvasPoint(event);
    setActiveStroke((current) =>
      current ? { ...current, points: [...current.points, point] } : current,
    );
  };

  const finishStroke = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    setActiveStroke((current) => {
      if (current && current.points.length > 1) {
        setStrokes((existing) => [...existing, current]);
      }
      return null;
    });
  };

  const exportImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("截图画布不可用");
    return canvas.toDataURL("image/png");
  };

  const copyImage = async () => {
    try {
      const dataUrl = await exportImage();
      const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
      const base64Data = dataUrl.split(",")[1];
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i += 1) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      await writeImage(bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : "复制截图失败";
      setError(message);
    }
  };

  const saveImage = async () => {
    isDialogOpenRef.current = true;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = await save({
        title: "保存截图",
        defaultPath: `toolbox-screenshot-${Date.now()}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (!target) return;

      const dataUrl = await exportImage();
      await invoke("save_image_data", { path: target, dataUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : "保存截图失败";
      setError(message);
    } finally {
      isDialogOpenRef.current = false;
    }
  };

  const pinImage = async () => {
    try {
      const dataUrl = await exportImage();
      await invoke("open_pinned_image_window", { dataUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : "钉图失败";
      setError(message);
    }
  };

  const recapture = async () => {
    try {
      await invoke("capture_screenshot");
    } catch (err) {
      const message = err instanceof Error ? err.message : "重新截图失败";
      setError(message);
    }
  };

  const actions = (
    <div className="screenshot-actions">
      <button className="screenshot-top-btn ghost" onClick={recapture}>
        重新截图
      </button>
      <button className="screenshot-top-btn ghost" onClick={copyImage}>
        复制
      </button>
      <button className="screenshot-top-btn ghost" onClick={saveImage}>
        保存
      </button>
      <button className="screenshot-top-btn" onClick={pinImage}>
        钉到最上层
      </button>
    </div>
  );

  return (
    <div className="sub-view screenshot-view">
      <SubViewHeader title="截图标注" onBack={onBack} actions={actions} />
      <div className="sub-view-content screenshot-editor-container">
        <div className="screenshot-toolbar">
          <label className="screenshot-toolbar-group">
            颜色
            <input
              type="color"
              value={brushColor}
              onChange={(event) => setBrushColor(event.target.value)}
            />
          </label>
          <label className="screenshot-toolbar-group">
            线宽
            <input
              type="range"
              min="2"
              max="18"
              value={brushWidth}
              onChange={(event) => setBrushWidth(Number(event.target.value))}
            />
            <span>{brushWidth}px</span>
          </label>
          <button className="screenshot-top-btn ghost" onClick={() => setStrokes([])}>
            清空标注
          </button>
          <button
            className="screenshot-top-btn ghost"
            onClick={() => setStrokes((current) => current.slice(0, -1))}
          >
            撤销一步
          </button>
        </div>

        {error && <div className="hardware-monitor-error">{error}</div>}

        <div className="screenshot-editor-stage" ref={containerRef}>
          {isLoading ? (
            <div className="screenshot-editor-empty">正在读取截图...</div>
          ) : baseImage ? (
            <canvas
              ref={canvasRef}
              className="screenshot-canvas"
              onMouseDown={startStroke}
              onMouseMove={extendStroke}
              onMouseUp={finishStroke}
              onMouseLeave={finishStroke}
            />
          ) : (
            <div className="screenshot-editor-empty">还没有截图，点击“重新截图”开始。</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ScreenshotEditorView;
