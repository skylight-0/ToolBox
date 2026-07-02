import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type ItemType = "app" | "folder" | "file";
type OpenMode = "internal" | "external";

const DEFAULT_GROUP_ID = "default";

interface LauncherItem {
  id: string;
  name: string;
  path: string;
  args: string;
  item_type: ItemType;
  open_mode: OpenMode | null;
  order: number;
  group_id: string | null;
  icon: string | null;
}

interface LauncherGroup {
  id: string;
  name: string;
  order: number;
}

interface LauncherState {
  items: LauncherItem[];
  groups: LauncherGroup[];
}

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface ContextMenu {
  itemId: string;
  x: number;
  y: number;
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
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path fill="currentColor" d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.7a1.5 1.5 0 0 1 1.06.44L11.7 6.9l7.8.1A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
      </svg>
    );
  }
  if (type === "app") {
    return (
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path fill="currentColor" d="M3 5h18v14H3zm2 2v2h14V7zm0 4v6h14v-6z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path fill="currentColor" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5z" />
    </svg>
  );
}

function groupKeyOf(item: LauncherItem): string {
  return item.group_id ?? DEFAULT_GROUP_ID;
}

export default function DrawerWindow() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LauncherState>({ items: [], groups: [] });
  const [query, setQuery] = useState("");
  const [defaultMode, setDefaultMode] = useState<OpenMode>("external");
  const [drillPath, setDrillPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const syncHeight = () => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    if (rect.height <= 0) return;
    const width = rect.width + 96;
    const height = rect.height + 12;
    void invoke("resize_drawer_to_content", { width, height }).catch(console.error);
  };

  const persist = useCallback(async (next: LauncherState) => {
    setState(next);
    try {
      const saved = await invoke<LauncherState>("launcher_save", { state: next });
      setState(saved);
    } catch (error) {
      console.error("[launcher] 保存失败:", error);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await invoke<LauncherState>("launcher_load");
      setState(data);
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

  // 分组：重命名
  const commitRename = useCallback(
    (groupId: string) => {
      const name = draftName.trim() || "未命名分组";
      setEditingGroupId(null);
      const next: LauncherState = {
        items: state.items,
        groups: state.groups.map((g) => (g.id === groupId ? { ...g, name } : g)),
      };
      void persist(next);
    },
    [draftName, state, persist]
  );

  // 分组：新建
  const addGroup = useCallback(() => {
    const id = crypto.randomUUID();
    const order = state.groups.reduce((m, g) => Math.max(m, g.order), 0) + 1;
    const next: LauncherState = {
      items: state.items,
      groups: [...state.groups, { id, name: "新分组", order }],
    };
    setEditingGroupId(id);
    setDraftName("新分组");
    void persist(next);
  }, [state, persist]);

  // 分组：删除（条目回收至默认分组）
  const deleteGroup = useCallback(
    (groupId: string) => {
      if (groupId === DEFAULT_GROUP_ID) return;
      const next: LauncherState = {
        items: state.items.map((i) =>
          groupKeyOf(i) === groupId ? { ...i, group_id: null } : i
        ),
        groups: state.groups.filter((g) => g.id !== groupId),
      };
      void persist(next);
    },
    [state, persist]
  );

  // 条目：移动到分组
  const moveItem = useCallback(
    (itemId: string, groupId: string) => {
      setMenu(null);
      const target = groupId === DEFAULT_GROUP_ID ? null : groupId;
      const next: LauncherState = {
        items: state.items.map((i) =>
          i.id === itemId ? { ...i, group_id: target } : i
        ),
        groups: state.groups,
      };
      void persist(next);
    },
    [state, persist]
  );

  // 条目：移除
  const removeItem = useCallback(
    (itemId: string) => {
      setMenu(null);
      const next: LauncherState = {
        items: state.items.filter((i) => i.id !== itemId),
        groups: state.groups,
      };
      void persist(next);
    },
    [state, persist]
  );

  useEffect(() => {
    console.log("[drawer] DrawerWindow mounted");
    void refresh();

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
          invoke<LauncherState>("launcher_add_paths", { paths })
            .then(setState)
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
  }, [refresh]);

  // 打开时刷新并重置
  useEffect(() => {
    if (!open) return;
    void refresh();
    setQuery("");
    setDrillPath(null);
    setEntries([]);
    setMenu(null);
    setEditingGroupId(null);
  }, [open, refresh]);

  // 关闭动画结束后隐藏窗口
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      void invoke("hide_drawer").catch(console.error);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 编辑分组名时自动聚焦
  useEffect(() => {
    if (editingGroupId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingGroupId]);

  // 关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  // 全局键盘：Esc 返回/收起；可打印字符聚焦搜索框
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (menu) {
          setMenu(null);
        } else if (editingGroupId) {
          setEditingGroupId(null);
        } else if (drillPath) {
          setDrillPath(null);
          setEntries([]);
        } else {
          setOpen(false);
        }
        return;
      }
      if (editingGroupId) return;
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
  }, [open, drillPath, menu, editingGroupId]);

  const groupsSorted = useMemo(
    () => state.groups.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [state.groups]
  );

  const itemsByGroup = useMemo(() => {
    const map = new Map<string, LauncherItem[]>();
    for (const item of state.items) {
      const key = groupKeyOf(item);
      const arr = map.get(key) ?? [];
      arr.push(item);
      map.set(key, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    }
    return map;
  }, [state.items]);

  const filteredItems = useMemo(() => {
    if (!query) return null;
    return state.items
      .map((item) => ({
        item,
        score: Math.max(fuzzyScore(query, item.name) * 2, fuzzyScore(query, item.path)),
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }, [state.items, query]);

  const filteredEntries = useMemo(() => {
    if (!query) return entries;
    return entries
      .map((entry) => ({ entry, score: fuzzyScore(query, entry.name) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.entry);
  }, [entries, query]);

  const drilling = drillPath !== null;
  const searching = !!query && !drilling;
  const menuItem = menu ? state.items.find((i) => i.id === menu.itemId) ?? null : null;

  const renderTile = (key: string, label: string, sub: string, iconType: ItemType | "dir" | "file", onClick: () => void, onContext?: (e: React.MouseEvent) => void, icon?: string | null) => (
    <button
      key={key}
      className="launcher-tile"
      onClick={onClick}
      onContextMenu={onContext}
      title={sub}
    >
      <span className="launcher-tile-icon" data-type={iconType}>
        {icon && icon.length > 0 ? (
          <img className="launcher-tile-img" src={icon} alt="" draggable={false} />
        ) : (
          <TypeIcon type={iconType} />
        )}
      </span>
      <span className="launcher-tile-label">{label}</span>
    </button>
  );

  const homeEmpty = !state.items.length && !dragOver;

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
              if (event.key === "Backspace" && !query && drilling) goHome();
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

        <div className="launcher-scroll">
          {drilling ? (
            <div className="launcher-grid">
              {filteredEntries.map((entry) =>
                renderTile(
                  entry.path,
                  entry.name,
                  entry.path,
                  entry.is_dir ? "dir" : "file",
                  () => void openEntry(entry)
                )
              )}
              {!filteredEntries.length && (
                <div className="launcher-empty">{entries.length ? "无匹配结果" : "空文件夹"}</div>
              )}
            </div>
          ) : searching ? (
            <div className="launcher-grid">
              {filteredItems?.map((item) =>
                renderTile(item.id, item.name, item.path, item.item_type, () => void openItem(item), undefined, item.icon)
              )}
              {!filteredItems?.length && <div className="launcher-empty">无匹配结果</div>}
            </div>
          ) : (
            <div className="launcher-groups">
              {groupsSorted.map((group) => {
                const list = itemsByGroup.get(group.id) ?? [];
                return (
                  <section className="launcher-group" key={group.id}>
                    <header className="launcher-group-header">
                      {editingGroupId === group.id ? (
                        <input
                          ref={editRef}
                          className="launcher-group-name-input"
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          onBlur={() => commitRename(group.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename(group.id);
                            } else if (e.key === "Escape") {
                              setEditingGroupId(null);
                            }
                          }}
                        />
                      ) : (
                        <button
                          className="launcher-group-name"
                          onClick={() => {
                            setEditingGroupId(group.id);
                            setDraftName(group.name);
                          }}
                          title="点击重命名"
                        >
                          {group.name}
                        </button>
                      )}
                      {group.id !== DEFAULT_GROUP_ID && (
                        <button
                          className="launcher-group-del"
                          onClick={() => deleteGroup(group.id)}
                          title="删除分组（条目移入常用）"
                        >
                          ×
                        </button>
                      )}
                    </header>
                    <div className="launcher-grid">
                      {list.map((item) =>
                        renderTile(
                          item.id,
                          item.name,
                          item.path,
                          item.item_type,
                          () => void openItem(item),
                          (e) => {
                            e.preventDefault();
                            setMenu({ itemId: item.id, x: e.clientX, y: e.clientY });
                          },
                          item.icon
                        )
                      )}
                      {!list.length && <div className="launcher-empty">拖入文件添加到该分组</div>}
                    </div>
                  </section>
                );
              })}
              <button className="launcher-add-group" onClick={addGroup}>＋ 新建分组</button>
              {homeEmpty && <div className="launcher-empty launcher-empty-hero">拖入文件 / 文件夹 / 快捷方式来添加</div>}
            </div>
          )}
        </div>

        <div className="drawer-footer">
          <kbd>Alt</kbd>+<kbd>Q</kbd> 切换 · <kbd>Esc</kbd> 返回/收起 · 右键图标可移动分组
        </div>
      </div>

      {menu && menuItem && (
        <div
          className="launcher-ctx"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="launcher-ctx-title">移动到分组</div>
          {groupsSorted.map((g) => (
            <button
              key={g.id}
              className={`launcher-ctx-item ${groupKeyOf(menuItem) === g.id ? "active" : ""}`}
              onClick={() => moveItem(menuItem.id, g.id)}
            >
              {g.name}
            </button>
          ))}
          <div className="launcher-ctx-sep" />
          <button className="launcher-ctx-item danger" onClick={() => removeItem(menuItem.id)}>
            移除
          </button>
        </div>
      )}
    </div>
  );
}
