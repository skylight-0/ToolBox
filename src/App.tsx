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
import CodecToolView from "./features/codec/CodecToolView";
import ClipboardView from "./features/clipboard/ClipboardView";
import {
  getClipboardSearchFields,
  isCodeSnippet,
  type ClipboardItem as ClipboardSearchItem,
  type ClipboardRecordInput,
  normalizeClipboardItems,
} from "./features/clipboard/clipboardModel";
import JsonToolView from "./features/json/JsonToolView";
import NetworkToolView from "./features/network/NetworkToolView";
import PomodoroView from "./features/pomodoro/PomodoroView";
import QrCodeView from "./features/qrcode/QrCodeView";
import QuickLaunchView from "./features/quicklaunch/QuickLaunchView";
import SettingsView from "./features/settings/SettingsView";
import type { ClipboardDefaultDateFilter } from "./features/settings/SettingsView";
import SystemInfoView from "./features/systeminfo/SystemInfoView";
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

const CLIPBOARD_TEXT_POLL_INTERVAL = 500;
const CLIPBOARD_IMAGE_POLL_INTERVAL = 2000;
const TOOL_ORDER_SETTING_KEY = "tool_order";
const DEFAULT_TOOL_ORDER = TOOLS.map((tool) => tool.id);

function normalizeToolOrder(toolIds: unknown): ToolId[] {
  const validToolIds = new Set(TOOLS.map((tool) => tool.id));
  const seenToolIds = new Set<ToolId>();
  const normalizedOrder: ToolId[] = [];

  if (Array.isArray(toolIds)) {
    for (const value of toolIds) {
      if (typeof value !== "string") continue;

      const toolId = value as ToolId;
      if (!validToolIds.has(toolId) || seenToolIds.has(toolId)) continue;

      seenToolIds.add(toolId);
      normalizedOrder.push(toolId);
    }
  }

  for (const defaultToolId of DEFAULT_TOOL_ORDER) {
    if (!seenToolIds.has(defaultToolId)) {
      normalizedOrder.push(defaultToolId);
    }
  }

  return normalizedOrder;
}

