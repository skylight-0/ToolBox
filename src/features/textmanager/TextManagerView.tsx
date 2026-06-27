import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { notifyToolboxDataChanged } from "../../utils/dataSync";

type TextGroup = {
  id: string;
  name: string;
};

type TextEntry = {
  id: string;
  title: string;
  content: string;
  groupId: string;
  updatedAt: number;
};

const DEFAULT_GROUP: TextGroup = {
  id: "default",
  name: "默认分组",
};

function createEntry(groupId: string): TextEntry {
  return {
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    title: "",
    content: "",
    groupId,
    updatedAt: Date.now(),
  };
}

function formatUpdatedAt(timestamp: number) {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TextManagerView() {
  const [groups, setGroups] = useState<TextGroup[]>([DEFAULT_GROUP]);
  const [entries, setEntries] = useState<TextEntry[]>([]);
  const [activeGroupId, setActiveGroupId] = useState("default");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [isAddingGroup, setIsAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  useEffect(() => {
    invoke<{ groups: TextGroup[]; entries: TextEntry[] }>("get_text_manager_data")
      .then((data) => {
        setGroups(data.groups.length ? data.groups : [DEFAULT_GROUP]);
        setEntries(data.entries);
      })
      .catch(console.error);
  }, []);

  const persistTextManagerData = (nextGroups: TextGroup[], nextEntries: TextEntry[]) => {
    setGroups(nextGroups);
    setEntries(nextEntries);
    void invoke("save_text_manager_data", {
      data: { groups: nextGroups, entries: nextEntries },
    })
      .then(() => notifyToolboxDataChanged("textmanager"))
      .catch(console.error);
  };

  const filteredEntries = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    return entries
      .filter((entry) => entry.groupId === activeGroupId)
      .filter((entry) => {
        if (!keyword) return true;
        return (
          entry.title.toLowerCase().includes(keyword) ||
          entry.content.toLowerCase().includes(keyword)
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [activeGroupId, entries, searchKeyword]);

  const selectedEntry =
    filteredEntries.find((entry) => entry.id === selectedEntryId) ?? filteredEntries[0] ?? null;

  useEffect(() => {
    if (!filteredEntries.some((entry) => entry.id === selectedEntryId)) {
      setSelectedEntryId(filteredEntries[0]?.id ?? null);
    }
  }, [filteredEntries, selectedEntryId]);

  const saveEditGroup = (id: string) => {
    if (editingGroupName.trim()) {
      persistTextManagerData(
        groups.map((group) =>
          group.id === id ? { ...group, name: editingGroupName.trim() } : group,
        ),
        entries,
      );
    }
    setEditingGroupId(null);
    setEditingGroupName("");
  };

  const saveNewGroup = () => {
    if (newGroupName.trim()) {
      const id = Date.now().toString();
      persistTextManagerData([...groups, { id, name: newGroupName.trim() }], entries);
      setActiveGroupId(id);
    }
    setIsAddingGroup(false);
    setNewGroupName("");
  };

  const deleteGroup = (groupId: string) => {
    const nextEntries = entries.map((entry) =>
      entry.groupId === groupId ? { ...entry, groupId: "default", updatedAt: Date.now() } : entry,
    );
    const nextGroups = groups.filter((group) => group.id !== groupId);
    persistTextManagerData(nextGroups, nextEntries);
    if (activeGroupId === groupId) {
      setActiveGroupId("default");
    }
  };

  const addEntry = () => {
    const entry = createEntry(activeGroupId);
    persistTextManagerData(groups, [entry, ...entries]);
    setSelectedEntryId(entry.id);
    setSearchKeyword("");
  };

  const updateEntry = (
    entryId: string,
    patch: Partial<Pick<TextEntry, "title" | "content">>,
  ) => {
    persistTextManagerData(
      groups,
      entries.map((entry) =>
        entry.id === entryId ? { ...entry, ...patch, updatedAt: Date.now() } : entry,
      ),
    );
  };

  const deleteEntry = (entryId: string) => {
    persistTextManagerData(groups, entries.filter((entry) => entry.id !== entryId));
  };

  const copyEntry = async (entry: TextEntry) => {
    try {
      await navigator.clipboard.writeText(entry.content);
    } catch {}
  };

  const activeGroupName =
    groups.find((group) => group.id === activeGroupId)?.name ?? DEFAULT_GROUP.name;
  const activeEntryCount = filteredEntries.length;

  return (
    <div className="tm-app">
      <header className="tm-topbar">
        <div className="tm-brand">
          <div className="tm-brand-mark">🗂️</div>
          <div className="tm-brand-text">
            <h1 className="tm-brand-title">文本管理</h1>
            <p className="tm-brand-sub">保存常用文本、命令与模板，按分组快速检索</p>
          </div>
        </div>
        <div className="tm-topbar-tools">
          <label className="tm-search">
            <span className="tm-search-icon">🔍</span>
            <input
              type="text"
              placeholder="搜索标题或内容..."
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
            />
          </label>
          <button className="tm-new-btn" onClick={addEntry}>
            + 新建文本
          </button>
        </div>
      </header>

      <div className="tm-groups">
        <div className="tm-groups-scroll">
          {groups.map((group) => (
            <div
              key={group.id}
              className={`tm-chip ${activeGroupId === group.id ? "active" : ""}`}
              onClick={() => setActiveGroupId(group.id)}
              onDoubleClick={() => {
                if (group.id !== "default") {
                  setEditingGroupId(group.id);
                  setEditingGroupName(group.name);
                }
              }}
              title={group.name}
            >
              {editingGroupId === group.id ? (
                <input
                  autoFocus
                  className="tm-chip-input"
                  value={editingGroupName}
                  onChange={(event) => setEditingGroupName(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={() => saveEditGroup(group.id)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") saveEditGroup(group.id);
                  }}
                />
              ) : (
                <>
                  <span className="tm-chip-label">{group.name}</span>
                  {group.id !== "default" && (
                    <button
                      className="tm-chip-remove"
                      title="删除分组"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteGroup(group.id);
                      }}
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </div>
          ))}

          {isAddingGroup ? (
            <input
              className="tm-chip-input tm-chip-input-add"
              autoFocus
              placeholder="命名(回车)"
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
              onBlur={saveNewGroup}
              onKeyDown={(event) => event.key === "Enter" && saveNewGroup()}
            />
          ) : (
            <button
              className="tm-chip tm-chip-add"
              title="新建分组"
              onClick={() => setIsAddingGroup(true)}
            >
              + 新建分组
            </button>
          )}
        </div>
      </div>

      <div className="tm-body">
        <section className="tm-list-panel">
          <div className="tm-list-head">
            <span className="tm-list-title">{activeGroupName}</span>
            <span className="tm-list-count">{activeEntryCount} 条</span>
          </div>

          {filteredEntries.length === 0 ? (
            <div className="tm-empty">
              {searchKeyword ? "没有匹配的文本" : "这个分组还没有保存文本"}
            </div>
          ) : (
            <div className="tm-list">
              {filteredEntries.map((entry) => (
                <div
                  key={entry.id}
                  className={`tm-item ${selectedEntry?.id === entry.id ? "active" : ""}`}
                  onClick={() => setSelectedEntryId(entry.id)}
                >
                  <div className="tm-item-head">
                    <span className="tm-item-title">
                      {entry.title.trim() || "未命名文本"}
                    </span>
                    <button
                      className="tm-item-remove"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteEntry(entry.id);
                      }}
                      title="删除"
                    >
                      ×
                    </button>
                  </div>
                  <div className="tm-item-preview">
                    {entry.content.trim() || "暂无内容"}
                  </div>
                  <div className="tm-item-time">最近更新 {formatUpdatedAt(entry.updatedAt)}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="tm-editor-panel">
          {selectedEntry ? (
            <>
              <div className="tm-editor-toolbar">
                <button className="tm-copy-btn" onClick={() => copyEntry(selectedEntry)}>
                  复制内容
                </button>
              </div>
              <input
                className="tm-title-input"
                placeholder="输入标题，便于快速查找"
                value={selectedEntry.title}
                onChange={(event) =>
                  updateEntry(selectedEntry.id, { title: event.target.value })
                }
              />
              <textarea
                className="tm-textarea"
                placeholder="在这里保存你的常用文本、命令、提示词、模板内容..."
                value={selectedEntry.content}
                onChange={(event) =>
                  updateEntry(selectedEntry.id, { content: event.target.value })
                }
              />
            </>
          ) : (
            <div className="tm-editor-empty">
              <div className="tm-editor-empty-icon">📝</div>
              <div className="tm-editor-empty-text">
                先新建一条文本，或从左侧列表选择已有内容
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default TextManagerView;