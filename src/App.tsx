import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import "./App.css";
import MainSidebarView from "./components/MainSidebarView";
import type { CommandPaletteResult } from "./components/MainSidebarView";
import { TOOLS } from "./constants/sidebar";
import ClipboardView from "./features/clipboard/ClipboardView";
import { CLIPBOARD_STORAGE_KEY, getClipboardSearchFields, type ClipboardItem as ClipboardSearchItem, normalizeClipboardItems } from "./features/clipboard/clipboardModel";
import JsonToolView from "./features/json/JsonToolView";
import PomodoroView from "./features/pomodoro/PomodoroView";
import QuickLaunchView from "./features/quicklaunch/QuickLaunchView";
import TextManagerView from "./features/textmanager/TextManagerView";
import TodoView from "./features/todo/TodoView";
import type { ActiveView, ToggleSwitchItem, ToolId, ViewToolId } from "./types/sidebar";

type SearchResultPayload =
  | { type: "tool"; toolId: ToolId }
  | { type: "quicklaunch"; path: string }
  | { type: "clipboard-text"; content: string }
  | { type: "clipboard-image"; content: string }
  | { type: "view"; view: ViewToolId };

type SecondaryAction =
  | { type: "open-view"; view: ViewToolId }
  | { type: "none" };

type SearchResult = CommandPaletteResult & {
  payload: SearchResultPayload;
  secondaryAction: SecondaryAction;
  score: number;
};

type QuickLaunchSearchItem = {
  id: string;
  name: string;
  path: string;
  icon?: string;
  alias?: string;
  groupId?: string;
  launchCount?: number;
  lastLaunchedAt?: number;
};

type TextEntrySearchItem = {
  id: string;
  title: string;
  content: string;
};

type TodoSearchItem = {
  id: string;
  text: string;
  completed: boolean;
};

function loadStoredArray<T>(key: string): T[] {
  try {
    const saved = localStorage.getItem(key);
    return saved ? (JSON.parse(saved) as T[]) : [];
  } catch {
    return [];
  }
}

function getSearchScore(fields: string[], query: string) {
  if (!query) return 0;

  let bestScore = -1;
  for (const field of fields) {
    const value = field.toLowerCase();
    const index = value.indexOf(query);
    if (index === -1) continue;

    let score = 40 - index;
    if (value === query) score += 70;
    if (value.startsWith(query)) score += 35;
    if (value.split(/\s+/).some((part) => part.startsWith(query))) score += 18;
    bestScore = Math.max(bestScore, score);
  }

  return bestScore;
}

function shortenText(value: string, limit: number) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

function createToolSecondaryAction(toolId: ToolId): SecondaryAction {
  const tool = TOOLS.find((item) => item.id === toolId);
  if (tool?.kind === "view") {
    return { type: "open-view", view: tool.view };
  }
  return { type: "none" };
}

async function writeClipboardText(content: string) {
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  await writeText(content);
}

async function writeClipboardImage(dataUrl: string) {
  const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
  const base64Data = dataUrl.split(",")[1];
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }
  await writeImage(bytes);
}