function parseToolOrderSetting(value: string | null) {
  if (!value) return DEFAULT_TOOL_ORDER;

  try {
    return normalizeToolOrder(JSON.parse(value));
  } catch {
    return DEFAULT_TOOL_ORDER;
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

async function readClipboardImageAsDataUrl(readImage: () => Promise<unknown>) {
  const imageData = await readImage();
  if (!imageData || typeof imageData !== "object") return "";

  const image = imageData as {
    rgba: () => Promise<ArrayBuffer | Uint8Array | number[]>;
    size: () => Promise<{ width: number; height: number }>;
  };
  const rgba = await image.rgba();
  const size = await image.size();
  const bytes = new Uint8Array(rgba as ArrayBuffer);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");

  if (!ctx) return "";

  const imgData = ctx.createImageData(size.width, size.height);
  imgData.data.set(bytes);
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
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
  const [isClipboardMonitoring, setIsClipboardMonitoring] = useState(true);
  const [clipboardDefaultDateFilter, setClipboardDefaultDateFilter] = useState<ClipboardDefaultDateFilter>("today");
  const [toolOrder, setToolOrder] = useState<ToolId[]>(DEFAULT_TOOL_ORDER);
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
  const activeViewRef = useRef<ActiveView>("main");
  const isCommandPaletteOpenRef = useRef(false);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const previewWidthRef = useRef<number | null>(null);
  const isDialogOpenRef = useRef(false);
  const lastClipboardContentRef = useRef("");
  const clipboardCheckInFlightRef = useRef(false);
  const lastClipboardImageCheckAtRef = useRef(0);
  const commandFilters = [
    { id: "all", label: "全部" },
    { id: "actions", label: "动作" },
    { id: "programs", label: "程序" },
    { id: "clipboard", label: "剪贴板" },
    { id: "text", label: "文本" },
    { id: "todos", label: "待办" },
  ];

  const unreadNotificationCount = notifications.filter((item) => !item.read).length;
  const orderedTools = useMemo(() => {
    const toolById = new Map(TOOLS.map((tool) => [tool.id, tool]));
    return normalizeToolOrder(toolOrder).flatMap((toolId) => {
      const tool = toolById.get(toolId);
      return tool ? [tool] : [];
    });
  }, [toolOrder]);

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
    void Promise.all([
      invoke<string | null>("get_setting", { key: "clipboard_monitoring" }),
      invoke<string | null>("get_setting", { key: "clipboard_default_date_filter" }),
      invoke<string | null>("get_setting", { key: TOOL_ORDER_SETTING_KEY }),
    ])
      .then(([monitoringValue, dateFilterValue, toolOrderValue]) => {
        if (monitoringValue === "false") {
          setIsClipboardMonitoring(false);
        }
        if (
          dateFilterValue === "today" ||
          dateFilterValue === "last7" ||
          dateFilterValue === "all"
        ) {
          setClipboardDefaultDateFilter(dateFilterValue);
        }
        setToolOrder(parseToolOrderSetting(toolOrderValue));
      })
      .catch(console.error);
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
    if (activeView !== "main") return;

    setCurrentTime(new Date());
    const timer = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, [activeView]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    isCommandPaletteOpenRef.current = isCommandPaletteOpen;
  }, [isCommandPaletteOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isCommandPaletteOpenRef.current) {
        event.preventDefault();
        setCommandQuery("");
        setIsCommandPaletteOpen(false);
        searchInputRef.current?.blur();
        return;
      }

      if (event.key === "Escape" && activeViewRef.current !== "main") {
        event.preventDefault();
        setActiveView("main");
        return;
      }

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
    const loadQuickLaunchSearchData = () =>
      invoke<{ groups: QuickLaunchSearchItem[]; items: QuickLaunchSearchItem[] }>("get_quicklaunch_data")
        .then((data) => setQuickLaunchSearchItems(data.items || []));

    const loadClipboardSearchData = () =>
      invoke<ClipboardSearchItem[]>("get_clipboard_history")
        .then((data) => setClipboardSearchItems(normalizeClipboardItems(data)));

    const loadTextSearchData = () =>
      invoke<{ groups: unknown[]; entries: TextEntrySearchItem[] }>("get_text_manager_data")
        .then((data) => setTextSearchEntries(data.entries || []));

    const loadTodoSearchData = () =>
      invoke<TodoSearchItem[]>("get_todos")
        .then((data) => setTodoSearchItems(data || []));

    const loadUnifiedSearchData = () => {
      void Promise.all([
        loadQuickLaunchSearchData(),
        loadClipboardSearchData(),
        loadTextSearchData(),
        loadTodoSearchData(),
      ]).catch(console.error);
    };

    loadUnifiedSearchData();
    const handleDataChanged = (event: Event) => {
      const kind = (event as CustomEvent<{ kind?: string }>).detail?.kind;

      if (kind === "clipboard") {
        void loadClipboardSearchData().catch(console.error);
        return;
      }
      if (kind === "quicklaunch") {
        void loadQuickLaunchSearchData().catch(console.error);
        return;
      }
      if (kind === "textmanager") {
        void loadTextSearchData().catch(console.error);
        return;
      }
      if (kind === "todos") {
        void loadTodoSearchData().catch(console.error);
        return;
      }

      loadUnifiedSearchData();
      if (kind === "notifications") {
        loadMetaData();
      }
    };
    window.addEventListener(TOOLBOX_DATA_CHANGED, handleDataChanged);
    return () => window.removeEventListener(TOOLBOX_DATA_CHANGED, handleDataChanged);
  }, []);
  }, []);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  };

  const formatDate = (date: Date) => {
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]}`;
  };

  // 当前视图状态：'main' | 'json' | 'todo' | 'password'
  const [activeView, setActiveView] = useState("main");

  // 快捷工具项
  const tools = [
    { id: "json", icon: "✨", label: "JSON 格式化", desc: "粘贴文本格式化" },
    { id: "todo", icon: "☑️", label: "待办事项", desc: "本地待办清单" },
    { id: "password", icon: "🔐", label: "密码管理", desc: "域名账号与备注" },
    { id: "clipboard", icon: "📋", label: "剪切板增强", desc: "复制历史与图片预览" },
    { id: "notepad", icon: "📝", label: "记事本", desc: "快速新建文本" },
    { id: "calc", icon: "🧮", label: "计算器", desc: "打开计算器" },
    { id: "terminal", icon: "🖥️", label: "终端", desc: "命令行面板" },
    { id: "quicklaunch", icon: "📌", label: "快捷访问", desc: "常用程序启动" },
    { id: "pomodoro", icon: "🍅", label: "番茄钟", desc: "专注与休息计时" },
    { id: "settings", icon: "⚙️", label: "系统设置", desc: "Windows 设置" },
  ];

  // 开关项状态：true 表示显示/亮起，false 表示隐藏/暗下
  const [switchStates, setSwitchStates] = useState<Record<string, boolean>>({
    desktop: true, // 初始默认显示
    taskbar: true,
  });

  const switches = [
    { id: "desktop", icon: "👁️", label: "桌面图标", active: switchStates.desktop },
    { id: "taskbar", icon: "🚀", label: "任务栏", active: switchStates.taskbar },
  ];

  const handleToolClick = (toolId: string) => {
    if (toolId === "password") {
      openPasswordManager();
    } else if (toolId === "json" || toolId === "todo" || toolId === "quicklaunch" || toolId === "pomodoro" || toolId === "clipboard") {
      setActiveView(toolId);
    } else {
      let action = "";
      if (toolId === "settings") action = "settings";
      if (toolId === "notepad") action = "notepad";
      if (toolId === "calc") action = "calc";
      if (toolId === "terminal") action = "terminal";

      if (action) {
        invoke("system_action", { action }).catch(console.error);
      }
    }
  };

  const handleSwitchClick = (switchId: string) => {
    // 获取未来的状态并应用到 UI
    const willBeActive = !switchStates[switchId];
    setSwitchStates(prev => ({ ...prev, [switchId]: willBeActive }));

    // 执行对应的系统调用，传入最新的绝对状态
    if (switchId === "desktop") {
      invoke("toggle_desktop", { show: willBeActive }).catch(console.error);
    } else if (switchId === "taskbar") {
      invoke("toggle_taskbar", { show: willBeActive }).catch(console.error);
    }
  };

  // ============================================
  // JSON 格式化器逻辑
  // ============================================
  const [jsonInput, setJsonInput] = useState("");
  const [jsonError, setJsonError] = useState("");

  const formatJson = () => {
    if (!jsonInput.trim()) {
      setJsonError("");
      return;
    }
    try {
      const parsed = JSON.parse(jsonInput);
      setJsonInput(JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch (e: any) {
      setJsonError("无效的 JSON 文本: " + e.message);
    }
  };

  const escapeJson = () => {
    if (!jsonInput) return;
    const escaped = JSON.stringify(jsonInput).slice(1, -1);
    setJsonInput(escaped);
    setJsonError("");
  };

  const unescapeJson = () => {
    if (!jsonInput) return;
    try {
      const parsed = JSON.parse(`"${jsonInput}"`);
      setJsonInput(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch (e) {
      const unescaped = jsonInput
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      setJsonInput(unescaped);
      setJsonError("");
    }
  };

  const renderJsonView = () => (
    <div className="sub-view">
      <div className="sub-view-header">
        <div className="back-btn" onClick={() => setActiveView("main")}>
          <span className="back-icon">←</span> 返回
        </div>
        <h2 className="sub-view-title">JSON 工具</h2>
      </div>
      <div className="sub-view-content json-formatter">
        <textarea 
          className="json-input single-textarea" 
          placeholder="在此粘贴被处理的 JSON 文本..." 
          value={jsonInput}
          onChange={(e) => setJsonInput(e.target.value)}
        />
        <div className="json-btn-group">
          <button className="format-btn" onClick={formatJson}>格式化</button>
          <button className="action-btn" onClick={escapeJson}>转义</button>
          <button className="action-btn" onClick={unescapeJson}>去转义</button>
        </div>
        {jsonError && <div className="json-error">{jsonError}</div>}
      </div>
    </div>
  );

  // ============================================
  // TODO 待办事项逻辑
  // ============================================
  type TodoItem = { id: string; text: string; completed: boolean };
  const [todos, setTodos] = useState<TodoItem[]>(() => {
    try {
      const saved = localStorage.getItem("toolbox_todos");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [todoInput, setTodoInput] = useState("");
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [editingTodoText, setEditingTodoText] = useState("");

  useEffect(() => {
    if (!isClipboardMonitoring) return;

    const insertRecord = async (record: ClipboardRecordInput) => {
      const inserted = await invoke<boolean>("insert_clipboard_record", { record });
      if (inserted) {
        notifyToolboxDataChanged("clipboard");
      }
    };

    const checkClipboard = async () => {
      if (clipboardCheckInFlightRef.current) return;
      clipboardCheckInFlightRef.current = true;

      try {
        const { readText, readImage } = await import("@tauri-apps/plugin-clipboard-manager");

        let hasReadableText = false;
        let insertedText = false;
        try {
          const newText = (await readText()) || "";
          hasReadableText = newText.length > 0;
          if (newText && newText !== lastClipboardContentRef.current) {
            lastClipboardContentRef.current = newText;
            insertedText = true;
            await insertRecord({
              id: crypto.randomUUID(),
              type: "text",
              content: newText.slice(0, 10000),
              timestamp: Date.now(),
              favorite: false,
              pinned: false,
              tags: [],
              group: isCodeSnippet(newText) ? "snippet" : "general",
            });
          }
        } catch {}

        const now = Date.now();
        if (
          insertedText ||
          (hasReadableText && now - lastClipboardImageCheckAtRef.current < CLIPBOARD_IMAGE_POLL_INTERVAL)
        ) {
          return;
        }
        if (now - lastClipboardImageCheckAtRef.current < CLIPBOARD_IMAGE_POLL_INTERVAL) {
          return;
        }
        lastClipboardImageCheckAtRef.current = now;

        try {
          const imageContent = await readClipboardImageAsDataUrl(readImage);
          if (imageContent && imageContent !== lastClipboardContentRef.current) {
            lastClipboardContentRef.current = imageContent;
            await insertRecord({
              id: crypto.randomUUID(),
              type: "image",
              content: imageContent,
              timestamp: Date.now(),
              favorite: false,
              pinned: false,
              tags: [],
              group: "general",
            });
          }
        } catch {}
      } catch (error) {
        console.error(error);
      } finally {
        clipboardCheckInFlightRef.current = false;
      }
    };

    void checkClipboard();
    const interval = window.setInterval(() => {
      void checkClipboard();
    }, CLIPBOARD_TEXT_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [isClipboardMonitoring]);

  const actionResults = useMemo<SearchResult[]>(() => {
    const actions: SearchResult[] = [
      {
        id: "action-open-codec",
        icon: "🔁",
        title: "打开编码转换",
        subtitle: "Base64 与 URL 编码解码",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "view", view: "codec" },
        secondaryAction: { type: "none" },
        score: 40,
      },
      {
        id: "action-open-qrcode",
        icon: "▦",
        title: "打开二维码生成器",
        subtitle: "把文本或链接生成二维码",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "view", view: "qrcode" },
        secondaryAction: { type: "none" },
        score: 40,
      },
      {
        id: "action-open-systeminfo",
        icon: "▥",
        title: "打开本机信息",
        subtitle: "查看 CPU、内存、磁盘与网络",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "view", view: "systeminfo" },
        secondaryAction: { type: "none" },
        score: 40,
      },
      {
        id: "action-open-network",
        icon: "◌",
        title: "打开网络小工具",
        subtitle: "DNS 解析、Ping 与端口检测",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "view", view: "network" },
        secondaryAction: { type: "none" },
        score: 40,
      },
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
        id: "action-open-settings",
        icon: "⚙️",
        title: "打开设置",
        subtitle: "进入设置页面",
        meta: "动作",
        group: "动作",
        category: "actions",
        payload: { type: "view", view: "settings" },
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
    localStorage.setItem("toolbox_todos", JSON.stringify(todos));
  }, [todos]);

  const addTodo = () => {
    if (!todoInput.trim()) return;
    setTodos([{ id: Date.now().toString(), text: todoInput.trim(), completed: false }, ...todos]);
    setTodoInput("");
  };

  const toggleTodo = (id: string) => {
    if (editingTodoId === id) return;
    setTodos(todos.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
  };

  const deleteTodo = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTodos(todos.filter(t => t.id !== id));
  };

  const startEditTodo = (id: string, text: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingTodoId(id);
    setEditingTodoText(text);
  };

  const saveEditTodo = () => {
    if (editingTodoId && editingTodoText.trim()) {
      setTodos(todos.map(t => t.id === editingTodoId ? { ...t, text: editingTodoText.trim() } : t));
    }
    setEditingTodoId(null);
    setEditingTodoText("");
  };

  const cancelEditTodo = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditingTodoId(null);
      setEditingTodoText("");
    }
  };

  const renderTodoView = () => (
    <div className="sub-view">
      <div className="sub-view-header">
        <div className="back-btn" onClick={() => setActiveView("main")}>
          <span className="back-icon">←</span> 返回
        </div>
        <h2 className="sub-view-title">待办事项</h2>
      </div>
      <div className="sub-view-content todo-container">
        <div className="todo-input-group">
          <input 
            type="text" 
            className="todo-input" 
            placeholder="添加新待办，回车保存..." 
            value={todoInput}
            onChange={e => setTodoInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addTodo()}
          />
          <button className="todo-add-btn" onClick={addTodo}>添加</button>
        </div>
        <div className="todo-list">
          {todos.length === 0 && <div className="todo-empty">暂无待办事项，快去添加吧！</div>}
          {todos.map(todo => (
            <div 
              key={todo.id} 
              className={`todo-item ${todo.completed ? 'completed' : ''}`}
              onClick={() => toggleTodo(todo.id)}
            >
              <div className="todo-checkbox">
                {todo.completed && <span className="todo-check-icon">✓</span>}
              </div>
              {editingTodoId === todo.id ? (
                <input
                  autoFocus
                  className="todo-edit-input"
                  value={editingTodoText}
                  onChange={e => setEditingTodoText(e.target.value)}
                  onBlur={saveEditTodo}
                  onKeyDown={e => { if (e.key === 'Enter') saveEditTodo(); cancelEditTodo(e); }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="todo-text">{todo.text}</span>
                  <button 
                    className="todo-edit-btn" 
                    onClick={(e) => startEditTodo(todo.id, todo.text, e)}
                    title="编辑"
                  >
                    ✏️
                  </button>
                  <button 
                    className="todo-delete-btn" 
                    onClick={(e) => deleteTodo(todo.id, e)}
                    title="删除"
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // ============================================
  // 密码管理逻辑
  // ============================================
  type PasswordAccount = { id: string; username: string; password: string; note: string };
  type PasswordDomain = { id: string; domain: string; accounts: PasswordAccount[] };
  type PasswordVault = { domains: PasswordDomain[] };

  const [passwordVault, setPasswordVault] = useState<PasswordVault>({ domains: [] });
  const [passwordVaultReady, setPasswordVaultReady] = useState(false);
  const [passwordAuthError, setPasswordAuthError] = useState("");
  const [passwordSaveError, setPasswordSaveError] = useState("");
  const [selectedPasswordDomainId, setSelectedPasswordDomainId] = useState("");
  const [passwordSearch, setPasswordSearch] = useState("");
  const [newPasswordDomain, setNewPasswordDomain] = useState("");
  const [newAccountUsername, setNewAccountUsername] = useState("");
  const [newAccountPassword, setNewAccountPassword] = useState("");
  const [newAccountNote, setNewAccountNote] = useState("");
  const [visiblePasswordIds, setVisiblePasswordIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!passwordVaultReady) return;
    const exists = passwordVault.domains.some(d => d.id === selectedPasswordDomainId);
    if (!exists) {
      setSelectedPasswordDomainId(passwordVault.domains[0]?.id || "");
    }
  }, [passwordVault, passwordVaultReady, selectedPasswordDomainId]);

  useEffect(() => {
    if (!passwordVaultReady) return;
    const timer = window.setTimeout(() => {
      invoke("save_password_vault", { vault: passwordVault })
        .then(() => setPasswordSaveError(""))
        .catch((e) => setPasswordSaveError(String(e)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [passwordVault, passwordVaultReady]);

  const openPasswordManager = async () => {
    setPasswordAuthError("");
    setPasswordSaveError("");
    isDialogOpenRef.current = true;
    try {
      const authenticated = await invoke<boolean>("authenticate_password_vault");
      if (!authenticated) {
        setPasswordAuthError("系统锁屏密码验证未通过");
        return;
      }

      const loadedVault = await invoke<PasswordVault>("load_password_vault");
      const normalizedVault = loadedVault?.domains ? loadedVault : { domains: [] };
      setPasswordVault(normalizedVault);
      setSelectedPasswordDomainId(normalizedVault.domains[0]?.id || "");
      setPasswordVaultReady(true);
      setActiveView("password");
    } catch (e) {
      setPasswordAuthError(String(e));
    } finally {
      isDialogOpenRef.current = false;
    }
  };

  const lockPasswordManager = () => {
    setActiveView("main");
    setPasswordVaultReady(false);
    setPasswordVault({ domains: [] });
    setSelectedPasswordDomainId("");
    setNewPasswordDomain("");
    setNewAccountUsername("");
    setNewAccountPassword("");
    setNewAccountNote("");
    setVisiblePasswordIds({});
  };

  const addPasswordDomain = () => {
    const domain = newPasswordDomain.trim();
    if (!domain) return;
    const exists = passwordVault.domains.some(d => d.domain.toLowerCase() === domain.toLowerCase());
    if (exists) return;

    const id = Date.now().toString();
    setPasswordVault(prev => ({
      domains: [{ id, domain, accounts: [] }, ...prev.domains],
    }));
    setSelectedPasswordDomainId(id);
    setNewPasswordDomain("");
  };

  const deletePasswordDomain = (domainId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPasswordVault(prev => ({
      domains: prev.domains.filter(domain => domain.id !== domainId),
    }));
  };

  const addPasswordAccount = () => {
    if (!selectedPasswordDomainId || !newAccountUsername.trim() || !newAccountPassword.trim()) return;
    const account: PasswordAccount = {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      username: newAccountUsername.trim(),
      password: newAccountPassword,
      note: newAccountNote.trim(),
    };

    setPasswordVault(prev => ({
      domains: prev.domains.map(domain =>
        domain.id === selectedPasswordDomainId
          ? { ...domain, accounts: [account, ...domain.accounts] }
          : domain
      ),
    }));
    setNewAccountUsername("");
    setNewAccountPassword("");
    setNewAccountNote("");
  };

  const deletePasswordAccount = (domainId: string, accountId: string) => {
    setPasswordVault(prev => ({
      domains: prev.domains.map(domain =>
        domain.id === domainId
          ? { ...domain, accounts: domain.accounts.filter(account => account.id !== accountId) }
          : domain
      ),
    }));
  };

  const copyPassword = async (password: string) => {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(password);
    } catch (e) {
      setPasswordSaveError(String(e));
    }
  };

  const filteredPasswordDomains = passwordVault.domains.filter(domain => {
    const keyword = passwordSearch.trim().toLowerCase();
    if (!keyword) return true;
    return (
      domain.domain.toLowerCase().includes(keyword) ||
      domain.accounts.some(account =>
        account.username.toLowerCase().includes(keyword) ||
        account.note.toLowerCase().includes(keyword)
      )
    );
  });
  const selectedPasswordDomain = passwordVault.domains.find(domain => domain.id === selectedPasswordDomainId);

  const renderPasswordView = () => (
    <div className="sub-view password-split-view">
      <div className="password-sidebar">
        <div className="password-sidebar-header">
          <div className="back-btn" onClick={lockPasswordManager}>
            <span className="back-icon">←</span> 返回
          </div>
          <h2 className="sub-view-title">密码管理</h2>
        </div>

        <div className="password-search-wrap">
          <input
            className="password-search-input"
            placeholder="搜索域名或账号..."
            value={passwordSearch}
            onChange={e => setPasswordSearch(e.target.value)}
          />
        </div>

        <div className="password-domain-add">
          <input
            className="password-domain-input"
            placeholder="添加域名..."
            value={newPasswordDomain}
            onChange={e => setNewPasswordDomain(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addPasswordDomain()}
          />
          <button className="password-icon-btn" onClick={addPasswordDomain} title="添加域名">+</button>
        </div>

        <div className="password-domain-list">
          {filteredPasswordDomains.length === 0 && (
            <div className="password-empty small">暂无域名</div>
          )}
          {filteredPasswordDomains.map(domain => (
            <div
              key={domain.id}
              className={`password-domain-item ${selectedPasswordDomainId === domain.id ? 'active' : ''}`}
              onClick={() => setSelectedPasswordDomainId(domain.id)}
            >
              <div className="password-domain-text">
                <span className="password-domain-name">{domain.domain}</span>
                <span className="password-domain-count">{domain.accounts.length} 个账号</span>
              </div>
              <button
                className="password-domain-delete"
                onClick={(e) => deletePasswordDomain(domain.id, e)}
                title="删除域名"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="password-main">
        <div className="password-main-header">
          <div>
            <h2 className="sub-view-title">{selectedPasswordDomain?.domain || "选择一个域名"}</h2>
            <div className="password-header-meta">
              {selectedPasswordDomain ? `${selectedPasswordDomain.accounts.length} 个账号` : "先添加域名，再添加账号"}
            </div>
          </div>
          <button className="password-lock-btn" onClick={lockPasswordManager}>锁定</button>
        </div>

        <div className="sub-view-content password-content">
          {passwordSaveError && <div className="password-error">{passwordSaveError}</div>}

          {selectedPasswordDomain ? (
            <>
              <div className="password-account-form">
                <input
                  className="password-form-input"
                  placeholder="账号 / 用户名"
                  value={newAccountUsername}
                  onChange={e => setNewAccountUsername(e.target.value)}
                />
                <input
                  className="password-form-input"
                  type="password"
                  placeholder="密码"
                  value={newAccountPassword}
                  onChange={e => setNewAccountPassword(e.target.value)}
                />
                <input
                  className="password-form-input note"
                  placeholder="备注（可选）"
                  value={newAccountNote}
                  onChange={e => setNewAccountNote(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addPasswordAccount()}
                />
                <button className="password-add-account-btn" onClick={addPasswordAccount}>添加账号</button>
              </div>

              <div className="password-account-list">
                {selectedPasswordDomain.accounts.length === 0 && (
                  <div className="password-empty">这个域名下还没有账号</div>
                )}
                {selectedPasswordDomain.accounts.map(account => {
                  const isVisible = !!visiblePasswordIds[account.id];
                  return (
                    <div className="password-account-item" key={account.id}>
                      <div className="password-account-top">
                        <div className="password-account-user">{account.username}</div>
                        <div className="password-account-actions">
                          <button
                            className="password-small-btn"
                            onClick={() => setVisiblePasswordIds(prev => ({ ...prev, [account.id]: !prev[account.id] }))}
                          >
                            {isVisible ? "隐藏" : "显示"}
                          </button>
                          <button className="password-small-btn" onClick={() => copyPassword(account.password)}>
                            复制
                          </button>
                          <button
                            className="password-delete-account"
                            onClick={() => deletePasswordAccount(selectedPasswordDomain.id, account.id)}
                            title="删除账号"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                      <div className="password-value">
                        {isVisible ? account.password : "•".repeat(Math.min(Math.max(account.password.length, 8), 24))}
                      </div>
                      <div className="password-note">{account.note || "无备注"}</div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="password-empty">左侧添加或选择一个域名</div>
          )}
        </div>
      </div>
    </div>
  );

  // ============================================
  // 快捷访问逻辑
  // ============================================
  type QuickLaunchGroup = { id: string; name: string };
  type QuickLaunchItem = { id: string; name: string; path: string; icon?: string; groupId?: string };

  const [quickLaunchGroups, setQuickLaunchGroups] = useState<QuickLaunchGroup[]>(() => {
    try {
      const saved = localStorage.getItem("toolbox_quicklaunch_groups");
      return saved ? JSON.parse(saved) : [{ id: "default", name: "默认分组" }];
    } catch {
      return [{ id: "default", name: "默认分组" }];
    }
  });

  const [activeGroupId, setActiveGroupId] = useState("default");

  const [quickLaunchItems, setQuickLaunchItems] = useState<QuickLaunchItem[]>(() => {
    try {
      const saved = localStorage.getItem("toolbox_quicklaunch");
      return saved ? JSON.parse(saved) : [];
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

  const updateSidebarWidth = (width: number) => {
    const nextWidth = Math.max(280, Math.min(1200, Math.round(width)));
    setSidebarWidth(nextWidth);
    void invoke("resize_sidebar", { width: nextWidth }).catch(console.error);
  };

  const updateClipboardMonitoring = (value: boolean | ((current: boolean) => boolean)) => {
    setIsClipboardMonitoring((current) => {
      const next = typeof value === "function" ? value(current) : value;
      void invoke("set_setting", {
        key: "clipboard_monitoring",
        value: next ? "true" : "false",
      }).catch(console.error);
      return next;
    });
  };

  const updateToolOrder = (nextOrder: ToolId[]) => {
    const normalizedOrder = normalizeToolOrder(nextOrder);
    setToolOrder(normalizedOrder);
    void invoke("set_setting", {
      key: TOOL_ORDER_SETTING_KEY,
      value: JSON.stringify(normalizedOrder),
    }).catch(console.error);
  };

  const resetToolOrder = () => {
    updateToolOrder(DEFAULT_TOOL_ORDER);
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
          lastClipboardContentRef.current = resolved.payload.content;
          break;
        case "clipboard-image":
          await writeClipboardImage(resolved.payload.content);
          lastClipboardContentRef.current = resolved.payload.content;
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
      setCommandQuery("");
      setIsCommandPaletteOpen(false);
      searchInputRef.current?.blur();
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
    codec: <CodecToolView onBack={() => setActiveView("main")} />,
    qrcode: <QrCodeView onBack={() => setActiveView("main")} />,
    systeminfo: <SystemInfoView onBack={() => setActiveView("main")} />,
    network: <NetworkToolView onBack={() => setActiveView("main")} />,
    todo: <TodoView onBack={() => setActiveView("main")} />,
    clipboard: (
      <ClipboardView
        onBack={() => setActiveView("main")}
        isMonitoring={isClipboardMonitoring}
        defaultDateFilter={clipboardDefaultDateFilter}
        onMonitoringChange={updateClipboardMonitoring}
        onClipboardContentWritten={(content) => {
          lastClipboardContentRef.current = content;
        }}
      />
    ),
    textmanager: <TextManagerView onBack={() => setActiveView("main")} />,
    quicklaunch: (
      <QuickLaunchView
        onBack={() => setActiveView("main")}
        isDialogOpenRef={isDialogOpenRef}
      />
    ),
    pomodoro: <PomodoroView onBack={() => setActiveView("main")} />,
    settings: (
      <SettingsView
        onBack={() => setActiveView("main")}
        sidebarWidth={sidebarWidth}
        clipboardMonitoring={isClipboardMonitoring}
        clipboardDefaultDateFilter={clipboardDefaultDateFilter}
        tools={orderedTools}
        onSidebarWidthChange={updateSidebarWidth}
        onClipboardMonitoringChange={updateClipboardMonitoring}
        onClipboardDefaultDateFilterChange={setClipboardDefaultDateFilter}
        onToolOrderChange={updateToolOrder}
        onToolOrderReset={resetToolOrder}
      />
    ),
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
            tools={orderedTools}
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
            onToolOrderManage={() => setActiveView("settings")}
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
          <div className="main-view">
            {/* 上侧：功能区 (约 80%) */}
            <div className="functional-area">
              <header className="sidebar-header">
                <div className="time-display">{formatTime(currentTime)}</div>
                <div className="date-display">{formatDate(currentTime)}</div>
              </header>

              <section className="tools-section">
                <h2 className="section-title">
                  <span className="section-icon">⚡</span>
                  功能区
                </h2>
                <div className="tools-grid">
                  {tools.map((tool, index) => (
                    <div
                      className="tool-card"
                      key={index}
                      onClick={() => handleToolClick(tool.id)}
                    >
                      <div className="tool-icon">{tool.icon}</div>
                      <div className="tool-info">
                        <span className="tool-label">{tool.label}</span>
                        <span className="tool-desc">{tool.desc}</span>
                      </div>
                    </div>
                  ))}
                </div>
                {passwordAuthError && <div className="main-error">{passwordAuthError}</div>}
              </section>

              <section className="shortcuts-section">
                <h2 className="section-title">
                  <span className="section-icon">⌨️</span>
                  快捷键
                </h2>
                <div className="shortcut-list">
                  <div className="shortcut-item">
                    <span className="shortcut-label">显示/隐藏</span>
                    <kbd className="shortcut-key">Alt + Space</kbd>
                  </div>
                </div>
              </section>
            </div>

            {/* 下侧：开关区 (约 20%) */}
            <div className="switches-area">
              <h2 className="section-title">
                <span className="section-icon">🎛️</span>
                开关区
              </h2>
              <div className="switch-grid">
                {switches.map((sw, index) => (
                  <div
                    className={`switch-card ${sw.active ? 'active' : ''}`}
                    key={index}
                    onClick={() => handleSwitchClick(sw.id)}
                  >
                    <div className="content-left">
                      <div className="switch-icon">{sw.icon}</div>
                      <div className="switch-label">{sw.label}</div>
                    </div>
                    <div className="switch-toggle-track">
                      <div className="switch-toggle-thumb" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : activeView === "json" ? (
          renderJsonView()
        ) : activeView === "todo" ? (
          renderTodoView()
        ) : activeView === "password" ? (
          renderPasswordView()
        ) : activeView === "clipboard" ? (
          renderClipboardView()
        ) : activeView === "quicklaunch" ? (
          renderQuickLaunchView()
        ) : activeView === "pomodoro" ? (
          renderPomodoroView()
        ) : null}
      </div>
    </div>
  );
}

export default App;
