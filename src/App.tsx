import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import "./App.css";
import MainSidebarView from "./components/MainSidebarView";
import type { CommandPaletteResult, SidebarNotification } from "./components/MainSidebarView";
import { TOOLS } from "./constants/sidebar";
import desktopIcon from "./assets/icon.svg";
import taskbarIcon from "./assets/task.svg";
import ClipboardView from "./features/clipboard/ClipboardView";
import { getClipboardSearchFields, type ClipboardItem as ClipboardSearchItem, normalizeClipboardItems } from "./features/clipboard/clipboardModel";
import JsonToolView from "./features/json/JsonToolView";
import PomodoroView from "./features/pomodoro/PomodoroView";
import QuickLaunchView from "./features/quicklaunch/QuickLaunchView";
import TextManagerView from "./features/textmanager/TextManagerView";
import TodoView from "./features/todo/TodoView";
import { notifyToolboxDataChanged, TOOLBOX_DATA_CHANGED } from "./utils/dataSync";
import type { ActiveView, ToggleSwitchItem, ToolId, ViewToolId } from "./types/sidebar";

type SearchResultPayload =
  | { type: "tool"; toolId: ToolId }
  | { type: "quicklaunch"; target: string; itemType: string; args: string }
  | { type: "clipboard-text"; content: string }
  | { type: "clipboard-image"; content: string }
  | { type: "view"; view: ViewToolId }
  | { type: "action"; actionKey: string };

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
  itemType?: string;
  args?: string;
  groupId?: string;
  sortOrder?: number;
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

type CommandHistoryEntry = {
  actionKey: string;
  title: string;
  groupName: string;
  icon: string;
  meta?: string;
  payloadJson: string;
  lastUsedAt: number;
  useCount: number;
};

