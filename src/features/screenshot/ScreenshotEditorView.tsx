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

type ScreenshotTool =
  | "select"
  | "freehand"
  | "eraser"
  | "rect"
  | "highlight"
  | "mosaic"
  | "arrow"
  | "text"
  | "crop";

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

type HighlightAnnotation = {
  id: string;
  kind: "highlight";
  color: string;
  shape: RectShape;
  opacity: number;
};

type MosaicAnnotation = {
  id: string;
  kind: "mosaic";
  shape: RectShape;
  blockSize: number;
};

type EraserAnnotation = {
  id: string;
  kind: "eraser";
  width: number;
  points: Point[];
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
  | EraserAnnotation
  | RectAnnotation
  | HighlightAnnotation
  | MosaicAnnotation
  | ArrowAnnotation
  | TextAnnotation;

type DraftAnnotation =
  | Omit<FreehandAnnotation, "id">
  | Omit<EraserAnnotation, "id">
  | Omit<RectAnnotation, "id">
  | Omit<HighlightAnnotation, "id">
  | Omit<MosaicAnnotation, "id">
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

function clampRect(shape: RectShape) {
  return {
    ...shape,
    width: Math.max(1, shape.width),
    height: Math.max(1, shape.height),
  };
}

function normalizeRect(start: Point, end: Point): RectShape {
  return clampRect({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  });
}

function pointInRect(point: Point, shape: RectShape, padding = 0) {
  return (
    point.x >= shape.x - padding &&
    point.x <= shape.x + shape.width + padding &&
    point.y >= shape.y - padding &&
    point.y <= shape.y + shape.height + padding
  );
}

function getPointsBounds(points: Point[], padding = 0): RectShape | null {
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - padding;
  const maxX = Math.max(...xs) + padding;
  const minY = Math.min(...ys) - padding;
  const maxY = Math.max(...ys) + padding;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function getArrowBounds(annotation: ArrowAnnotation): RectShape {
  const padding = Math.max(12, annotation.width * 3);
  return normalizeRect(
    { x: annotation.from.x - padding, y: annotation.from.y - padding },
    { x: annotation.to.x + padding, y: annotation.to.y + padding },
  );
}

function getTextBounds(
  ctx: CanvasRenderingContext2D,
  annotation: TextAnnotation,
): RectShape {
  ctx.save();
  ctx.font = `${annotation.fontSize}px "Segoe UI", sans-serif`;
  const lines = annotation.text.split("\n");
  const maxWidth = Math.max(...lines.map((line) => ctx.measureText(line || " ").width), 1);
  ctx.restore();
  return {
    x: annotation.position.x,
    y: annotation.position.y,
    width: maxWidth,
    height: lines.length * (annotation.fontSize + 4),
  };
}

function getAnnotationBounds(
  ctx: CanvasRenderingContext2D,
  annotation: Annotation,
): RectShape | null {
  switch (annotation.kind) {
    case "freehand":
    case "eraser":
      return getPointsBounds(annotation.points, annotation.width);
    case "rect":
    case "highlight":
    case "mosaic":
      return clampRect(annotation.shape);
    case "arrow":
      return getArrowBounds(annotation);
    case "text":
      return getTextBounds(ctx, annotation);
    default:
      return null;
  }
}

function movePoint(point: Point, delta: Point): Point {
  return { x: point.x + delta.x, y: point.y + delta.y };
}

function moveAnnotation(annotation: Annotation, delta: Point): Annotation {
  switch (annotation.kind) {
    case "freehand":
    case "eraser":
      return {
        ...annotation,
        points: annotation.points.map((point) => movePoint(point, delta)),
      };
    case "rect":
    case "highlight":
    case "mosaic":
      return {
        ...annotation,
        shape: {
          ...annotation.shape,
          x: annotation.shape.x + delta.x,
          y: annotation.shape.y + delta.y,
        },
      };
    case "arrow":
      return {
        ...annotation,
        from: movePoint(annotation.from, delta),
        to: movePoint(annotation.to, delta),
      };
    case "text":
      return {
        ...annotation,
        position: movePoint(annotation.position, delta),
      };
    default:
      return annotation;
  }
}

function drawArrowHead(
  context: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  width: number,
) {
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
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  annotation: Annotation | DraftAnnotation,
) {
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
    case "eraser": {
      if (annotation.points.length < 2) return;
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = annotation.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(annotation.points[0].x, annotation.points[0].y);
      for (const point of annotation.points.slice(1)) {
        ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
      ctx.restore();
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
    case "highlight": {
      ctx.save();
      ctx.fillStyle = annotation.color;
      ctx.globalAlpha = annotation.opacity;
      ctx.fillRect(
        annotation.shape.x,
        annotation.shape.y,
        annotation.shape.width,
        annotation.shape.height,
      );
      ctx.restore();
      return;
    }
    case "mosaic": {
      const shape = clampRect(annotation.shape);
      const block = Math.max(2, annotation.blockSize);
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = shape.width;
      tempCanvas.height = shape.height;
      const tempCtx = tempCanvas.getContext("2d");
      if (!tempCtx) return;
      tempCtx.drawImage(
        canvas,
        shape.x,
        shape.y,
        shape.width,
        shape.height,
        0,
        0,
        shape.width,
        shape.height,
      );
      const imageData = tempCtx.getImageData(0, 0, shape.width, shape.height);
      const { data } = imageData;
      for (let y = 0; y < shape.height; y += block) {
        for (let x = 0; x < shape.width; x += block) {
          const offset = (y * shape.width + x) * 4;
          const r = data[offset];
          const g = data[offset + 1];
          const b = data[offset + 2];
          tempCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
          tempCtx.fillRect(x, y, block, block);
        }
      }
      ctx.drawImage(tempCanvas, shape.x, shape.y);
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
  const dragAnchorRef = useRef<Point | null>(null);

  const [baseImage, setBaseImage] = useState("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [draftAnnotation, setDraftAnnotation] = useState<DraftAnnotation | null>(null);
  const [cropSelection, setCropSelection] = useState<RectShape | null>(null);
  const [tool, setTool] = useState<ScreenshotTool>("freehand");
  const [brushColor, setBrushColor] = useState("#ff4d4f");
  const [brushWidth, setBrushWidth] = useState(4);
  const [highlightOpacity, setHighlightOpacity] = useState(0.25);
  const [mosaicBlockSize, setMosaicBlockSize] = useState(14);
  const [fontSize, setFontSize] = useState(28);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);

  useEffect(() => {
    const fetchScreenshot = async () => {
      setIsLoading(true);
      try {
        const dataUrl = await invoke<string>("get_latest_screenshot");
        setBaseImage(dataUrl);
        setAnnotations([]);
        setDraftAnnotation(null);
        setCropSelection(null);
        setSelectedAnnotationId(null);
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

      annotations.forEach((annotation) => drawAnnotation(ctx, canvas, annotation));
      if (draftAnnotation) {
        drawAnnotation(ctx, canvas, draftAnnotation);
      }

      if (selectedAnnotationId) {
        const selected = annotations.find((annotation) => annotation.id === selectedAnnotationId);
        const bounds = selected ? getAnnotationBounds(ctx, selected) : null;
        if (bounds) {
          ctx.save();
          ctx.strokeStyle = "#60CDFF";
          ctx.lineWidth = 2;
          ctx.setLineDash([10, 6]);
          ctx.strokeRect(bounds.x - 4, bounds.y - 4, bounds.width + 8, bounds.height + 8);
          ctx.restore();
        }
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
  }, [annotations, baseImage, cropSelection, draftAnnotation, selectedAnnotationId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Delete" || event.key === "Backspace") {
        if (!selectedAnnotationId) return;
        event.preventDefault();
        setAnnotations((current) => current.filter((item) => item.id !== selectedAnnotationId));
        setSelectedAnnotationId(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedAnnotationId]);

  const getCanvasPoint = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  };

  const findAnnotationAtPoint = (point: Point) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return null;

    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      const annotation = annotations[index];
      const bounds = getAnnotationBounds(ctx, annotation);
      if (bounds && pointInRect(point, bounds, 8)) {
        return annotation;
      }
    }

    return null;
  };

  const handleCanvasMouseDown = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!baseImage) return;

    const point = getCanvasPoint(event);

    if (tool === "select") {
      const hit = findAnnotationAtPoint(point);
      setSelectedAnnotationId(hit?.id ?? null);
      setCropSelection(null);
      if (hit) {
        isDrawingRef.current = true;
        dragAnchorRef.current = point;
      }
      return;
    }

    setSelectedAnnotationId(null);

    if (tool === "text") {
      const text = window.prompt("输入要标注的文字");
      if (!text || !text.trim()) return;

      const created = {
        id: createId(),
        kind: "text" as const,
        color: brushColor,
        fontSize,
        position: point,
        text: text.trim(),
      };

      setAnnotations((current) => [
        ...current,
        created,
      ]);
      setSelectedAnnotationId(created.id);
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

    if (tool === "eraser") {
      setDraftAnnotation({
        kind: "eraser",
        width: brushWidth * 2.5,
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

    if (tool === "highlight") {
      setDraftAnnotation({
        kind: "highlight",
        color: brushColor,
        opacity: highlightOpacity,
        shape: normalizeRect(point, point),
      });
      return;
    }

    if (tool === "mosaic") {
      setDraftAnnotation({
        kind: "mosaic",
        blockSize: mosaicBlockSize,
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
    const point = getCanvasPoint(event);

    if (tool === "select" && isDrawingRef.current && dragAnchorRef.current && selectedAnnotationId) {
      const delta = {
        x: point.x - dragAnchorRef.current.x,
        y: point.y - dragAnchorRef.current.y,
      };
      dragAnchorRef.current = point;
      setAnnotations((current) =>
        current.map((annotation) =>
          annotation.id === selectedAnnotationId ? moveAnnotation(annotation, delta) : annotation,
        ),
      );
      return;
    }

    if (!isDrawingRef.current || !draftStartRef.current) return;

    if (tool === "freehand") {
      setDraftAnnotation((current) =>
        current && current.kind === "freehand"
          ? { ...current, points: [...current.points, point] }
          : current,
      );
      return;
    }

    if (tool === "eraser") {
      setDraftAnnotation((current) =>
        current && current.kind === "eraser"
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

    if (tool === "highlight") {
      setDraftAnnotation((current) =>
        current && current.kind === "highlight"
          ? { ...current, shape: normalizeRect(draftStartRef.current as Point, point) }
          : current,
      );
      return;
    }

    if (tool === "mosaic") {
      setDraftAnnotation((current) =>
        current && current.kind === "mosaic"
          ? {
              ...current,
              blockSize: mosaicBlockSize,
              shape: normalizeRect(draftStartRef.current as Point, point),
            }
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
    dragAnchorRef.current = null;

    if (tool === "select" || tool === "crop") {
      setDraftAnnotation(null);
      return;
    }

    setDraftAnnotation((current) => {
      if (!current) return null;
      const created = { ...current, id: createId() } as Annotation;
      setAnnotations((existing) => [...existing, created]);
      setSelectedAnnotationId(created.id);
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
      setSelectedAnnotationId(null);
      setTool("freehand");
    } catch (err) {
      const message = err instanceof Error ? err.message : "区域裁剪失败";
      setError(message);
    }
  };

  const deleteSelectedAnnotation = () => {
    if (!selectedAnnotationId) return;
    setAnnotations((current) => current.filter((annotation) => annotation.id !== selectedAnnotationId));
    setSelectedAnnotationId(null);
  };

  const editSelectedText = () => {
    if (!selectedAnnotationId) return;
    const target = annotations.find(
      (annotation): annotation is TextAnnotation =>
        annotation.id === selectedAnnotationId && annotation.kind === "text",
    );
    if (!target) return;

    const text = window.prompt("编辑文字", target.text);
    if (!text || !text.trim()) return;

    setAnnotations((current) =>
      current.map((annotation) =>
        annotation.id === target.id
          ? {
              ...annotation,
              text: text.trim(),
              color: brushColor,
              fontSize,
            }
          : annotation,
      ),
    );
  };

  const selectedTextAnnotation = annotations.find(
    (annotation): annotation is TextAnnotation =>
      annotation.id === selectedAnnotationId && annotation.kind === "text",
  );

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
    { id: "select", label: "选择" },
    { id: "freehand", label: "画笔" },
    { id: "eraser", label: "橡皮擦" },
    { id: "rect", label: "矩形" },
    { id: "highlight", label: "高亮框" },
    { id: "mosaic", label: "马赛克" },
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
            高亮
            <input
              type="range"
              min="0.1"
              max="0.6"
              step="0.05"
              value={highlightOpacity}
              onChange={(event) => setHighlightOpacity(Number(event.target.value))}
            />
            <span>{Math.round(highlightOpacity * 100)}%</span>
          </label>
          <label className="screenshot-toolbar-group">
            马赛克
            <input
              type="range"
              min="6"
              max="30"
              value={mosaicBlockSize}
              onChange={(event) => setMosaicBlockSize(Number(event.target.value))}
            />
            <span>{mosaicBlockSize}px</span>
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
          <button
            className="screenshot-top-btn ghost"
            onClick={() => {
              setAnnotations([]);
              setSelectedAnnotationId(null);
            }}
          >
            清空标注
          </button>
          <button
            className="screenshot-top-btn ghost"
            onClick={() =>
              setAnnotations((current) => {
                const next = current.slice(0, -1);
                if (!next.some((item) => item.id === selectedAnnotationId)) {
                  setSelectedAnnotationId(null);
                }
                return next;
              })
            }
          >
            撤销一步
          </button>
          <button
            className="screenshot-top-btn ghost"
            onClick={deleteSelectedAnnotation}
            disabled={!selectedAnnotationId}
          >
            删除选中
          </button>
          <button
            className="screenshot-top-btn ghost"
            onClick={editSelectedText}
            disabled={!selectedTextAnnotation}
          >
            编辑文字
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

        {selectedAnnotationId && (
          <div className="screenshot-selection-tip">
            已选中对象，可直接拖动位置，按 Delete 删除
            {selectedTextAnnotation ? "，也可以编辑文字" : ""}
          </div>
        )}

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
