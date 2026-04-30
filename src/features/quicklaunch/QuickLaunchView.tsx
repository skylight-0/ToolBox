import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MutableRefObject, MouseEvent } from "react";
import { notifyToolboxDataChanged } from "../../utils/dataSync";

type QuickLaunchViewProps = {
  onBack: () => void;
  isDialogOpenRef: MutableRefObject<boolean>;
};

type QuickLaunchGroup = {
  id: string;
  name: string;
};

type QuickLaunchItemType = "app" | "folder" | "url" | "script";
type QuickLaunchViewMode = "group" | "recent" | "frequent";

type QuickLaunchItem = {
  id: string;
  name: string;
  path: string;
  icon?: string;
  alias?: string;
  itemType?: QuickLaunchItemType;
  args?: string;
  groupId?: string;
  sortOrder?: number;
  launchCount?: number;
  lastLaunchedAt?: number;
};

type QuickLaunchDraft = {
  id?: string;
  name: string;
  path: string;
  alias: string;
  itemType: QuickLaunchItemType;
  args: string;
  groupId: string;
};

function normalizeQuickLaunchItems(items: QuickLaunchItem[]) {
  return items.map((item, index) => ({
    ...item,
    alias: item.alias || "",
    itemType: item.itemType || "app",
    args: item.args || "",
    groupId: item.groupId || "default",
    sortOrder: item.sortOrder ?? index,
    launchCount: item.launchCount || 0,
    lastLaunchedAt: item.lastLaunchedAt || 0,
  }));
}

// function formatRecentTime(timestamp?: number) {
//   if (!timestamp) return "未启动过";
//   const date = new Date(timestamp);
//   return date.toLocaleDateString("zh-CN", {
//     month: "2-digit",
//     day: "2-digit",
//     hour: "2-digit",
//     minute: "2-digit",
//   });
// }

function getDefaultIcon(itemType: QuickLaunchItemType) {
  if (itemType === "folder") return "📁";
  if (itemType === "url") return "🌐";
  if (itemType === "script") return "🧾";
  return "📄";
}

