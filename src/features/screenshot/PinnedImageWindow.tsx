import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";

function PinnedImageWindow() {
  const label = new URLSearchParams(window.location.search).get("label") || "";
  const [imageData, setImageData] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const load = async () => {
      try {
        const data = await invoke<string>("get_pinned_image", { label });
        setImageData(data);
      } catch {}
    };

    load();
    let cleanup: (() => void) | null = null;

    listen<string>("pinned-image-updated", (event) => {
      setImageData(event.payload);
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    return () => {
      cleanup?.();
    };
  }, [label]);

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    setZoom((current) => Math.max(0.25, Math.min(4, current + delta)));
  };

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || zoom <= 1) return;
    draggingRef.current = true;
    dragStartRef.current = { x: event.clientX - pan.x, y: event.clientY - pan.y };
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    setPan({
      x: event.clientX - dragStartRef.current.x,
      y: event.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    draggingRef.current = false;
  };

  return (
    <div className="pinned-window-root">
      <div className="pinned-window-toolbar" data-tauri-drag-region>
        <span data-tauri-drag-region>钉图</span>
        <div className="pinned-window-actions">
          <button className="pinned-window-btn" onClick={() => setZoom((current) => Math.max(0.25, current - 0.25))}>
            -
          </button>
          <button className="pinned-window-btn" onClick={() => setZoom((current) => Math.min(4, current + 0.25))}>
            +
          </button>
          <button
            className="pinned-window-btn"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            重置
          </button>
          <button
            className="pinned-window-btn"
            onClick={async () => {
              if (!imageData) return;
              const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
              const base64Data = imageData.split(",")[1];
              const binaryString = atob(base64Data);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i += 1) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              await writeImage(bytes);
            }}
          >
            复制
          </button>
          <button className="pinned-window-btn" onClick={() => getCurrentWindow().close()}>
            关闭
          </button>
        </div>
      </div>
      {imageData ? (
        <div
          className="pinned-window-stage"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <img
            className="pinned-window-image"
            src={imageData}
            alt="钉图预览"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              cursor: zoom > 1 ? (draggingRef.current ? "grabbing" : "grab") : "default",
            }}
          />
        </div>
      ) : (
        <div className="pinned-window-empty">暂无钉图内容</div>
      )}
    </div>
  );
}

export default PinnedImageWindow;
