import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
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
  groupId?: string;
};

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
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [isAddingGroup, setIsAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

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
  };

  const launchProgram = (path: string) => {
    invoke("launch_program", { path }).catch(console.error);
  };

  const currentItems = quickLaunchItems.filter(
    (item) => (item.groupId || "default") === activeGroupId,
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
        <div className="sub-view-main-header">
          <h2 className="sub-view-title active-group-title">{activeGroupName}</h2>
          <button className="add-program-btn" onClick={addQuickLaunchItem}>
            + 添加程序
          </button>
        </div>
        <div className="sub-view-content quicklaunch-container">
          {currentItems.length === 0 ? (
            <div className="quicklaunch-empty">此分组还没有添加程序</div>
          ) : (
            <div className="quicklaunch-grid">
              {currentItems.map((item) => (
                <div
                  key={item.id}
                  className="quicklaunch-item"
                  onClick={() => launchProgram(item.path)}
                  title={item.path}
                >
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
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default QuickLaunchView;