function App() {
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [activeView, setActiveView] = useState<ActiveView>("main");
  const [commandQuery, setCommandQuery] = useState("");
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const previewWidthRef = useRef<number | null>(null);
  const isDialogOpenRef = useRef(false);

  const finishDragging = (commitWidth: boolean) => {
    if (!isDragging.current) return;

    isDragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    const finalWidth = previewWidthRef.current;
    if (commitWidth && finalWidth !== null) {
      const width = Math.round(finalWidth);
      setSidebarWidth(width);
      void invoke("resize_sidebar", { width });
    }

    previewWidthRef.current = null;
    setPreviewWidth(null);
  };

  useEffect(() => {
    let isCurrentlyClosing = false;
    let hideTimeoutId: number | null = null;

    const triggerHide = () => {
      if (isCurrentlyClosing || isDialogOpenRef.current || isDragging.current) return;
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
    const unlistenBlur = listen("tauri://blur", () => {
      finishDragging(true);
      triggerHide();
    });

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
      previewWidthRef.current = newWidth;
      setPreviewWidth(newWidth);
    };

    const handleMouseUp = () => {
      finishDragging(true);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      finishDragging(false);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setActiveView("main");
        openCommandPalette();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const commandResults = useMemo<SearchResult[]>(() => {
    const query = commandQuery.trim().toLowerCase();
    const quickLaunchItems = loadStoredArray<QuickLaunchSearchItem>("toolbox_quicklaunch");
    const clipboardItems = normalizeClipboardItems(loadStoredArray<ClipboardSearchItem>(CLIPBOARD_STORAGE_KEY));
    const textEntries = loadStoredArray<TextEntrySearchItem>("toolbox_text_entries");
    const todoItems = loadStoredArray<TodoSearchItem>("toolbox_todos");

    if (!query) {
      const suggestions: SearchResult[] = [
        ...quickLaunchItems
          .filter((item) => (item.launchCount || 0) > 0)
          .sort((left, right) => (right.lastLaunchedAt || 0) - (left.lastLaunchedAt || 0))
          .slice(0, 4)
          .map<SearchResult>((item, index) => ({
            id: `suggest-quicklaunch-${item.id}`,
            icon: item.icon ? "📌" : "📄",
            title: item.alias ? `${item.alias} · ${item.name}` : item.name,
            subtitle: shortenText(item.path, 48),
            meta: "快捷启动",
            group: "最近使用",
            hint: index === 0 ? "Enter" : undefined,
            secondaryHint: "打开模块",
            payload: { type: "quicklaunch", path: item.path },
            secondaryAction: { type: "open-view", view: "quicklaunch" },
            score: 100 - index,
          })),
        ...clipboardItems
          .filter((item) => item.type === "text" && item.favorite)
          .sort((left, right) => right.timestamp - left.timestamp)
          .slice(0, 3)
          .map<SearchResult>((item, index) => ({
            id: `suggest-clipboard-${item.id}`,
            icon: "⭐",
            title: shortenText(item.content, 32) || "收藏文本",
            subtitle: shortenText(item.content, 70),
            meta: "复制文本",
            group: "剪贴板收藏",
            secondaryHint: "打开模块",
            payload: { type: "clipboard-text", content: item.content },
            secondaryAction: { type: "open-view", view: "clipboard" },
            score: 80 - index,
          })),
        ...TOOLS.slice(0, 4).map<SearchResult>((tool, index) => ({
          id: `suggest-tool-${tool.id}`,
          icon: tool.icon,
          title: tool.label,
          subtitle: tool.desc,
          meta: "工具",
          group: "常用功能",
          secondaryHint: tool.kind === "view" ? "打开模块" : undefined,
          payload: { type: "tool", toolId: tool.id },
          secondaryAction: createToolSecondaryAction(tool.id),
          score: 60 - index,
        })),
      ];

      return suggestions.slice(0, 10);
    }

    const toolResults: SearchResult[] = TOOLS.filter((tool) =>
      getSearchScore([tool.label, tool.desc], query) >= 0,
    ).map((tool) => {
      const score = getSearchScore([tool.label, tool.desc], query);
      return {
        id: `tool-${tool.id}`,
        icon: tool.icon,
        title: tool.label,
        subtitle: tool.desc,
        meta: "工具",
        group: "工具",
        secondaryHint: tool.kind === "view" ? "打开模块" : undefined,
        payload: { type: "tool", toolId: tool.id },
        secondaryAction: createToolSecondaryAction(tool.id),
        score,
      };
    });

    const quickLaunchResults: SearchResult[] = quickLaunchItems
      .map((item) => ({
        item,
        score: getSearchScore([item.alias || "", item.name, item.path], query),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => {
        const usageDelta =
          ((right.item.lastLaunchedAt || 0) + (right.item.launchCount || 0) * 500) -
          ((left.item.lastLaunchedAt || 0) + (left.item.launchCount || 0) * 500);
        return right.score - left.score || usageDelta;
      })
      .slice(0, 5)
      .map(({ item, score }) => ({
        id: `quicklaunch-${item.id}`,
        icon: item.icon ? "📌" : "📄",
        title: item.alias ? `${item.alias} · ${item.name}` : item.name,
        subtitle: shortenText(item.path, 46),
        meta: "快捷启动",
        group: "程序与别名",
        hint: item.alias ? `@${item.alias}` : undefined,
        secondaryHint: "打开模块",
        payload: { type: "quicklaunch", path: item.path },
        secondaryAction: { type: "open-view", view: "quicklaunch" },
        score,
      }));

    const clipboardResults: SearchResult[] = clipboardItems
      .map((item) => ({
        item,
        score: item.type === "text" ? getSearchScore(getClipboardSearchFields(item), query) : -1,
      }))
      .filter((entry) => entry.item.type === "text" && entry.score >= 0)
      .sort((left, right) => {
        if (left.item.favorite && !right.item.favorite) return -1;
        if (!left.item.favorite && right.item.favorite) return 1;
        if (left.item.pinned && !right.item.pinned) return -1;
        if (!left.item.pinned && right.item.pinned) return 1;
        return right.score - left.score || right.item.timestamp - left.item.timestamp;
      })
      .slice(0, 4)
      .map(({ item, score }) => ({
        id: `clipboard-${item.id}`,
        icon: item.pinned ? "📌" : item.favorite ? "⭐" : item.group === "snippet" ? "🧩" : "📋",
        title: shortenText(item.content, 32) || "剪贴板文本",
        subtitle: shortenText(item.content, 70),
        meta: item.group === "snippet" ? "代码片段" : "复制文本",
        group: "剪贴板",
        hint: item.pinned ? "置顶" : item.favorite ? "收藏" : item.tags?.[0] ? `#${item.tags[0]}` : undefined,
        secondaryHint: "打开模块",
        payload: { type: "clipboard-text", content: item.content },
        secondaryAction: { type: "open-view", view: "clipboard" },
        score,
      }));

    const textResults: SearchResult[] = textEntries
      .map((item) => ({
        item,
        score: getSearchScore([item.title, item.content], query),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(({ item, score }) => ({
        id: `text-${item.id}`,
        icon: "🗂️",
        title: item.title || "未命名文本",
        subtitle: shortenText(item.content, 70),
        meta: "打开文本管理",
        group: "文本",
        payload: { type: "view", view: "textmanager" },
        secondaryAction: { type: "open-view", view: "textmanager" },
        score,
      }));

    const todoResults: SearchResult[] = todoItems
      .map((item) => ({
        item,
        score: getSearchScore([item.text], query),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(({ item, score }) => ({
        id: `todo-${item.id}`,
        icon: item.completed ? "✅" : "☑️",
        title: item.text,
        subtitle: item.completed ? "已完成待办" : "待办事项",
        meta: "打开待办",
        group: "待办",
        payload: { type: "view", view: "todo" },
        secondaryAction: { type: "open-view", view: "todo" },
        score,
      }));

    const groupOrder = ["程序与别名", "工具", "剪贴板", "文本", "待办"];

    return [...quickLaunchResults, ...toolResults, ...clipboardResults, ...textResults, ...todoResults]
      .sort((left, right) => {
        const groupDelta = groupOrder.indexOf(left.group) - groupOrder.indexOf(right.group);
        return groupDelta || right.score - left.score;
      })
      .slice(0, 12);
  }, [commandQuery]);

  useEffect(() => {
    if (!isCommandPaletteOpen) {
      setSelectedCommandId(null);
      return;
    }

    setSelectedCommandId((current) => {
      if (current && commandResults.some((result) => result.id === current)) {
        return current;
      }
      return commandResults[0]?.id ?? null;
    });
  }, [commandResults, isCommandPaletteOpen]);

  const handleMouseDown = (event: ReactMouseEvent) => {
    isDragging.current = true;
    dragStartX.current = event.screenX;
    dragStartWidth.current = sidebarWidth;
    previewWidthRef.current = sidebarWidth;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    event.preventDefault();
  };

  const handleToolClick = async (toolId: ToolId) => {
    const tool = TOOLS.find((item) => item.id === toolId);
    if (!tool) return;

    setActiveView(tool.view);
  };

  const handleCommandResultClick = async (result: CommandPaletteResult) => {
    const resolved = commandResults.find((item) => item.id === result.id);
    if (!resolved) return;

    setCommandQuery("");
    setIsCommandPaletteOpen(false);
    searchInputRef.current?.blur();

    try {
      switch (resolved.payload.type) {
        case "tool":
          await handleToolClick(resolved.payload.toolId);
          break;
        case "quicklaunch":
          await invoke("launch_program", { path: resolved.payload.path });
          break;
        case "clipboard-text":
          await writeClipboardText(resolved.payload.content);
          break;
        case "clipboard-image":
          await writeClipboardImage(resolved.payload.content);
          break;
        case "view":
          setActiveView(resolved.payload.view);
          break;
        default:
          break;
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleCommandResultSecondaryClick = async (result: CommandPaletteResult) => {
    const resolved = commandResults.find((item) => item.id === result.id);
    if (!resolved || resolved.secondaryAction.type === "none") return;

    setIsCommandPaletteOpen(false);
    setCommandQuery("");
    searchInputRef.current?.blur();
    setActiveView(resolved.secondaryAction.view);
  };

  const handleCommandQueryChange = (value: string) => {
    setCommandQuery(value);
    setIsCommandPaletteOpen(true);
  };

  const openCommandPalette = () => {
    setIsCommandPaletteOpen(true);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const handleCommandInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!commandResults.length && event.key !== "Escape") return;

    const currentIndex = commandResults.findIndex((result) => result.id === selectedCommandId);

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % commandResults.length;
      setSelectedCommandId(commandResults[nextIndex]?.id ?? null);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex =
        currentIndex <= 0 ? commandResults.length - 1 : currentIndex - 1;
      setSelectedCommandId(commandResults[nextIndex]?.id ?? null);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (event.ctrlKey) {
        const selected =
          commandResults.find((result) => result.id === selectedCommandId) ?? commandResults[0];
        if (selected) {
          void handleCommandResultSecondaryClick(selected);
        }
        return;
      }

      const selected =
        commandResults.find((result) => result.id === selectedCommandId) ?? commandResults[0];
      if (selected) {
        void handleCommandResultClick(selected);
      }
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const selected =
        commandResults.find((result) => result.id === selectedCommandId) ?? commandResults[0];
      if (selected) {
        void handleCommandResultSecondaryClick(selected);
      }
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (commandQuery) {
        setCommandQuery("");
      } else {
        setIsCommandPaletteOpen(false);
        searchInputRef.current?.blur();
      }
    }
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
            commandQuery={commandQuery}
            isCommandPaletteOpen={isCommandPaletteOpen}
            selectedCommandId={selectedCommandId}
            commandResults={commandResults}
            searchInputRef={searchInputRef}
            onCommandPaletteOpen={openCommandPalette}
            onCommandInputKeyDown={handleCommandInputKeyDown}
            onCommandQueryChange={handleCommandQueryChange}
            onCommandResultHover={setSelectedCommandId}
            onCommandResultClick={handleCommandResultClick}
            onCommandResultSecondaryClick={handleCommandResultSecondaryClick}
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
