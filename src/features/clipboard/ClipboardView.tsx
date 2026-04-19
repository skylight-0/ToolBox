import { useEffect, useRef, useState } from "react";
import type { MouseEvent, WheelEvent } from "react";
import SubViewHeader from "../../components/SubViewHeader";

type ClipboardViewProps = {
  onBack: () => void;
};

type ClipboardItem = {
  id: string;
  type: "text" | "image";
  content: string;
  timestamp: number;
};

function ClipboardView({ onBack }: ClipboardViewProps) {
  const [clipboardHistory, setClipboardHistory] = useState<ClipboardItem[]>(() => {
    try {
      const saved = localStorage.getItem("toolbox_clipboard_history");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [isMonitoring, setIsMonitoring] = useState(true);
  const [previewItem, setPreviewItem] = useState<ClipboardItem | null>(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const isDraggingPreview = useRef(false);
  const dragStartPreview = useRef({ x: 0, y: 0 });
  const lastClipboardContent = useRef<string>("");

  useEffect(() => {
    localStorage.setItem("toolbox_clipboard_history", JSON.stringify(clipboardHistory));
  }, [clipboardHistory]);

  useEffect(() => {
    if (!isMonitoring) return;

    const checkClipboard = async () => {
      try {
        const { readText, readImage } = await import("@tauri-apps/plugin-clipboard-manager");

        let newText = "";
        try {
          newText = (await readText()) || "";
        } catch {}

        if (newText && newText !== lastClipboardContent.current) {
          lastClipboardContent.current = newText;
          const newItem: ClipboardItem = {
            id: Date.now().toString(),
            type: "text",
            content: newText.slice(0, 10000),
            timestamp: Date.now(),
          };
          setClipboardHistory((current) => {
            const filtered = current.filter(
              (item) => !(item.type === "text" && item.content === newText),
            );
            return [newItem, ...filtered].slice(0, 50);
          });
        }

        try {
          const imageData = await readImage();
          if (!imageData) return;

          const rgba = await imageData.rgba();
          const size = await imageData.size();
          const bytes = new Uint8Array(rgba);
          const canvas = document.createElement("canvas");
          canvas.width = size.width;
          canvas.height = size.height;
          const ctx = canvas.getContext("2d");

          if (!ctx) return;

          const imgData = ctx.createImageData(size.width, size.height);
          imgData.data.set(bytes);
          ctx.putImageData(imgData, 0, 0);
          const imageContent = canvas.toDataURL("image/png");

          if (imageContent !== lastClipboardContent.current) {
            lastClipboardContent.current = imageContent;
            const newItem: ClipboardItem = {
              id: Date.now().toString(),
              type: "image",
              content: imageContent,
              timestamp: Date.now(),
            };
            setClipboardHistory((current) => [newItem, ...current].slice(0, 50));
          }
        } catch {}
      } catch {}
    };

    const interval = window.setInterval(checkClipboard, 800);
    return () => clearInterval(interval);
  }, [isMonitoring]);

  const copyToClipboard = async (item: ClipboardItem) => {
    try {
      const { writeText, writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
      if (item.type === "text") {
        await writeText(item.content);
        lastClipboardContent.current = item.content;
        return;
      }

      const base64Data = item.content.split(",")[1];
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i += 1) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      await writeImage(bytes);
      lastClipboardContent.current = item.content;
    } catch {}
  };

  const deleteClipboardItem = (id: string, event: MouseEvent) => {
    event.stopPropagation();
    setClipboardHistory((current) => current.filter((item) => item.id !== id));
  };

  const clearClipboardHistory = () => {
    setClipboardHistory([]);
  };

  const closePreview = () => {
    setPreviewItem(null);
    setPreviewZoom(1);
    setPreviewPan({ x: 0, y: 0 });
  };

  const handlePreviewWheel = (event: WheelEvent) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    setPreviewZoom((zoom) => Math.max(0.25, Math.min(4, zoom + delta)));
  };

  const handlePreviewMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button === 0) {
      isDraggingPreview.current = true;
      dragStartPreview.current = {
        x: event.clientX - previewPan.x,
        y: event.clientY - previewPan.y,
      };
    }
  };

  const handlePreviewMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (isDraggingPreview.current && previewZoom > 1) {
      setPreviewPan({
        x: event.clientX - dragStartPreview.current.x,
        y: event.clientY - dragStartPreview.current.y,
      });
    }
  };

  const handlePreviewMouseUp = () => {
    isDraggingPreview.current = false;
  };

  const formatClipboardTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "刚刚";
    if (diffMins < 60) return `${diffMins}分钟前`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}小时前`;
    return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  };

  const actions = (
    <div className="clipboard-header-actions">
      <button
        className={`clipboard-monitor-btn ${isMonitoring ? "active" : ""}`}
        onClick={() => setIsMonitoring((current) => !current)}
        title={isMonitoring ? "点击暂停监控" : "点击开始监控"}
      >
        {isMonitoring ? "⏸️ 监控中" : "▶️ 已暂停"}
      </button>
      {clipboardHistory.length > 0 && (
        <button className="clipboard-clear-btn" onClick={clearClipboardHistory} title="清空历史">
          🗑️ 清空
        </button>
      )}
    </div>
  );

  return (
    <div className="sub-view">
      <SubViewHeader title="剪切板增强" onBack={onBack} actions={actions} />
      <div className="sub-view-content clipboard-container">
        {clipboardHistory.length === 0 ? (
          <div className="clipboard-empty">
            <div className="clipboard-empty-icon">📋</div>
            <div className="clipboard-empty-text">暂无复制记录</div>
            <div className="clipboard-empty-hint">复制文本或图片后将自动记录</div>
          </div>
        ) : (
          <div className="clipboard-list">
            {clipboardHistory.map((item) => (
              <div key={item.id} className="clipboard-item" onClick={() => copyToClipboard(item)}>
                <div className="clipboard-item-content">
                  {item.type === "text" ? (
                    <div className="clipboard-text-preview">
                      {item.content.slice(0, 200)}
                      {item.content.length > 200 && "..."}
                    </div>
                  ) : (
                    <div
                      className="clipboard-image-preview"
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setPreviewItem(item);
                      }}
                    >
                      <img src={item.content} alt="复制图片" />
                    </div>
                  )}
                </div>
                <div className="clipboard-item-footer">
                  <span className="clipboard-item-time">{formatClipboardTime(item.timestamp)}</span>
                  <span className="clipboard-item-type">
                    {item.type === "text" ? "文本" : "图片"}
                  </span>
                  <button
                    className="clipboard-delete-btn"
                    onClick={(event) => deleteClipboardItem(item.id, event)}
                    title="删除"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {previewItem && previewItem.type === "image" && (
        <div className="clipboard-preview-overlay" onClick={closePreview}>
          <div className="clipboard-preview-panel" onClick={(event) => event.stopPropagation()}>
            <div className="clipboard-preview-header">
              <div className="clipboard-preview-zoom-controls">
                <button
                  className="clipboard-zoom-btn"
                  onClick={() => setPreviewZoom((zoom) => Math.max(0.25, zoom - 0.25))}
                >
                  −
                </button>
                <span className="clipboard-zoom-level">{Math.round(previewZoom * 100)}%</span>
                <button
                  className="clipboard-zoom-btn"
                  onClick={() => setPreviewZoom((zoom) => Math.min(4, zoom + 0.25))}
                >
                  +
                </button>
                <button className="clipboard-zoom-reset" onClick={() => setPreviewZoom(1)}>
                  重置
                </button>
              </div>
              <button className="clipboard-preview-close" onClick={closePreview}>
                ×
              </button>
            </div>
            <div
              className="clipboard-preview-content"
              onWheel={handlePreviewWheel}
              onMouseDown={handlePreviewMouseDown}
              onMouseMove={handlePreviewMouseMove}
              onMouseUp={handlePreviewMouseUp}
              onMouseLeave={handlePreviewMouseUp}
            >
              <img
                src={previewItem.content}
                alt="预览图片"
                style={{
                  transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})`,
                  transition: isDraggingPreview.current ? "none" : "transform 0.2s ease",
                  cursor:
                    previewZoom > 1
                      ? isDraggingPreview.current
                        ? "grabbing"
                        : "grab"
                      : "default",
                }}
              />
            </div>
            <div className="clipboard-preview-footer">
              <button className="clipboard-preview-copy" onClick={() => copyToClipboard(previewItem)}>
                复制图片
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ClipboardView;
