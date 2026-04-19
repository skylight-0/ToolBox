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

type RectShape = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ScreenshotTool = "freehand" | "rect" | "arrow" | "text" | "crop";

type FreehandAnnotation = {
  id: string;
  kind: "freehand";
  color: string;
  width: number;
  points: Point[];
};

type RectAnnotation = {
  id: string;
  kind: "rect";
  color: string;
  width: number;
  shape: RectShape;
};

type ArrowAnnotation = {
  id: string;
  kind: "arrow";
  color: string;
  width: number;
  from: Point;
  to: Point;
};

type TextAnnotation = {
  id: string;
  kind: "text";
  color: string;
  fontSize: number;
  position: Point;
  text: string;
};

type Annotation =
  | FreehandAnnotation
  | RectAnnotation
  | ArrowAnnotation
  | TextAnnotation;

type DraftAnnotation =
  | Omit<FreehandAnnotation, "id">
  | Omit<RectAnnotation, "id">
  | Omit<ArrowAnnotation, "id">;

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function createId() {
  return Date.now().toString() + Math.random().toString(36).slice(2);
}

function normalizeRect(start: Point, end: Point): RectShape {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function ScreenshotEditorView({
  onBack,
  refreshToken,
  isDialogOpenRef,
}: ScreenshotEditorViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDrawingRef = useRef(false);
  const draftStartRef = useRef<Point | null>(null);

  const [baseImage, setBaseImage] = useState("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [draftAnnotation, setDraftAnnotation] = useState<DraftAnnotation | null>(null);
  const [cropSelection, setCropSelection] = useState<RectShape | null>(null);
  const [tool, setTool] = useState<ScreenshotTool>("freehand");
  const [brushColor, setBrushColor] = useState("#ff4d4f");
  const [brushWidth, setBrushWidth] = useState(4);
  const [fontSize, setFontSize] = useState(28);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const fetchScreenshot = async () => {
      setIsLoading(true);
      try {
        const dataUrl = await invoke<string>("get_latest_screenshot");
        setBaseImage(dataUrl);
        setAnnotations([]);
        setDraftAnnotation(null);
        setCropSelection(null);
        setTool("freehand");
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

      const drawArrowHead = (
        context: CanvasRenderingContext2D,
        from: Point,
        to: Point,
        color: string,
        width: number,
      ) => {
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const headLength = Math.max(10, width * 3);
        context.strokeStyle = color;
        context.lineWidth = width;
        context.beginPath();
        context.moveTo(to.x, to.y);
        context.lineTo(
          to.x - headLength * Math.cos(angle - Math.PI / 6),
          to.y - headLength * Math.sin(angle - Math.PI / 6),
        );
        context.moveTo(to.x, to.y);
        context.lineTo(
          to.x - headLength * Math.cos(angle + Math.PI / 6),
          to.y - headLength * Math.sin(angle + Math.PI / 6),
        );
        context.stroke();
      };

      const drawAnnotation = (annotation: Annotation | DraftAnnotation) => {
        switch (annotation.kind) {
          case "freehand": {
            if (annotation.points.length < 2) return;
            ctx.strokeStyle = annotation.color;
            ctx.lineWidth = annotation.width;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(annotation.points[0].x, annotation.points[0].y);
            for (const point of annotation.points.slice(1)) {
              ctx.lineTo(point.x, point.y);
            }
            ctx.stroke();
            return;
          }
          case "rect": {
            ctx.strokeStyle = annotation.color;
            ctx.lineWidth = annotation.width;
            ctx.strokeRect(
              annotation.shape.x,
              annotation.shape.y,
              annotation.shape.width,
              annotation.shape.height,
            );
            return;
          }
          case "arrow": {
            ctx.strokeStyle = annotation.color;
            ctx.lineWidth = annotation.width;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(annotation.from.x, annotation.from.y);
            ctx.lineTo(annotation.to.x, annotation.to.y);
            ctx.stroke();
            drawArrowHead(ctx, annotation.from, annotation.to, annotation.color, annotation.width);
            return;
          }
          case "text": {
            ctx.fillStyle = annotation.color;
            ctx.font = `${annotation.fontSize}px "Segoe UI", sans-serif`;
            ctx.textBaseline = "top";
            const lines = annotation.text.split("\n");
            lines.forEach((line, index) => {
              ctx.fillText(
                line,
                annotation.position.x,
                annotation.position.y + index * (annotation.fontSize + 4),
              );
            });
          }
        }
      };

      annotations.forEach(drawAnnotation);
      if (draftAnnotation) {
        drawAnnotation(draftAnnotation);
      }

      if (cropSelection) {
        ctx.save();
        ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.clearRect(
          cropSelection.x,
          cropSelection.y,
          cropSelection.width,
          cropSelection.height,
        );
        ctx.strokeStyle = "#60CDFF";
        ctx.lineWidth = 2;
        ctx.strokeRect(
          cropSelection.x,
          cropSelection.y,
          cropSelection.width,
          cropSelection.height,
        );
        ctx.restore();
      }
    };

    draw().catch(() => {});
  }, [annotations, baseImage, cropSelection, draftAnnotation]);

  const getCanvasPoint = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  };

  const handleCanvasMouseDown = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!baseImage) return;

    const point = getCanvasPoint(event);

    if (tool === "text") {
      const text = window.prompt("输入要标注的文字");
      if (!text || !text.trim()) return;

      setAnnotations((current) => [
        ...current,
        {
          id: createId(),
          kind: "text",
          color: brushColor,
          fontSize,
          position: point,
          text: text.trim(),
        },
      ]);
      return;
    }

    isDrawingRef.current = true;
    draftStartRef.current = point;

    if (tool === "freehand") {
      setDraftAnnotation({
        kind: "freehand",
        color: brushColor,
        width: brushWidth,
        points: [point, point],
      });
      return;
    }

    if (tool === "rect") {
      setDraftAnnotation({
        kind: "rect",
        color: brushColor,
        width: brushWidth,
        shape: normalizeRect(point, point),
      });
      return;
    }

    if (tool === "arrow") {
      setDraftAnnotation({
        kind: "arrow",
        color: brushColor,
        width: brushWidth,
        from: point,
        to: point,
      });
      return;
    }

    if (tool === "crop") {
      setCropSelection(normalizeRect(point, point));
    }
  };

  const handleCanvasMouseMove = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || !draftStartRef.current) return;
    const point = getCanvasPoint(event);

    if (tool === "freehand") {
      setDraftAnnotation((current) =>
        current && current.kind === "freehand"
          ? { ...current, points: [...current.points, point] }
          : current,
      );
      return;
    }

    if (tool === "rect") {
      setDraftAnnotation((current) =>
        current && current.kind === "rect"
          ? { ...current, shape: normalizeRect(draftStartRef.current as Point, point) }
          : current,
      );
      return;
    }

    if (tool === "arrow") {
      setDraftAnnotation((current) =>
        current && current.kind === "arrow" ? { ...current, to: point } : current,
      );
      return;
    }

    if (tool === "crop") {
      setCropSelection(normalizeRect(draftStartRef.current, point));
    }
  };

  const handleCanvasMouseUp = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    draftStartRef.current = null;

    if (tool === "crop") {
      setDraftAnnotation(null);
      return;
    }

    setDraftAnnotation((current) => {
      if (!current) return null;
      setAnnotations((existing) => [...existing, { ...current, id: createId() } as Annotation]);
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

  const applyCrop = async () => {
    if (!cropSelection) return;

    try {
      const image = await loadImage(await exportImage());
      const offscreenCanvas = document.createElement("canvas");
      offscreenCanvas.width = Math.max(1, Math.round(cropSelection.width));
      offscreenCanvas.height = Math.max(1, Math.round(cropSelection.height));
      const ctx = offscreenCanvas.getContext("2d");
      if (!ctx) throw new Error("裁剪失败");

      ctx.drawImage(
        image,
        cropSelection.x,
        cropSelection.y,
        cropSelection.width,
        cropSelection.height,
        0,
        0,
        offscreenCanvas.width,
        offscreenCanvas.height,
      );

      setBaseImage(offscreenCanvas.toDataURL("image/png"));
      setAnnotations([]);
      setDraftAnnotation(null);
      setCropSelection(null);
      setTool("freehand");
    } catch (err) {
      const message = err instanceof Error ? err.message : "区域裁剪失败";
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

  const toolButtons: Array<{ id: ScreenshotTool; label: string }> = [
    { id: "freehand", label: "画笔" },
    { id: "rect", label: "矩形" },
    { id: "arrow", label: "箭头" },
    { id: "text", label: "文字" },
    { id: "crop", label: "裁剪" },
  ];

  return (
    <div className="sub-view screenshot-view">
      <SubViewHeader title="截图标注" onBack={onBack} actions={actions} />
      <div className="sub-view-content screenshot-editor-container">
        <div className="screenshot-toolbar">
          <div className="screenshot-toolset">
            {toolButtons.map((item) => (
              <button
                key={item.id}
                className={`screenshot-tool-btn ${tool === item.id ? "active" : ""}`}
                onClick={() => setTool(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="screenshot-toolbar-group">
            颜色
            <input
              type="color"
              value={brushColor}
              onChange={(event) => setBrushColor(event.target.value)}
            />
          </label>
          <label className="screenshot-toolbar-group">
            粗细
            <input
              type="range"
              min="2"
              max="18"
              value={brushWidth}
              onChange={(event) => setBrushWidth(Number(event.target.value))}
            />
            <span>{brushWidth}px</span>
          </label>
          <label className="screenshot-toolbar-group">
            字号
            <input
              type="range"
              min="16"
              max="48"
              value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))}
            />
            <span>{fontSize}px</span>
          </label>
          <button className="screenshot-top-btn ghost" onClick={() => setAnnotations([])}>
            清空标注
          </button>
          <button
            className="screenshot-top-btn ghost"
            onClick={() => setAnnotations((current) => current.slice(0, -1))}
          >
            撤销一步
          </button>
          <button
            className="screenshot-top-btn ghost"
            onClick={() => setCropSelection(null)}
            disabled={!cropSelection}
          >
            清除选区
          </button>
          <button className="screenshot-top-btn" onClick={applyCrop} disabled={!cropSelection}>
            裁剪到选区
          </button>
        </div>

        {error && <div className="hardware-monitor-error">{error}</div>}

        <div className="screenshot-editor-stage" ref={containerRef}>
          {isLoading ? (
            <div className="screenshot-editor-empty">正在读取截图...</div>
          ) : baseImage ? (
            <canvas
              ref={canvasRef}
              className={`screenshot-canvas tool-${tool}`}
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseUp}
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