type ToastNotification = SidebarNotification & {
  visible: boolean;
};

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
  const [commandFilter, setCommandFilter] = useState("all");
  const [quickLaunchSearchItems, setQuickLaunchSearchItems] = useState<QuickLaunchSearchItem[]>([]);
  const [clipboardSearchItems, setClipboardSearchItems] = useState<ClipboardSearchItem[]>([]);
  const [textSearchEntries, setTextSearchEntries] = useState<TextEntrySearchItem[]>([]);
  const [todoSearchItems, setTodoSearchItems] = useState<TodoSearchItem[]>([]);
  const [commandHistory, setCommandHistory] = useState<CommandHistoryEntry[]>([]);
  const [notifications, setNotifications] = useState<SidebarNotification[]>([]);
  const [toastNotifications, setToastNotifications] = useState<ToastNotification[]>([]);
  const [isNotificationCenterOpen, setIsNotificationCenterOpen] = useState(false);
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
  const commandFilters = [
    { id: "all", label: "全部" },
    { id: "actions", label: "动作" },
    { id: "programs", label: "程序" },
    { id: "clipboard", label: "剪贴板" },
    { id: "text", label: "文本" },
    { id: "todos", label: "待办" },
  ];

  const unreadNotificationCount = notifications.filter((item) => !item.read).length;

  const appendToast = (notification: SidebarNotification) => {
    setToastNotifications((current) => {
      const next = [...current, { ...notification, visible: true }].slice(-3);
      return next;
    });
    if (notification.level !== "error") {
      window.setTimeout(() => {
        setToastNotifications((current) => current.filter((item) => item.id !== notification.id));
      }, 3500);
    }
  };

  const loadMetaData = () => {
    void Promise.all([
      invoke<CommandHistoryEntry[]>("get_command_history"),
      invoke<SidebarNotification[]>("get_notification_history"),
    ])
      .then(([history, notificationItems]) => {
        setCommandHistory(history || []);
        setNotifications(notificationItems || []);
      })
      .catch(console.error);
  };

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
    loadMetaData();
    const unlistenAppNotification = listen<SidebarNotification>("app-notification", (event) => {
      const notification = event.payload;
      setNotifications((current) => [notification, ...current.filter((item) => item.id !== notification.id)].slice(0, 50));
      appendToast(notification);
    });
    return () => {
      unlistenAppNotification.then((fn) => fn());
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

  useEffect(() => {
    const loadUnifiedSearchData = () => {
      void Promise.all([
        invoke<{ groups: QuickLaunchSearchItem[]; items: QuickLaunchSearchItem[] }>("get_quicklaunch_data"),
        invoke<ClipboardSearchItem[]>("get_clipboard_history"),
        invoke<{ groups: unknown[]; entries: TextEntrySearchItem[] }>("get_text_manager_data"),
        invoke<TodoSearchItem[]>("get_todos"),
      ])
        .then(([quicklaunchData, clipboardData, textData, todoData]) => {
          setQuickLaunchSearchItems(quicklaunchData.items || []);
          setClipboardSearchItems(normalizeClipboardItems(clipboardData));
          setTextSearchEntries(textData.entries || []);
          setTodoSearchItems(todoData || []);
        })
        .catch(console.error);
    };

    loadUnifiedSearchData();
    const handleDataChanged = () => {
      loadUnifiedSearchData();
      loadMetaData();
    };
    window.addEventListener(TOOLBOX_DATA_CHANGED, handleDataChanged);
    return () => window.removeEventListener(TOOLBOX_DATA_CHANGED, handleDataChanged);
  }, []);

  const actionResults = useMemo<SearchResult[]>(() => {
    const actions: SearchResult[] = [
      {
        id: "action-open-clipboard",
        icon: "📋",
        title: "打开剪贴板",
        subtitle: "进入剪贴板模块",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "view", view: "clipboard" },
        secondaryAction: { type: "none" },
        score: 40,
      },
      {
        id: "action-open-quicklaunch",
        icon: "📌",
        title: "打开快捷访问",
        subtitle: "进入快捷访问模块",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "view", view: "quicklaunch" },
        secondaryAction: { type: "none" },
        score: 40,
      },
      {
        id: "action-open-textmanager",
        icon: "🗂️",
        title: "打开文本管理",
        subtitle: "进入文本管理模块",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "view", view: "textmanager" },
        secondaryAction: { type: "none" },
        score: 40,
      },
      {
        id: "action-open-todo",
        icon: "☑️",
        title: "打开待办",
        subtitle: "进入待办模块",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "view", view: "todo" },
        secondaryAction: { type: "none" },
        score: 40,
      },
      {
        id: "action-open-pomodoro",
        icon: "🍅",
        title: "打开番茄钟",
        subtitle: "进入番茄钟模块",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "view", view: "pomodoro" },
        secondaryAction: { type: "none" },
        score: 40,
      },
      {
        id: "action-toggle-desktop",
        icon: "👁️",
        title: switchStates.desktop ? "隐藏桌面图标" : "显示桌面图标",
        subtitle: "切换桌面图标显示状态",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "action", actionKey: "toggle-desktop" },
        secondaryAction: { type: "none" },
        score: 40,
      },
      {
        id: "action-toggle-taskbar",
        icon: "🚀",
        title: switchStates.taskbar ? "隐藏任务栏" : "显示任务栏",
        subtitle: "切换任务栏显示状态",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "action", actionKey: "toggle-taskbar" },
        secondaryAction: { type: "none" },
        score: 40,
      },
      {
        id: "action-clear-clipboard",
        icon: "🧹",
        title: "清空剪贴板历史",
        subtitle: "保留收藏和置顶项",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "action", actionKey: "clear-clipboard" },
        secondaryAction: { type: "open-view", view: "clipboard" },
        score: 40,
      },
    ];
    return actions;
  }, [switchStates.desktop, switchStates.taskbar]);

  const commandResults = useMemo<SearchResult[]>(() => {
    const query = commandQuery.trim().toLowerCase();
    const quickLaunchItems = quickLaunchSearchItems;
    const clipboardItems = clipboardSearchItems;
    const textEntries = textSearchEntries;
    const todoItems = todoSearchItems;

    const historyResults: SearchResult[] = commandHistory
      .slice(0, 4)
      .flatMap((entry, index) => {
        try {
          const parsedPayload = JSON.parse(entry.payloadJson) as SearchResultPayload;
          return [{
            id: `history-${entry.actionKey}`,
            icon: entry.icon,
            title: entry.title,
            subtitle: entry.meta || "最近执行",
            meta: "最近执行",
            group: "最近执行",
            category: "actions",
            payload: parsedPayload,
            secondaryAction: { type: "none" },
            score: 120 - index,
          }];
        } catch {
          return [];
        }
      });

    if (!query) {
      const suggestions: SearchResult[] = [
        ...historyResults,
        ...quickLaunchItems
          .filter((item) => (item.launchCount || 0) > 0)
          .sort((left, right) => (right.lastLaunchedAt || 0) - (left.lastLaunchedAt || 0))
          .slice(0, 4)
          .map<SearchResult>((item, index) => ({
            id: `suggest-quicklaunch-${item.id}`,
            icon: item.icon ? "📌" : item.itemType === "folder" ? "📁" : item.itemType === "url" ? "🌐" : item.itemType === "script" ? "🧾" : "📄",
            title: item.alias ? `${item.alias} · ${item.name}` : item.name,
            subtitle: shortenText(item.path, 48),
            meta: "快捷启动",
            group: "最近使用",
            category: "programs",
            hint: index === 0 ? "Enter" : undefined,
            secondaryHint: "打开模块",
            payload: { type: "quicklaunch", target: item.path, itemType: item.itemType || "app", args: item.args || "" },
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
            category: "clipboard",
            secondaryHint: "打开模块",
            payload: { type: "clipboard-text", content: item.content },
            secondaryAction: { type: "open-view", view: "clipboard" },
            score: 80 - index,
          })),
        ...actionResults.slice(0, 4).map((action, index) => ({ ...action, score: 60 - index })),
      ];

      return suggestions
        .filter((result) => commandFilter === "all" || result.category === commandFilter)
        .slice(0, 12);
    }

    const toolResults: SearchResult[] = [...actionResults]
      .map((action) => ({
        ...action,
        score: getSearchScore([action.title, action.subtitle], query),
      }))
      .filter((entry) => entry.score >= 0);

    const quickLaunchResults: SearchResult[] = quickLaunchItems
      .map((item) => ({
        item,
        score: getSearchScore([item.alias || "", item.name, item.path, item.args || ""], query),
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
        icon: item.icon ? "📌" : item.itemType === "folder" ? "📁" : item.itemType === "url" ? "🌐" : item.itemType === "script" ? "🧾" : "📄",
        title: item.alias ? `${item.alias} · ${item.name}` : item.name,
        subtitle: shortenText(item.path, 46),
        meta: "快捷启动",
        group: "程序与别名",
        category: "programs",
        hint: item.alias ? `@${item.alias}` : undefined,
        secondaryHint: "打开模块",
        payload: { type: "quicklaunch", target: item.path, itemType: item.itemType || "app", args: item.args || "" },
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
        category: "clipboard",
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
        category: "text",
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
        category: "todos",
        payload: { type: "view", view: "todo" },
        secondaryAction: { type: "open-view", view: "todo" },
        score,
      }));

    const groupOrder = ["动作", "程序与别名", "剪贴板", "文本", "待办"];

    return [...toolResults, ...quickLaunchResults, ...clipboardResults, ...textResults, ...todoResults]
      .filter((result) => commandFilter === "all" || result.category === commandFilter)
      .sort((left, right) => {
        const groupDelta = groupOrder.indexOf(left.group) - groupOrder.indexOf(right.group);
        return groupDelta || right.score - left.score;
      })
      .slice(0, 12);
  }, [actionResults, clipboardSearchItems, commandFilter, commandHistory, commandQuery, quickLaunchSearchItems, textSearchEntries, todoSearchItems]);

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

  const recordCommandUsage = async (result: SearchResult) => {
    try {
      await invoke("upsert_command_history", {
        entry: {
          actionKey: result.id,
          title: result.title,
          groupName: result.group,
          icon: result.icon,
          meta: result.meta || result.subtitle,
          payloadJson: JSON.stringify(result.payload),
          lastUsedAt: Date.now(),
          useCount: 1,
        },
      });
      setCommandHistory((current) => [
        {
          actionKey: result.id,
          title: result.title,
          groupName: result.group,
          icon: result.icon,
          meta: result.meta || result.subtitle,
          payloadJson: JSON.stringify(result.payload),
          lastUsedAt: Date.now(),
          useCount: (current.find((item) => item.actionKey === result.id)?.useCount || 0) + 1,
        },
        ...current.filter((item) => item.actionKey !== result.id),
      ].slice(0, 20));
    } catch (error) {
      console.error(error);
    }
  };

  const handleActionCommand = async (actionKey: string) => {
    if (actionKey === "toggle-desktop") {
      await handleSwitchClick("desktop");
      return;
    }
    if (actionKey === "toggle-taskbar") {
      await handleSwitchClick("taskbar");
      return;
    }
    if (actionKey === "clear-clipboard") {
      await invoke("clear_clipboard_records");
      notifyToolboxDataChanged("clipboard");
      await invoke("insert_notification", {
        notification: {
          id: `clipboard-clear-${Date.now()}`,
          level: "success",
          title: "已清空剪贴板历史",
          message: "保留了收藏和置顶项",
          source: "clipboard",
          createdAt: Date.now(),
          read: false,
        },
      });
    }
  };

  const handleCommandResultClick = async (result: CommandPaletteResult) => {
    const resolved = commandResults.find((item) => item.id === result.id);
    if (!resolved) return;

    setCommandQuery("");
    setIsCommandPaletteOpen(false);
    searchInputRef.current?.blur();

    try {
      await recordCommandUsage(resolved);
      switch (resolved.payload.type) {
        case "tool":
          await handleToolClick(resolved.payload.toolId);
          break;
        case "quicklaunch":
          await invoke("launch_program", {
            request: {
              target: resolved.payload.target,
              itemType: resolved.payload.itemType,
              args: resolved.payload.args,
            },
          });
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
        case "action":
          await handleActionCommand(resolved.payload.actionKey);
          break;
        default:
          break;
      }
    } catch (error) {
      console.error(error);
      await invoke("insert_notification", {
        notification: {
          id: `command-error-${Date.now()}`,
          level: "error",
          title: "命令执行失败",
          message: String(error),
          source: "command",
          createdAt: Date.now(),
          read: false,
        },
      }).catch(console.error);
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
      await invoke("insert_notification", {
        notification: {
          id: `switch-error-${switchId}-${Date.now()}`,
          level: "error",
          title: "系统切换失败",
          message: String(error),
          source: "system",
          createdAt: Date.now(),
          read: false,
        },
      }).catch(console.error);
    } finally {
      setPendingSwitches((current) => ({ ...current, [switchId]: false }));
    }
  };

  const handleNotificationRead = async (id: string, read: boolean) => {
    setNotifications((current) => current.map((item) => (item.id === id ? { ...item, read } : item)));
    await invoke("mark_notification_read", { id, read }).catch(console.error);
  };

  const handleNotificationClear = async () => {
    setNotifications([]);
    await invoke("clear_notification_history").catch(console.error);
  };

  const switches: ToggleSwitchItem[] = [
    {
      id: "desktop",
      icon: "👁️",
      iconSrc: desktopIcon,
      label: "桌面图标",
      desc: "切换桌面图标显示状态",
      active: switchStates.desktop,
      pending: pendingSwitches.desktop,
    },
    {
      id: "taskbar",
      icon: "🚀",
      iconSrc: taskbarIcon,
      label: "任务栏",
      desc: "切换任务栏显示状态",
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
            commandFilter={commandFilter}
            commandFilters={commandFilters}
            notifications={notifications}
            unreadNotificationCount={unreadNotificationCount}
            isNotificationCenterOpen={isNotificationCenterOpen}
            searchInputRef={searchInputRef}
            onCommandPaletteOpen={openCommandPalette}
            onCommandInputKeyDown={handleCommandInputKeyDown}
            onCommandQueryChange={handleCommandQueryChange}
            onCommandFilterChange={setCommandFilter}
            onCommandResultHover={setSelectedCommandId}
            onCommandResultClick={handleCommandResultClick}
            onCommandResultSecondaryClick={handleCommandResultSecondaryClick}
            onNotificationToggle={() => setIsNotificationCenterOpen((current) => !current)}
            onNotificationRead={handleNotificationRead}
            onNotificationClear={handleNotificationClear}
            onToolClick={handleToolClick}
            onSwitchClick={handleSwitchClick}
          />
        ) : (
          renderers[activeView]
        )}
      </div>
      <div className="app-toast-stack">
        {toastNotifications.map((notification) => (
          <div key={notification.id} className={`app-toast ${notification.level}`}>
            <div className="app-toast-title">{notification.title}</div>
            <div className="app-toast-message">{notification.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
