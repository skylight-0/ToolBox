import { useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import TextManagerView from "./TextManagerView";
import { TOOLBOX_DATA_CHANGED } from "../../utils/dataSync";

export default function TextManagerWindow() {
  useEffect(() => {
    // Bridge window-level CustomEvent to Tauri cross-window event
    // so the main window's search index refreshes on save
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string }>).detail;
      emit("toolbox-data-changed", detail).catch(console.error);
    };
    window.addEventListener(TOOLBOX_DATA_CHANGED, handler);
    return () => window.removeEventListener(TOOLBOX_DATA_CHANGED, handler);
  }, []);

  return (
    <div className="textmanager-window-standalone">
      <TextManagerView />
    </div>
  );
}
