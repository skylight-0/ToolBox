import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent, MutableRefObject } from "react";

type QuickLaunchViewProps = {
  onBack: () => void;
  isDialogOpenRef: MutableRefObject<boolean>;
};

type QuickLaunchGroup = {
  id: string;
  name: string;
};

type QuickLaunchItem = {
  id: string;
  name: string;
  path: string;
  icon?: string;
  alias?: string;
  groupId?: string;
  launchCount?: number;
  lastLaunchedAt?: number;
};

type EditDraft = {
  id: string;
  name: string;
  alias: string;
};

function normalizeQuickLaunchItems(items: QuickLaunchItem[]) {
  return items.map((item) => ({
    ...item,
    alias: item.alias || "",
    groupId: item.groupId || "default",
    launchCount: item.launchCount || 0,
    lastLaunchedAt: item.lastLaunchedAt || 0,
  }));
}

function formatRecentTime(timestamp?: number) {
  if (!timestamp) return "未启动过";
  const date = new Date(timestamp);
  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function QuickLaunchView({ onBack, isDialogOpenRef }: QuickLaunchViewProps) {
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
      return saved ? normalizeQuickLaunchItems(JSON.parse(saved)) : [];
    } catch {
      return [];
    }
  });
  const [searchKeyword, setSearchKeyword] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [isAddingGroup, setIsAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);

  useEffect(() => {
    localStorage.setItem("toolbox_quicklaunch_groups", JSON.stringify(quickLaunchGroups));
  }, [quickLaunchGroups]);

  useEffect(() => {
    localStorage.setItem("toolbox_quicklaunch", JSON.stringify(quickLaunchItems));
  }, [quickLaunchItems]);

  const saveEditGroup = (id: string) => {
    if (editingGroupName.trim()) {
      setQuickLaunchGroups((current) =>
        current.map((group) =>
          group.id === id ? { ...group, name: editingGroupName.trim() } : group,
        ),
      );
    }
    setEditingGroupId(null);
  };

  const saveNewGroup = () => {
    if (newGroupName.trim()) {
      const id = Date.now().toString();
      setQuickLaunchGroups((current) => [...current, { id, name: newGroupName.trim() }]);
      setActiveGroupId(id);
    }
    setIsAddingGroup(false);
    setNewGroupName("");
  };

  const deleteGroup = (groupId: string) => {
    setQuickLaunchItems((current) =>
      current.map((item) =>
        item.groupId === groupId ? { ...item, groupId: "default" } : item,
      ),
    );
    setQuickLaunchGroups((current) => current.filter((group) => group.id !== groupId));
    if (activeGroupId === groupId) {
      setActiveGroupId("default");
    }
  };

  const addQuickLaunchItem = async () => {
    isDialogOpenRef.current = true;

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        title: "选择要添加的程序",
        filters: [
          { name: "可执行程序", extensions: ["exe", "lnk", "bat", "cmd", "msc"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });

      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      for (const filePath of paths) {
        const fileName = filePath.split("\\").pop() || filePath;
        const id = Date.now().toString() + Math.random().toString(36).slice(2);
        const item: QuickLaunchItem = {
          id,
          name: fileName.replace(/\.\w+$/, ""),
          path: filePath,
          groupId: activeGroupId,
          alias: "",
          launchCount: 0,
          lastLaunchedAt: 0,
        };

        setQuickLaunchItems((current) => [...current, item]);

        invoke<string>("extract_program_icon", { path: filePath })
          .then((icon) => {
            setQuickLaunchItems((current) =>
              current.map((currentItem) =>
                currentItem.id === id ? { ...currentItem, icon } : currentItem,
              ),
            );
          })
          .catch(() => {});
      }
    } finally {
      isDialogOpenRef.current = false;
    }
  };

  const removeQuickLaunchItem = (id: string, event: MouseEvent) => {
    event.stopPropagation();
    setQuickLaunchItems((current) => current.filter((item) => item.id !== id));
    if (editDraft?.id === id) {
      setEditDraft(null);
    }
  };

  const openEditDialog = (item: QuickLaunchItem, event: MouseEvent) => {
    event.stopPropagation();
    isDialogOpenRef.current = true;
    setEditDraft({
      id: item.id,
      name: item.name,
      alias: item.alias || "",
    });
  };

  const closeEditDialog = () => {
    isDialogOpenRef.current = false;
    setEditDraft(null);
  };

  const saveItemDraft = () => {
    if (!editDraft) return;

    setQuickLaunchItems((current) =>
      current.map((item) =>
        item.id === editDraft.id
          ? {
              ...item,
              name: editDraft.name.trim() || item.name,
              alias: editDraft.alias.trim(),
            }
          : item,
      ),
    );
    closeEditDialog();
  };

  const launchProgram = async (item: QuickLaunchItem) => {
    setQuickLaunchItems((current) =>
      current.map((entry) =>
        entry.id === item.id
          ? {
              ...entry,
              launchCount: (entry.launchCount || 0) + 1,
              lastLaunchedAt: Date.now(),
            }
          : entry,
      ),
    );

    await invoke("launch_program", { path: item.path });
  };

  const currentItems = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    return quickLaunchItems
      .filter((item) => (item.groupId || "default") === activeGroupId)
      .filter((item) => {
        if (!keyword) return true;
        return `${item.name} ${item.alias || ""} ${item.path}`.toLowerCase().includes(keyword);
      })
      .sort((left, right) => {
        const rightScore = (right.lastLaunchedAt || 0) + (right.launchCount || 0) * 1000;
        const leftScore = (left.lastLaunchedAt || 0) + (left.launchCount || 0) * 1000;
        return rightScore - leftScore;
      });
  }, [activeGroupId, quickLaunchItems, searchKeyword]);

  const recentItems = useMemo(
    () =>
      [...quickLaunchItems]
        .filter((item) => (item.launchCount || 0) > 0)
        .sort((left, right) => (right.lastLaunchedAt || 0) - (left.lastLaunchedAt || 0))
        .slice(0, 5),
    [quickLaunchItems],
  );

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
              onClick={() => setActiveGroupId(group.id)}
              onDoubleClick={() => {
                if (group.id !== "default") {
                  setEditingGroupId(group.id);
                  setEditingGroupName(group.name);
                }
              }}
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
            <div className="quicklaunch-subtitle">支持搜索、别名和最近使用</div>
          </div>
          <button className="add-program-btn" onClick={addQuickLaunchItem}>
            + 添加程序
          </button>
        </div>
        <div className="sub-view-content quicklaunch-container">
          <div className="quicklaunch-toolbar">
            <input
              className="quicklaunch-search-input"
              placeholder="搜索名称、别名或路径..."
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
            />
          </div>

          {!searchKeyword && recentItems.length > 0 && (
            <div className="quicklaunch-recent-section">
              <div className="section-title">
                <span className="section-icon">🕘</span>
                最近使用
              </div>
              <div className="quicklaunch-recent-list">
                {recentItems.map((item) => (
                  <div
                    key={`recent-${item.id}`}
                    className="quicklaunch-recent-item"
                    onClick={() => launchProgram(item)}
                    title={item.path}
                  >
                    <div className="quicklaunch-recent-left">
                      <span className="quicklaunch-recent-icon">{item.icon ? "📌" : "📄"}</span>
                      <div className="quicklaunch-recent-info">
                        <div className="quicklaunch-recent-name">
                          {item.alias ? `${item.alias} · ${item.name}` : item.name}
                        </div>
                        <div className="quicklaunch-recent-meta">
                          最近启动：{formatRecentTime(item.lastLaunchedAt)}
                        </div>
                      </div>
                    </div>
                    <div className="quicklaunch-recent-count">{item.launchCount} 次</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {currentItems.length === 0 ? (
            <div className="quicklaunch-empty">当前分组没有匹配项目</div>
          ) : (
            <div className="quicklaunch-grid">
              {currentItems.map((item) => (
                <div
                  key={item.id}
                  className="quicklaunch-item"
                  onClick={() => launchProgram(item)}
                  title={item.path}
                >
                  <button
                    className="quicklaunch-manage-btn"
                    onClick={(event) => openEditDialog(item, event)}
                    title="编辑名称和别名"
                  >
                    ✎
                  </button>
                  <button
                    className="quicklaunch-delete-btn"
                    onClick={(event) => removeQuickLaunchItem(item.id, event)}
                    title="移除"
                  >
                    ×
                  </button>
                  <div className="quicklaunch-icon">
                    {item.icon ? (
                      <img src={item.icon} alt={item.name} draggable={false} />
                    ) : (
                      <span className="quicklaunch-default-icon">📄</span>
                    )}
                  </div>
                  <span className="quicklaunch-name">{item.name}</span>
                  {item.alias && <span className="quicklaunch-alias">@{item.alias}</span>}
                  <span className="quicklaunch-meta">{item.launchCount || 0} 次启动</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {editDraft && (
        <div className="quicklaunch-dialog-overlay" onClick={closeEditDialog}>
          <div className="quicklaunch-dialog" onClick={(event) => event.stopPropagation()}>
            <h3 className="settings-title">编辑快捷项</h3>
            <div className="settings-row">
              <label className="settings-label">显示名称</label>
              <input
                className="settings-input"
                value={editDraft.name}
                onChange={(event) =>
                  setEditDraft((current) =>
                    current ? { ...current, name: event.target.value } : current,
                  )
                }
              />
            </div>
            <div className="settings-row">
              <label className="settings-label">搜索别名</label>
              <input
                className="settings-input"
                placeholder="例如: ps、chat、obs"
                value={editDraft.alias}
                onChange={(event) =>
                  setEditDraft((current) =>
                    current ? { ...current, alias: event.target.value } : current,
                  )
                }
              />
            </div>
            <div className="settings-actions">
              <button className="settings-cancel-btn" onClick={closeEditDialog}>
                取消
              </button>
              <button className="settings-save-btn" onClick={saveItemDraft}>
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