function createNotification(level: string, title: string, message: string, source: string) {
  return {
    id: `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    level,
    title,
    message,
    source,
    createdAt: Date.now(),
    read: false,
  };
}

function getNextSortOrder(items: QuickLaunchItem[], groupId: string) {
  return items
    .filter((item) => (item.groupId || "default") === groupId)
    .reduce((max, item) => Math.max(max, item.sortOrder || 0), -1) + 1;
}

function reindexGroup(items: QuickLaunchItem[], groupId: string) {
  const targetGroupId = groupId || "default";
  const groupItems = items
    .filter((item) => (item.groupId || "default") === targetGroupId)
    .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0))
    .map((item, index) => ({ ...item, sortOrder: index }));
  const others = items.filter((item) => (item.groupId || "default") !== targetGroupId);
  return [...others, ...groupItems];
}

function QuickLaunchView({ onBack, isDialogOpenRef }: QuickLaunchViewProps) {
  const [quickLaunchGroups, setQuickLaunchGroups] = useState<QuickLaunchGroup[]>([
    { id: "default", name: "默认分组" },
  ]);
  const [activeGroupId, setActiveGroupId] = useState("default");
  const [activeMode, setActiveMode] = useState<QuickLaunchViewMode>("group");
  const [quickLaunchItems, setQuickLaunchItems] = useState<QuickLaunchItem[]>([]);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [isAddingGroup, setIsAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [draft, setDraft] = useState<QuickLaunchDraft | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const quickLaunchGroupsRef = useRef<QuickLaunchGroup[]>([{ id: "default", name: "默认分组" }]);
  const quickLaunchItemsRef = useRef<QuickLaunchItem[]>([]);

  useEffect(() => {
    invoke<{ groups: QuickLaunchGroup[]; items: QuickLaunchItem[] }>("get_quicklaunch_data")
      .then((data) => {
        const nextGroups = data.groups.length ? data.groups : [{ id: "default", name: "默认分组" }];
        const nextItems = normalizeQuickLaunchItems(data.items);
        quickLaunchGroupsRef.current = nextGroups;
        quickLaunchItemsRef.current = nextItems;
        setQuickLaunchGroups(nextGroups);
        setQuickLaunchItems(nextItems);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    quickLaunchGroupsRef.current = quickLaunchGroups;
  }, [quickLaunchGroups]);

  useEffect(() => {
    quickLaunchItemsRef.current = quickLaunchItems;
  }, [quickLaunchItems]);

  const emitNotification = async (level: string, title: string, message: string) => {
    try {
      await invoke("insert_notification", {
        notification: createNotification(level, title, message, "quicklaunch"),
      });
    } catch (error) {
      console.error(error);
    }
  };

  const persistQuickLaunchData = (
    nextGroups: QuickLaunchGroup[],
    nextItems: QuickLaunchItem[],
    options?: { silent?: boolean },
  ) => {
    const normalizedItems = normalizeQuickLaunchItems(nextItems);
    quickLaunchGroupsRef.current = nextGroups;
    quickLaunchItemsRef.current = normalizedItems;
    setQuickLaunchGroups(nextGroups);
    setQuickLaunchItems(normalizedItems);
    void invoke("save_quicklaunch_data", {
      data: { groups: nextGroups, items: normalizedItems },
    })
      .then(() => notifyToolboxDataChanged("quicklaunch"))
      .catch(async (error) => {
        console.error(error);
        if (!options?.silent) {
          await emitNotification("error", "保存快捷访问失败", String(error));
        }
      });
  };

  const requestIcon = async (item: QuickLaunchItem) => {
    if (!["app", "script"].includes(item.itemType || "app")) return;
    try {
      const icon = await invoke<string>("extract_program_icon", { path: item.path });
      const nextItems = quickLaunchItemsRef.current.map((currentItem) =>
        currentItem.id === item.id ? { ...currentItem, icon } : currentItem,
      );
      persistQuickLaunchData(quickLaunchGroupsRef.current, nextItems, { silent: true });
    } catch {
      // ignore icon extraction failures
    }
  };

  const saveEditGroup = (id: string) => {
    if (editingGroupName.trim()) {
      persistQuickLaunchData(
        quickLaunchGroups.map((group) =>
          group.id === id ? { ...group, name: editingGroupName.trim() } : group,
        ),
        quickLaunchItems,
      );
    }
    setEditingGroupId(null);
  };

  const saveNewGroup = () => {
    if (newGroupName.trim()) {
      const id = Date.now().toString();
      persistQuickLaunchData(
        [...quickLaunchGroups, { id, name: newGroupName.trim() }],
        quickLaunchItems,
      );
      setActiveGroupId(id);
    }
    setIsAddingGroup(false);
    setNewGroupName("");
  };

  const deleteGroup = (groupId: string) => {
    const nextItems = reindexGroup(
      quickLaunchItems.map((item) =>
        item.groupId === groupId
          ? { ...item, groupId: "default", sortOrder: getNextSortOrder(quickLaunchItems, "default") }
          : item,
      ),
      "default",
    );
    const nextGroups = quickLaunchGroups.filter((group) => group.id !== groupId);
    persistQuickLaunchData(nextGroups, nextItems);
    if (activeGroupId === groupId) {
      setActiveGroupId("default");
    }
  };

  const openAddDraft = () => {
    setDraft({
      name: "",
      path: "",
      alias: "",
      itemType: "app",
      args: "",
      groupId: activeGroupId,
    });
    isDialogOpenRef.current = true;
  };

  const openEditDraft = (item: QuickLaunchItem, event: MouseEvent) => {
    event.stopPropagation();
    setDraft({
      id: item.id,
      name: item.name,
      path: item.path,
      alias: item.alias || "",
      itemType: item.itemType || "app",
      args: item.args || "",
      groupId: item.groupId || "default",
    });
    isDialogOpenRef.current = true;
  };

  const closeDraft = () => {
    setDraft(null);
    isDialogOpenRef.current = false;
  };

  const pickDraftTarget = async () => {
    if (!draft) return;
    try {
      const commonOptions = { multiple: false, title: "选择快捷访问目标" };
      let selected: string | string[] | null = null;
      if (draft.itemType === "folder") {
        selected = await open({ ...commonOptions, directory: true });
      } else if (draft.itemType === "app" || draft.itemType === "script") {
        selected = await open({
          ...commonOptions,
          filters: [{ name: "文件", extensions: ["exe", "lnk", "bat", "cmd", "msc", "ps1", "*"] }],
        });
      }
      if (!selected || Array.isArray(selected)) return;
      const baseName = selected.split("\\").pop()?.replace(/\.\w+$/, "") || selected;
      setDraft((current) =>
        current
          ? {
              ...current,
              path: selected,
              name: current.name || baseName,
            }
          : current,
      );
    } catch (error) {
      console.error(error);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    const targetPath = draft.path.trim();
    if (!targetPath || !draft.name.trim()) return;

    const existingItem = draft.id
      ? quickLaunchItems.find((item) => item.id === draft.id)
      : undefined;
    const item: QuickLaunchItem = {
      id: draft.id || `${Date.now()}${Math.random().toString(36).slice(2)}`,
      name: draft.name.trim(),
      path: targetPath,
      alias: draft.alias.trim(),
      itemType: draft.itemType,
      args: draft.args.trim(),
      groupId: draft.groupId,
      icon: existingItem?.icon,
      sortOrder:
        existingItem?.sortOrder ??
        getNextSortOrder(quickLaunchItemsRef.current, draft.groupId || "default"),
      launchCount: existingItem?.launchCount || 0,
      lastLaunchedAt: existingItem?.lastLaunchedAt || 0,
    };

    const nextItems = existingItem
      ? quickLaunchItemsRef.current.map((current) => (current.id === item.id ? item : current))
      : [...quickLaunchItemsRef.current, item];
    persistQuickLaunchData(
      quickLaunchGroupsRef.current,
      reindexGroup(nextItems, item.groupId || "default"),
    );

    closeDraft();
    await emitNotification(
      "success",
      existingItem ? "已更新快捷访问" : "已添加快捷访问",
      item.name,
    );
    if (!existingItem) {
      void requestIcon(item);
    }
  };

  const removeQuickLaunchItem = async (id: string, event: MouseEvent) => {
    event.stopPropagation();
    const removed = quickLaunchItems.find((item) => item.id === id);
    const nextItems = quickLaunchItems.filter((item) => item.id !== id);
    persistQuickLaunchData(
      quickLaunchGroups,
      reindexGroup(nextItems, removed?.groupId || "default"),
    );
    await emitNotification("info", "已移除快捷访问", removed?.name || "已删除项目");
  };

  const launchProgram = async (item: QuickLaunchItem) => {
    const nextItems = quickLaunchItems.map((entry) =>
      entry.id === item.id
        ? {
            ...entry,
            launchCount: (entry.launchCount || 0) + 1,
            lastLaunchedAt: Date.now(),
          }
        : entry,
    );
    persistQuickLaunchData(quickLaunchGroups, nextItems, { silent: true });
    try {
      await invoke("launch_program", {
        request: {
          target: item.path,
          itemType: item.itemType || "app",
          args: item.args || "",
        },
      });
    } catch (error) {
      console.error(error);
      await emitNotification("error", "启动失败", `${item.name}: ${String(error)}`);
    }
  };

  const activeGroupItems = useMemo(
    () =>
      [...quickLaunchItems]
        .filter((item) => (item.groupId || "default") === activeGroupId)
        .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0)),
    [activeGroupId, quickLaunchItems],
  );

  const visibleItems = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    const baseItems =
      activeMode === "recent"
        ? [...quickLaunchItems]
            .filter((item) => (item.launchCount || 0) > 0)
            .sort((left, right) => (right.lastLaunchedAt || 0) - (left.lastLaunchedAt || 0))
        : activeMode === "frequent"
          ? [...quickLaunchItems].sort((left, right) => {
              const launchDelta = (right.launchCount || 0) - (left.launchCount || 0);
              if (launchDelta !== 0) return launchDelta;
              return (right.lastLaunchedAt || 0) - (left.lastLaunchedAt || 0);
            })
          : activeGroupItems;

    return baseItems.filter((item) => {
      if (!keyword) return true;
      return `${item.name} ${item.alias || ""} ${item.path} ${item.args || ""}`
        .toLowerCase()
        .includes(keyword);
    });
  }, [activeGroupItems, activeMode, quickLaunchItems, searchKeyword]);

  // const recentItems = useMemo(
  //   () =>
  //     [...quickLaunchItems]
  //       .filter((item) => (item.launchCount || 0) > 0)
  //       .sort((left, right) => (right.lastLaunchedAt || 0) - (left.lastLaunchedAt || 0))
  //       .slice(0, 5),
  //   [quickLaunchItems],
  // );

  const handleItemDragStart = (itemId: string) => {
    setDraggingItemId(itemId);
  };

  const handleItemDrop = (targetItemId: string) => {
    if (!draggingItemId || draggingItemId === targetItemId) {
      setDraggingItemId(null);
      return;
    }
    const draggedItem = quickLaunchItemsRef.current.find((item) => item.id === draggingItemId);
    const targetItem = quickLaunchItemsRef.current.find((item) => item.id === targetItemId);
    if (!draggedItem || !targetItem || draggedItem.groupId !== targetItem.groupId) {
      setDraggingItemId(null);
      return;
    }

    const groupId = draggedItem.groupId || "default";
    const reordered = quickLaunchItemsRef.current
      .filter((item) => (item.groupId || "default") === groupId)
      .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0));
    const fromIndex = reordered.findIndex((item) => item.id === draggingItemId);
    const toIndex = reordered.findIndex((item) => item.id === targetItemId);
    if (fromIndex < 0 || toIndex < 0) {
      setDraggingItemId(null);
      return;
    }
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const otherItems = quickLaunchItemsRef.current.filter((item) => (item.groupId || "default") !== groupId);
    persistQuickLaunchData(
      quickLaunchGroupsRef.current,
      [...otherItems, ...reordered.map((item, index) => ({ ...item, sortOrder: index }))],
      { silent: true },
    );
    setDraggingItemId(null);
  };

  const handleGroupDrop = (groupId: string) => {
    if (!draggingItemId) return;
    const draggedItem = quickLaunchItemsRef.current.find((item) => item.id === draggingItemId);
    if (!draggedItem) return;
    const movedItems = quickLaunchItemsRef.current.map((item) =>
      item.id === draggingItemId
        ? {
            ...item,
            groupId,
            sortOrder: getNextSortOrder(quickLaunchItemsRef.current, groupId),
          }
        : item,
    );
    const nextItems = reindexGroup(
      reindexGroup(movedItems, draggedItem.groupId || "default"),
      groupId,
    );
    persistQuickLaunchData(quickLaunchGroupsRef.current, nextItems, { silent: true });
    setDraggingItemId(null);
  };

  const activeGroupName =
    quickLaunchGroups.find((group) => group.id === activeGroupId)?.name || "快捷访问";

  return (
    <div className="sub-view quicklaunch-split-view">
      <div className="sub-view-sidebar">
        <div className="sub-view-sidebar-header">
          <div className="back-btn" onClick={onBack}>
            <span className="back-icon">←</span> 返回
          </div>
          <h2 className="sub-view-title">分类分组</h2>
        </div>
        <div className="quicklaunch-nav">
          {quickLaunchGroups.map((group) => (
            <div
              key={group.id}
              className={`quicklaunch-nav-item ${activeGroupId === group.id ? "active" : ""}`}
              onClick={() => {
                setActiveMode("group");
                setActiveGroupId(group.id);
              }}
              onDoubleClick={() => {
                if (group.id !== "default") {
                  setEditingGroupId(group.id);
                  setEditingGroupName(group.name);
                }
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => handleGroupDrop(group.id)}
            >
              {editingGroupId === group.id ? (
                <input
                  autoFocus
                  className="quicklaunch-nav-input"
                  value={editingGroupName}
                  onChange={(event) => setEditingGroupName(event.target.value)}
                  onBlur={() => saveEditGroup(group.id)}
                  onKeyDown={(event) => event.key === "Enter" && saveEditGroup(group.id)}
                />
              ) : (
                <>
                  <span className="nav-text" title={group.name}>
                    {group.name}
                  </span>
                  {group.id !== "default" && (
                    <span
                      className="nav-delete"
                      title="删除分组"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteGroup(group.id);
                      }}
                    >
                      ×
                    </span>
                  )}
                </>
              )}
            </div>
          ))}
          {isAddingGroup ? (
            <input
              className="quicklaunch-nav-input add-input"
              autoFocus
              placeholder="命名(回车)"
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
              onBlur={saveNewGroup}
              onKeyDown={(event) => event.key === "Enter" && saveNewGroup()}
            />
          ) : (
            <div
              className="quicklaunch-nav-item add-btn"
              title="新建分组"
              onClick={() => setIsAddingGroup(true)}
            >
              + 新建
            </div>
          )}
        </div>
      </div>

      <div className="sub-view-main">
        <div className="sub-view-main-header quicklaunch-main-header">
          <div>
            <h2 className="sub-view-title active-group-title">{activeGroupName}</h2>
            <div className="quicklaunch-subtitle">支持应用、文件夹、网址、脚本与启动参数</div>
          </div>
          <button className="add-program-btn" onClick={openAddDraft}>
            + 添加目标
          </button>
        </div>
        <div className="sub-view-content quicklaunch-container">
          <div className="quicklaunch-toolbar">
            <input
              className="quicklaunch-search-input"
              placeholder="搜索名称、别名、路径或参数..."
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
            />
          </div>

          <div className="quicklaunch-mode-tabs">
            <button
              className={`quicklaunch-mode-tab ${activeMode === "group" ? "active" : ""}`}
              onClick={() => setActiveMode("group")}
            >
              当前分组
            </button>
            <button
              className={`quicklaunch-mode-tab ${activeMode === "recent" ? "active" : ""}`}
              onClick={() => setActiveMode("recent")}
            >
              最近使用
            </button>
            <button
              className={`quicklaunch-mode-tab ${activeMode === "frequent" ? "active" : ""}`}
              onClick={() => setActiveMode("frequent")}
            >
              最常用
            </button>
          </div>

          {visibleItems.length === 0 ? (
            <div className="quicklaunch-empty">当前视图没有匹配项目</div>
          ) : (
            <div className="quicklaunch-grid">
              {visibleItems.map((item) => (
                <div
                  key={item.id}
                  className={`quicklaunch-item ${draggingItemId === item.id ? "dragging" : ""}`}
                  onClick={() => launchProgram(item)}
                  title={item.path}
                  draggable={activeMode === "group" && !searchKeyword}
                  onDragStart={() => handleItemDragStart(item.id)}
                  onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
                  onDrop={() => handleItemDrop(item.id)}
                >
                  <button
                    className="quicklaunch-manage-btn"
                    onClick={(event) => openEditDraft(item, event)}
                    title="编辑"
                  >
                    ✎
                  </button>
                  <button
                    className="quicklaunch-delete-btn"
                    onClick={(event) => void removeQuickLaunchItem(item.id, event)}
                    title="移除"
                  >
                    ×
                  </button>
                  <div className="quicklaunch-icon">
                    {item.icon ? (
                      <img src={item.icon} alt={item.name} draggable={false} />
                    ) : (
                      <span className="quicklaunch-default-icon">
                        {getDefaultIcon(item.itemType || "app")}
                      </span>
                    )}
                  </div>
                  <span className="quicklaunch-name">{item.name}</span>
                  {item.alias && <span className="quicklaunch-alias">@{item.alias}</span>}
                  <span className="quicklaunch-meta">
                    {(item.itemType || "app").toUpperCase()} · {item.launchCount || 0} 次
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {draft && (
        <div className="quicklaunch-dialog-overlay" onClick={closeDraft}>
          <div className="quicklaunch-dialog" onClick={(event) => event.stopPropagation()}>
            <h3 className="settings-title">{draft.id ? "编辑快捷项" : "添加快捷项"}</h3>
            <div className="settings-row">
              <label className="settings-label">目标类型</label>
              <select
                className="settings-input"
                value={draft.itemType}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, itemType: event.target.value as QuickLaunchItemType, path: "" }
                      : current,
                  )
                }
              >
                <option value="app">应用</option>
                <option value="folder">文件夹</option>
                <option value="url">网址</option>
                <option value="script">脚本</option>
              </select>
            </div>
            <div className="settings-row">
              <label className="settings-label">显示名称</label>
              <input
                className="settings-input"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => (current ? { ...current, name: event.target.value } : current))
                }
              />
            </div>
            <div className="settings-row">
              <label className="settings-label">目标路径 / 地址</label>
              <div className="quicklaunch-target-row">
                <input
                  className="settings-input"
                  value={draft.path}
                  placeholder={draft.itemType === "url" ? "https://example.com" : "请选择目标"}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, path: event.target.value } : current))
                  }
                />
                {draft.itemType !== "url" && (
                  <button className="settings-cancel-btn quicklaunch-pick-btn" onClick={pickDraftTarget}>
                    选择
                  </button>
                )}
              </div>
            </div>
            <div className="settings-row">
              <label className="settings-label">搜索别名</label>
              <input
                className="settings-input"
                placeholder="例如: code、obs、docs"
                value={draft.alias}
                onChange={(event) =>
                  setDraft((current) => (current ? { ...current, alias: event.target.value } : current))
                }
              />
            </div>
            <div className="settings-row">
              <label className="settings-label">启动参数</label>
              <input
                className="settings-input"
                placeholder="可选"
                value={draft.args}
                onChange={(event) =>
                  setDraft((current) => (current ? { ...current, args: event.target.value } : current))
                }
              />
            </div>
            <div className="settings-row">
              <label className="settings-label">所属分组</label>
              <select
                className="settings-input"
                value={draft.groupId}
                onChange={(event) =>
                  setDraft((current) => (current ? { ...current, groupId: event.target.value } : current))
                }
              >
                {quickLaunchGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-actions">
              <button className="settings-cancel-btn" onClick={closeDraft}>
                取消
              </button>
              <button className="settings-save-btn" onClick={() => void saveDraft()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default QuickLaunchView;
