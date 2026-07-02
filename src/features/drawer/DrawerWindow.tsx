import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type ItemType = "app" | "folder" | "file";
type OpenMode = "internal" | "external";

interface LauncherItem {
  id: string;
  name: string;
  path: string;
  args: string;
  item_type: ItemType;
  open_mode: OpenMode | null;
  order: number;
}

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] === q[qi]) {
      qi += 1;
      streak += 1;
      score += 1 + streak;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return -1;
  if (t.startsWith(q)) score += 60;
  return score;
}

function lastSegment(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function TypeIcon({ type }: { type: ItemType | "dir" | "file" }) {
  if (type === "folder" || type === "dir") {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="currentColor" d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.7a1.5 1.5 0 0 1 1.06.44L11.7 6.9l7.8.1A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
      </svg>
    );
  }
  if (type === "app") {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="currentColor" d="M3 5h18v14H3zm2 2v2h14V7zm0 4v6h14v-6z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5z" />
    </svg>
  );
}

export default function DrawerWindow() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LauncherItem[]>([]);
  const [query, setQuery] = useState("");
  const [defaultMode, setDefaultMode] = useState<OpenMode>("external");
  const [drillPath, setDrillPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const syncHeight = () => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    if (rect.height <= 0) return;
    const width = rect.width + 96;
    const height = rect.height + 12;
    void invoke("resize_drawer_to_content", { width, height }).catch(console.error);
  };

  const refreshItems = useCallback(async () => {
    try {
      const data = await invoke<LauncherItem[]>("launcher_load");
      setItems(data);
      const mode = await invoke<string>("launcher_get_default_open_mode");
      setDefaultMode(mode === "internal" ? "internal" : "external");
    } catch (error) {
      console.error("[launcher] 加载失败:", error);
    }
  }, []);

  const closeDrawer = useCallback(() => setOpen(false), []);

  const drillInto = useCallback(async (path: string) => {
    try {
      const list = await invoke<DirEntry[]>("launcher_list_dir", { path });
      setEntries(list);
      setDrillPath(path);
      setQuery("");
    } catch (error) {
      console.error("[launcher] 读取目录失败:", error);
    }
  }, []);

  const goHome = useCallback(() => {
    setDrillPath(null);
    setEntries([]);
    setQuery("");
  }, []);

  const openItem = useCallback(
    async (item: LauncherItem) => {
      const mode = item.open_mode ?? defaultMode;
      if (item.item_type === "folder" && mode === "internal") {
        await drillInto(item.path);
        return;
      }
      try {
        await invoke("launcher_launch", { id: item.id });
      } catch (error) {
        console.error("[launcher] 启动失败:", error);
      }
      closeDrawer();
    },
    [defaultMode, drillInto, closeDrawer]
  );

  const openEntry = useCallback(
    async (entry: DirEntry) => {
      if (entry.is_dir) {
        await drillInto(entry.path);
        return;
      }
      try {
        await invoke("launcher_open_external", { path: entry.path });
      } catch (error) {
        console.error("[launcher] 打开失败:", error);
      }
      closeDrawer();
    },
    [drillInto, closeDrawer]
  );

  const removeItem = useCallback(async (id: string) => {
    try {
      const data = await invoke<LauncherItem[]>("launcher_remove", { id });
      setItems(data);
    } catch (error) {
      console.error("[launcher] 删除失败:", error);
    }
  }, []);

  useEffect(() => {
    console.log("[drawer] DrawerWindow mounted");
    void refreshItems();

    const unlistenToggle = listen("toggle-drawer", () => {
      console.log("[drawer] 收到 toggle-drawer 事件");
      setOpen((current) => !current);
      syncHeight();
    });
    unlistenToggle
      .then(() => console.log("[drawer] listener 注册成功"))
      .catch((error) => console.error("[drawer] listener 注册失败:", error));

    const win = getCurrentWebviewWindow();
    const unlistenDrag = win.onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") {
        setDragOver(true);
      } else if (payload.type === "leave") {
        setDragOver(false);
      } else if (payload.type === "drop") {
        setDragOver(false);
        const paths = payload.paths;
        if (paths && paths.length) {
          invoke<LauncherItem[]>("launcher_add_paths", { paths })
            .then(setItems)
            .catch((error) => console.error("[launcher] 添加失败:", error));
        }
      }
    });

    syncHeight();
    const panel = panelRef.current;
    let observer: ResizeObserver | null = null;
    if (panel) {
      observer = new ResizeObserver(syncHeight);
      observer.observe(panel);
    }

    return () => {
      observer?.disconnect();
      unlistenDrag.then((fn) => fn()).catch(() => {});
      unlistenToggle.then((fn) => fn()).catch(() => {});
    };
  }, [refreshItems]);

  // 打开时刷新数据并重置搜索/下钻
  useEffect(() => {
    if (!open) return;
    void refreshItems();
    setQuery("");
    setDrillPath(null);
    setEntries([]);
  }, [open, refreshItems]);

  // 关闭动画结束后通知 Rust 隐藏窗口
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      void invoke("hide_drawer").catch(console.error);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 全局键盘：Esc 返回/收起；可打印字符聚焦搜索框并补入
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (drillPath) {
          setDrillPath(null);
          setEntries([]);
        } else {
          setOpen(false);
        }
        return;
      }
      const focused = document.activeElement === searchRef.current;
      if (
        !focused &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        /\S/.test(event.key)
      ) {
        event.preventDefault();
        setQuery((prev) => prev + event.key);
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, drillPath]);

  const filteredItems = useMemo(() => {
    if (!query) return items;
    return items
      .map((item) => ({
        item,
        score: Math.max(fuzzyScore(query, item.name) * 2, fuzzyScore(query, item.path)),
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }, [items, query]);

  const filteredEntries = useMemo(() => {
    if (!query) return entries;
    return entries
      .map((entry) => ({ entry, score: fuzzyScore(query, entry.name) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.entry);
  }, [entries, query]);

  const drilling = drillPath !== null;
  const displayList = drilling ? filteredEntries : filteredItems;

  const emptyText = (() => {
    if (dragOver) return null;
    if (drilling) {
      if (!entries.length) return "空文件夹";
      return filteredEntries.length ? null : "无匹配结果";
    }
    if (!items.length) return "拖入文件 / 文件夹 / 快捷方式来添加";
    return filteredItems.length ? null : "无匹配结果";
  })();

  return (
    <div className={`drawer-window ${open ? "is-open" : "is-closed"}`}>
      <div className="drawer-window-backdrop" onClick={() => setOpen(false)} />
      <div
        ref={panelRef}
        className={`drawer-panel ${open ? "open" : "closed"} ${dragOver ? "dragover" : ""}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-grip" />

        <div className="drawer-hero launcher-hero">
          <div className="drawer-brand">
            <div className="drawer-logo" aria-hidden="true">✦</div>
            <div className="drawer-brand-copy">
              <div className="drawer-title">快捷启动</div>
              <div className="drawer-subtitle">拖入即可添加 · 即搜即开</div>
            </div>
          </div>
          <button className="drawer-close" onClick={() => setOpen(false)} title="收起 (Esc)">×</button>
        </div>

        <div className="launcher-search">
          <svg className="launcher-search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M10 2a8 8 0 1 0 4.9 14.32l5.39 5.39 1.42-1.42-5.39-5.39A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z" />
          </svg>
          <input
            ref={searchRef}
            className="launcher-input"
            type="text"
            placeholder={drilling ? "筛选当前文件夹…" : "搜索名称或路径…"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && !query && drilling) {
                goHome();
              }
            }}
            spellCheck={false}
          />
        </div>

        {drilling && (
          <div className="launcher-breadcrumb">
            <button className="launcher-back" onClick={goHome} title="返回列表">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path fill="currentColor" d="M15.5 4.5L8 12l7.5 7.5 1.4-1.4L10.8 12l6.1-6.1z" />
              </svg>
              全部
            </button>
            <span className="launcher-crumb-sep">/</span>
            <span className="launcher-crumb" title={drillPath ?? ""}>{lastSegment(drillPath ?? "")}</span>
          </div>
        )}

        <div className="launcher-list">
          {displayList.map((row) => {
            const isItem = !drilling;
            const item = isItem ? (row as LauncherItem) : null;
            const entry = !isItem ? (row as DirEntry) : null;
            const name = item ? item.name : entry ? entry.name : "";
            const sub = item ? item.path : entry ? entry.path : "";
            const iconType = item ? item.item_type : entry ? (entry.is_dir ? "dir" : "file") : "file";
            return (
              <button
                key={item ? item.id : entry ? entry.path : name}
                className="launcher-item"
                onClick={() => (item ? openItem(item) : entry ? openEntry(entry) : undefined)}
                title={sub}
              >
                <span className="launcher-item-icon">
                  <TypeIcon type={iconType} />
                </span>
                <span className="launcher-item-text">
                  <span className="launcher-item-name">{name}</span>
                  <span className="launcher-item-path">{sub}</span>
                </span>
                {item && (
                  <span
                    className="launcher-item-del"
                    role="button"
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeItem(item.id);
                    }}
                    title="移除"
                  >
                    ×
                  </span>
                )}
              </button>
            );
          })}
          {emptyText && <div className="launcher-empty">{emptyText}</div>}
        </div>

        <div className="drawer-footer">
          <kbd>Alt</kbd>+<kbd>Q</kbd> 切换 · <kbd>Esc</kbd> 返回/收起 · 拖入文件添加
        </div>
      </div>
    </div>
  );
}
