import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import "./App.css";
import MainSidebarView from "./components/MainSidebarView";
import { TOOLS } from "./constants/sidebar";
import ClipboardView from "./features/clipboard/ClipboardView";
import HardwareMonitorView from "./features/hardware/HardwareMonitorView";
import JsonToolView from "./features/json/JsonToolView";
import PomodoroView from "./features/pomodoro/PomodoroView";
import QuickLaunchView from "./features/quicklaunch/QuickLaunchView";
import TextManagerView from "./features/textmanager/TextManagerView";
import TodoView from "./features/todo/TodoView";
import type { ActiveView, ToggleSwitchItem, ToolItem } from "./types/sidebar";

function App() {
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [activeView, setActiveView] = useState<ActiveView>("main");
  const [switchStates, setSwitchStates] = useState<Record<ToggleSwitchItem["id"], boolean>>({
    desktop: true,
    taskbar: true,
  });

  const sidebarRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const isDialogOpenRef = useRef(false);

  useEffect(() => {
    let isCurrentlyClosing = false;
    let hideTimeoutId: number | null = null;

    const triggerHide = () => {
      if (isCurrentlyClosing || isDialogOpenRef.current) return;
      isCurrentlyClosing = true;
      setIsClosing(true);

      if (hideTimeoutId !== null) window.clearTimeout(hideTimeoutId);
      hideTimeoutId = window.setTimeout(() => {
        setIsClosing(false);
        isCurrentlyClosing = false;
        hideTimeoutId = null;
        invoke("do_hide_sidebar");
      }, 250);
    };

    const unlistenShow = listen("show-sidebar", () => {
      if (hideTimeoutId !== null) {
        window.clearTimeout(hideTimeoutId);
        hideTimeoutId = null;
      }
      setIsClosing(false);
      isCurrentlyClosing = false;
      setIsOpening(true);
      window.setTimeout(() => setIsOpening(false), 300);
    });

    const unlistenHide = listen("hide-sidebar", triggerHide);
    const unlistenBlur = listen("tauri://blur", triggerHide);

    return () => {
      unlistenShow.then((fn) => fn());
      unlistenHide.then((fn) => fn());
      unlistenBlur.then((fn) => fn());
      if (hideTimeoutId !== null) window.clearTimeout(hideTimeoutId);
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = dragStartX.current - event.screenX;
      const newWidth = Math.max(280, Math.min(1200, dragStartWidth.current + delta));
      setPreviewWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;

      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      setPreviewWidth((finalWidth) => {
        if (finalWidth !== null) {
          const width = Math.round(finalWidth);
          setSidebarWidth(width);
          invoke("resize_sidebar", { width });
        }
        return null;
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleMouseDown = (event: ReactMouseEvent) => {
    isDragging.current = true;
    dragStartX.current = event.screenX;
    dragStartWidth.current = sidebarWidth;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    event.preventDefault();
  };

  const handleToolClick = (toolId: ToolItem["id"]) => {
    if (
      toolId === "json" ||
      toolId === "todo" ||
      toolId === "quicklaunch" ||
      toolId === "pomodoro" ||
      toolId === "clipboard" ||
      toolId === "textmanager" ||
      toolId === "hardware"
    ) {
      setActiveView(toolId);
      return;
    }

    let action = "";
    if (toolId === "settings") action = "settings";
    if (toolId === "notepad") action = "notepad";
    if (toolId === "calc") action = "calc";
    if (toolId === "terminal") action = "terminal";

    if (action) {
      invoke("system_action", { action }).catch(console.error);
    }
  };

  const handleSwitchClick = (switchId: ToggleSwitchItem["id"]) => {
    const willBeActive = !switchStates[switchId];
    setSwitchStates((current) => ({ ...current, [switchId]: willBeActive }));

    if (switchId === "desktop") {
      invoke("toggle_desktop", { show: willBeActive }).catch(console.error);
    } else if (switchId === "taskbar") {
      invoke("toggle_taskbar", { show: willBeActive }).catch(console.error);
    }
  };

  const switches: ToggleSwitchItem[] = [
    { id: "desktop", icon: "👁️", label: "桌面图标", active: switchStates.desktop },
    { id: "taskbar", icon: "🚀", label: "任务栏", active: switchStates.taskbar },
  ];

  const renderActiveView = () => {
    switch (activeView) {
      case "main":
        return (
          <MainSidebarView
            currentTime={currentTime}
            tools={TOOLS}
            switches={switches}
            onToolClick={handleToolClick}
            onSwitchClick={handleSwitchClick}
          />
        );
      case "json":
        return <JsonToolView onBack={() => setActiveView("main")} />;
      case "todo":
        return <TodoView onBack={() => setActiveView("main")} />;
      case "clipboard":
        return <ClipboardView onBack={() => setActiveView("main")} />;
      case "hardware":
        return <HardwareMonitorView onBack={() => setActiveView("main")} />;
      case "textmanager":
        return <TextManagerView onBack={() => setActiveView("main")} />;
      case "quicklaunch":
        return (
          <QuickLaunchView
            onBack={() => setActiveView("main")}
            isDialogOpenRef={isDialogOpenRef}
          />
        );
      case "pomodoro":
        return <PomodoroView onBack={() => setActiveView("main")} />;
      default:
        return null;
    }
  };

  return (
    <div
      className={`sidebar-container ${isOpening ? "slide-in" : ""} ${isClosing ? "slide-out" : ""}`}
      ref={sidebarRef}
    >
      {previewWidth !== null && (
        <div
          className="drag-preview-line"
          style={{ left: `${Math.max(0, sidebarWidth - previewWidth)}px` }}
        >
          <div className="drag-preview-label">{Math.round(previewWidth)}px</div>
        </div>
      )}

      <div
        className={`drag-handle ${previewWidth !== null ? "dragging" : ""}`}
        onMouseDown={handleMouseDown}
      >
        <div className="drag-handle-indicator" />
      </div>

      <div className="sidebar-content">{renderActiveView()}</div>
    </div>
  );
}

export default App;
