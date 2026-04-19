import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

function PinnedImageWindow() {
  const label = new URLSearchParams(window.location.search).get("label") || "";
  const [imageData, setImageData] = useState("");

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

  return (
    <div className="pinned-window-root">
      <div className="pinned-window-toolbar" data-tauri-drag-region>
        <span data-tauri-drag-region>钉图</span>
        <div className="pinned-window-actions">
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
        <img className="pinned-window-image" src={imageData} alt="钉图预览" />
      ) : (
        <div className="pinned-window-empty">暂无钉图内容</div>
      )}
    </div>
  );
}

export default PinnedImageWindow;
