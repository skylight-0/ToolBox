import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
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
import type { ActiveView, ToggleSwitchItem, ToolId, ViewToolId } from "./types/sidebar";

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
  const [pendingSwitches, setPendingSwitches] = useState<
    Record<ToggleSwitchItem["id"], boolean>
  >({
    desktop: false,
    taskbar: false,
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

  const handleToolClick = (toolId: ToolId) => {
    const tool = TOOLS.find((item) => item.id === toolId);
    if (!tool) return;

    if (tool.kind === "view") {
      setActiveView(tool.view);
      return;
    }

    invoke("system_action", { action: tool.action }).catch(console.error);
  };

  const handleSwitchClick = async (switchId: ToggleSwitchItem["id"]) => {
    if (pendingSwitches[switchId]) return;

    const previousValue = switchStates[switchId];
    const willBeActive = !switchStates[switchId];
    setSwitchStates((current) => ({ ...current, [switchId]: willBeActive }));
    setPendingSwitches((current) => ({ ...current, [switchId]: true }));

    try {
      if (switchId === "desktop") {
        await invoke("toggle_desktop", { show: willBeActive });
      } else if (switchId === "taskbar") {
        await invoke("toggle_taskbar", { show: willBeActive });
      }
    } catch (error) {
      console.error(error);
      setSwitchStates((current) => ({ ...current, [switchId]: previousValue }));
    } finally {
      setPendingSwitches((current) => ({ ...current, [switchId]: false }));
    }
  };

  const switches: ToggleSwitchItem[] = [
    {
      id: "desktop",
      icon: "👁️",
      label: "桌面图标",
      active: switchStates.desktop,
      pending: pendingSwitches.desktop,
    },
    {
      id: "taskbar",
      icon: "🚀",
      label: "任务栏",
      active: switchStates.taskbar,
      pending: pendingSwitches.taskbar,
    },
  ];

  const renderers: Record<ViewToolId, ReactNode> = {
    json: <JsonToolView onBack={() => setActiveView("main")} />,
    todo: <TodoView onBack={() => setActiveView("main")} />,
    clipboard: <ClipboardView onBack={() => setActiveView("main")} />,
    hardware: <HardwareMonitorView onBack={() => setActiveView("main")} />,
    textmanager: <TextManagerView onBack={() => setActiveView("main")} />,
    quicklaunch: (
      <QuickLaunchView
        onBack={() => setActiveView("main")}
        isDialogOpenRef={isDialogOpenRef}
      />
    ),
    pomodoro: <PomodoroView onBack={() => setActiveView("main")} />,
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

      <div className="sidebar-content">
        {activeView === "main" ? (
          <MainSidebarView
            currentTime={currentTime}
            tools={TOOLS}
            switches={switches}
            onToolClick={handleToolClick}
            onSwitchClick={handleSwitchClick}
          />
        ) : (
          renderers[activeView]
        )}
      </div>
    </div>
  );
}

export default App;
