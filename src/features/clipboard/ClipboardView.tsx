import { invoke } from "@tauri-apps/api/core";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, WheelEvent } from "react";
import SubViewHeader from "../../components/SubViewHeader";
import {
  type ClipboardGroup,
  type ClipboardItem,
  getClipboardSearchFields,
  normalizeClipboardItems,
} from "./clipboardModel";
import { notifyToolboxDataChanged, TOOLBOX_DATA_CHANGED } from "../../utils/dataSync";

type ClipboardViewProps = {
  onBack: () => void;
  isMonitoring: boolean;
  onMonitoringChange: (value: boolean | ((current: boolean) => boolean)) => void;
  onClipboardContentWritten: (content: string) => void;
};

type ClipboardFilter = "all" | "pinned" | "favorites" | "snippets" | "text" | "image";

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

function getSearchTerms(value: string) {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function stringifyTags(tags: string[]) {
  return tags.join(", ");
}

function normalizeTagInput(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function getTextStats(content: string) {
  return {
    chars: content.length,
    lines: content ? content.split(/\r?\n/).length : 0,
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getHighlightedSnippetHtml(content: string) {
  const escaped = escapeHtml(content);
  return escaped
    .replace(
      /(\/\/.*|#.*)/g,
      '<span class="clipboard-code-token comment">$1</span>',
    )
    .replace(
      /(&quot;[^&]*&quot;|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`)/g,
      '<span class="clipboard-code-token string">$1</span>',
    )
    .replace(
      /\b(const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|try|catch|switch|case|break|continue|new|public|private|protected|interface|type)\b/g,
      '<span class="clipboard-code-token keyword">$1</span>',
    )
    .replace(
      /\b(true|false|null|undefined|\d+(?:\.\d+)?)\b/g,
      '<span class="clipboard-code-token literal">$1</span>',
    );
}

function ClipboardView({
  onBack,
  isMonitoring,
  onMonitoringChange,
  onClipboardContentWritten,
}: ClipboardViewProps) {
  const [clipboardHistory, setClipboardHistory] = useState<ClipboardItem[]>([]);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [activeFilter, setActiveFilter] = useState<ClipboardFilter>("all");
  const [previewItem, setPreviewItem] = useState<ClipboardItem | null>(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [editingTagsId, setEditingTagsId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const isDraggingPreview = useRef(false);
  const dragStartPreview = useRef({ x: 0, y: 0 });

  const refreshClipboardHistory = async () => {
    try {
      const records = await invoke<ClipboardItem[]>("get_clipboard_history");
      const normalized = normalizeClipboardItems(records);
      setClipboardHistory(normalized);
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    void refreshClipboardHistory();
  }, []);

  useEffect(() => {
    const handleDataChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string }>).detail;
      if (!detail?.kind || detail.kind === "clipboard") {
        void refreshClipboardHistory();
      }
    };

    window.addEventListener(TOOLBOX_DATA_CHANGED, handleDataChanged);
    return () => window.removeEventListener(TOOLBOX_DATA_CHANGED, handleDataChanged);
  }, []);

  const visibleItems = useMemo(() => {
    const searchTerms = getSearchTerms(searchKeyword);

    return clipboardHistory
      .filter((item) => {
        if (activeFilter === "pinned" && !item.pinned) return false;
        if (activeFilter === "favorites" && !item.favorite) return false;
        if (activeFilter === "snippets" && item.group !== "snippet") return false;
        if (activeFilter === "text" && item.type !== "text") return false;
        if (activeFilter === "image" && item.type !== "image") return false;
        if (!searchTerms.length) return true;

        const haystack = getClipboardSearchFields(item).join("\n").toLowerCase();
        return searchTerms.every((term) => haystack.includes(term));
      })
      .sort((left, right) => {
        if (left.pinned && !right.pinned) return -1;
        if (!left.pinned && right.pinned) return 1;
        return right.timestamp - left.timestamp;
      });
  }, [activeFilter, clipboardHistory, searchKeyword]);

  const summary = useMemo(
    () => ({
      total: clipboardHistory.length,
      pinned: clipboardHistory.filter((item) => item.pinned).length,
      favorites: clipboardHistory.filter((item) => item.favorite).length,
      snippets: clipboardHistory.filter((item) => item.group === "snippet").length,
      tags: new Set(clipboardHistory.flatMap((item) => item.tags || [])).size,
    }),
    [clipboardHistory],
  );

  const previewTextStats = useMemo(
    () => (previewItem?.type === "text" ? getTextStats(previewItem.content) : null),
    [previewItem],
  );

  const persistItemUpdate = async (
    id: string,
    changes: {
      favorite?: boolean;
      pinned?: boolean;
      tags?: string[];
      group?: ClipboardGroup;
    },
  ) => {
    await invoke("update_clipboard_record", {
      id,
      favorite: changes.favorite,
      pinned: changes.pinned,
      tags: changes.tags,
      group: changes.group,
    });
    await refreshClipboardHistory();
    notifyToolboxDataChanged("clipboard");
  };

  const copyToClipboard = async (item: ClipboardItem) => {
    try {
      if (item.type === "text") {
        await writeClipboardText(item.content);
        onClipboardContentWritten(item.content);
        return;
      }

      await writeClipboardImage(item.content);
      onClipboardContentWritten(item.content);
    } catch {}
  };

  const openPreview = (item: ClipboardItem, event: MouseEvent) => {
    event.stopPropagation();
    setPreviewItem(item);
    setPreviewZoom(1);
    setPreviewPan({ x: 0, y: 0 });
  };

  const copyAsPlainText = async (item: ClipboardItem, event: MouseEvent) => {
    event.stopPropagation();
    if (item.type !== "text") return;

    try {
      await writeClipboardText(item.content);
      onClipboardContentWritten(item.content);
    } catch {}
  };

  const toggleFavorite = async (item: ClipboardItem, event: MouseEvent) => {
    event.stopPropagation();
    await persistItemUpdate(item.id, { favorite: !item.favorite });
  };

  const togglePinned = async (item: ClipboardItem, event: MouseEvent) => {
    event.stopPropagation();
    await persistItemUpdate(item.id, { pinned: !item.pinned });
  };

  const toggleGroup = async (item: ClipboardItem, event: MouseEvent) => {
    event.stopPropagation();
    await persistItemUpdate(item.id, {
      group: item.group === "snippet" ? "general" : "snippet",
    });
  };

  const openTagEditor = (item: ClipboardItem, event: MouseEvent) => {
    event.stopPropagation();
    setEditingTagsId(item.id);
    setTagDraft(stringifyTags(item.tags || []));
  };

  const saveTags = async (id: string) => {
    await persistItemUpdate(id, { tags: normalizeTagInput(tagDraft) });
    setEditingTagsId(null);
    setTagDraft("");
  };

  const cancelTagEdit = () => {
    setEditingTagsId(null);
    setTagDraft("");
  };

  const deleteClipboardItem = async (id: string, event: MouseEvent) => {
    event.stopPropagation();
    try {
      await invoke("delete_clipboard_record", { id });
      await refreshClipboardHistory();
      notifyToolboxDataChanged("clipboard");
    } catch (error) {
      console.error(error);
    }
  };

  const clearClipboardHistory = async () => {
    try {
      await invoke("clear_clipboard_records");
      await refreshClipboardHistory();
      notifyToolboxDataChanged("clipboard");
    } catch (error) {
      console.error(error);
    }
  };

  const closePreview = () => {
    setPreviewItem(null);
    setPreviewZoom(1);
    setPreviewPan({ x: 0, y: 0 });
  };

  const handlePreviewWheel = (event: WheelEvent) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    setPreviewZoom((zoom) => Math.max(0.25, Math.min(4, zoom + delta)));
  };

  const handlePreviewMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button === 0) {
      isDraggingPreview.current = true;
      dragStartPreview.current = {
        x: event.clientX - previewPan.x,
        y: event.clientY - previewPan.y,
      };
    }
  };

  const handlePreviewMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (isDraggingPreview.current && previewZoom > 1) {
      setPreviewPan({
        x: event.clientX - dragStartPreview.current.x,
        y: event.clientY - dragStartPreview.current.y,
      });
    }
  };

  const handlePreviewMouseUp = () => {
    isDraggingPreview.current = false;
  };

  const formatClipboardTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "刚刚";
    if (diffMins < 60) return `${diffMins}分钟前`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}小时前`;
    return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  };

  const filters: Array<{ id: ClipboardFilter; label: string }> = [
    { id: "all", label: "全部" },
    { id: "pinned", label: "置顶" },
    { id: "favorites", label: "收藏" },
    { id: "snippets", label: "代码片段" },
    { id: "text", label: "文本" },
    { id: "image", label: "图片" },
  ];

  const actions = (
    <div className="clipboard-header-actions">
      <button
        className={`clipboard-monitor-btn ${isMonitoring ? "active" : ""}`}
        onClick={() => onMonitoringChange((current) => !current)}
        title={isMonitoring ? "点击暂停监控" : "点击开始监控"}
      >
        {isMonitoring ? "⏸️ 监控中" : "▶️ 已暂停"}
      </button>
      {clipboardHistory.some((item) => !item.favorite && !item.pinned) && (
        <button className="clipboard-clear-btn" onClick={() => void clearClipboardHistory()} title="清空普通记录">
          🗑️ 清空普通记录
        </button>
      )}
    </div>
  );

  return (
    <div className="sub-view">
      <SubViewHeader title="剪切板增强" onBack={onBack} actions={actions} />
      <div className="sub-view-content clipboard-container">
        <div className="clipboard-toolbar">
          <input
            className="clipboard-search-input"
            placeholder="搜索内容、标签、分组或状态，例如 api 收藏 置顶"
            value={searchKeyword}
            onChange={(event) => setSearchKeyword(event.target.value)}
          />
          <div className="clipboard-filter-row">
            {filters.map((filter) => (
              <button
                key={filter.id}
                className={`clipboard-filter-btn ${activeFilter === filter.id ? "active" : ""}`}
                onClick={() => setActiveFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="clipboard-stats-row">
            <span className="clipboard-stat-chip">总数 {summary.total}</span>
            <span className="clipboard-stat-chip">置顶 {summary.pinned}</span>
            <span className="clipboard-stat-chip">收藏 {summary.favorites}</span>
            <span className="clipboard-stat-chip">代码片段 {summary.snippets}</span>
            <span className="clipboard-stat-chip">标签 {summary.tags}</span>
          </div>
        </div>

        {visibleItems.length === 0 ? (
          <div className="clipboard-empty">
            <div className="clipboard-empty-icon">📋</div>
            <div className="clipboard-empty-text">暂无匹配记录</div>
            <div className="clipboard-empty-hint">
              剪贴板历史现已迁移到 SQLite，复制的每一条文本或图片都会单独保存
            </div>
          </div>
        ) : (
          <div className="clipboard-list">
            {visibleItems.map((item) => (
              <div
                key={item.id}
                className={`clipboard-item ${item.pinned ? "pinned" : ""}`}
                onClick={() => void copyToClipboard(item)}
              >
                <div className="clipboard-item-content">
                  {item.type === "text" ? (
                    <div className={`clipboard-text-preview ${item.group === "snippet" ? "snippet" : ""}`}>
                      {item.content.slice(0, 280)}
                      {item.content.length > 280 && "..."}
                    </div>
                  ) : (
                    <div
                      className="clipboard-image-preview"
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setPreviewItem(item);
                      }}
                    >
                      <img src={item.content} alt="复制图片" />
                    </div>
                  )}
                </div>
                <div className="clipboard-item-footer">
                  <span className="clipboard-item-time">{formatClipboardTime(item.timestamp)}</span>
                  <span className="clipboard-item-type">
                    {item.type === "text" ? "文本" : "图片"}
                  </span>
                  {item.pinned && <span className="clipboard-item-badge pinned">置顶</span>}
                  {item.favorite && <span className="clipboard-item-badge favorite">收藏</span>}
                  {item.group === "snippet" && (
                    <span className="clipboard-item-badge snippet">代码片段</span>
                  )}
                  {(item.tags || []).map((tag) => (
                    <span key={`${item.id}-${tag}`} className="clipboard-tag-chip">
                      #{tag}
                    </span>
                  ))}
                  <div className="clipboard-item-actions">
                    {item.type === "text" && (
                      <button
                        className="clipboard-action-btn"
                        onClick={(event) => openPreview(item, event)}
                        title="预览完整内容"
                      >
                        预览
                      </button>
                    )}
                    {item.type === "text" && (
                      <button
                        className="clipboard-action-btn"
                        onClick={(event) => void copyAsPlainText(item, event)}
                        title="复制纯文本"
                      >
                        纯文本
                      </button>
                    )}
                    {item.type === "text" && (
                      <button
                        className={`clipboard-action-btn ${item.group === "snippet" ? "active" : ""}`}
                        onClick={(event) => void toggleGroup(item, event)}
                        title={item.group === "snippet" ? "移出代码片段" : "标记为代码片段"}
                      >
                        {item.group === "snippet" ? "普通" : "代码"}
                      </button>
                    )}
                    <button
                      className={`clipboard-action-btn ${item.pinned ? "active" : ""}`}
                      onClick={(event) => void togglePinned(item, event)}
                      title={item.pinned ? "取消置顶" : "置顶"}
                    >
                      📌
                    </button>
                    <button
                      className={`clipboard-action-btn ${item.favorite ? "active" : ""}`}
                      onClick={(event) => void toggleFavorite(item, event)}
                      title={item.favorite ? "取消收藏" : "收藏"}
                    >
                      ★
                    </button>
                    <button
                      className="clipboard-action-btn"
                      onClick={(event) => openTagEditor(item, event)}
                      title="编辑标签"
                    >
                      标签
                    </button>
                    <button
                      className="clipboard-delete-btn"
                      onClick={(event) => void deleteClipboardItem(item.id, event)}
                      title="删除"
                    >
                      ×
                    </button>
                  </div>
                </div>
                {editingTagsId === item.id && (
                  <div className="clipboard-tag-editor" onClick={(event) => event.stopPropagation()}>
                    <input
                      className="clipboard-tag-input"
                      value={tagDraft}
                      onChange={(event) => setTagDraft(event.target.value)}
                      placeholder="输入标签，逗号分隔"
                    />
                    <button className="clipboard-tag-save" onClick={() => void saveTags(item.id)}>
                      保存
                    </button>
                    <button className="clipboard-tag-cancel" onClick={cancelTagEdit}>
                      取消
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {previewItem && (
        <div className="clipboard-preview-overlay" onClick={closePreview}>
          <div className="clipboard-preview-panel" onClick={(event) => event.stopPropagation()}>
            <div className="clipboard-preview-header">
              {previewItem.type === "image" ? (
                <div className="clipboard-preview-zoom-controls">
                  <button
                    className="clipboard-zoom-btn"
                    onClick={() => setPreviewZoom((zoom) => Math.max(0.25, zoom - 0.25))}
                  >
                    −
                  </button>
                  <span className="clipboard-zoom-level">{Math.round(previewZoom * 100)}%</span>
                  <button
                    className="clipboard-zoom-btn"
                    onClick={() => setPreviewZoom((zoom) => Math.min(4, zoom + 0.25))}
                  >
                    +
                  </button>
                  <button className="clipboard-zoom-reset" onClick={() => setPreviewZoom(1)}>
                    重置
                  </button>
                </div>
              ) : (
                <div className="clipboard-preview-text-meta">
                  <div className="clipboard-preview-title">
                    {previewItem.group === "snippet" ? "代码片段预览" : "文本预览"}
                  </div>
                  {previewTextStats && (
                    <div className="clipboard-preview-text-stats">
                      <span>{previewTextStats.chars} 字符</span>
                      <span>{previewTextStats.lines} 行</span>
                    </div>
                  )}
                </div>
              )}
              <button className="clipboard-preview-close" onClick={closePreview}>
                ×
              </button>
            </div>
            {previewItem.type === "image" ? (
              <div
                className="clipboard-preview-content"
                onWheel={handlePreviewWheel}
                onMouseDown={handlePreviewMouseDown}
                onMouseMove={handlePreviewMouseMove}
                onMouseUp={handlePreviewMouseUp}
                onMouseLeave={handlePreviewMouseUp}
              >
                <img
                  src={previewItem.content}
                  alt="预览图片"
                  style={{
                    transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})`,
                    transition: isDraggingPreview.current ? "none" : "transform 0.2s ease",
                    cursor:
                      previewZoom > 1
                        ? isDraggingPreview.current
                          ? "grabbing"
                          : "grab"
                        : "default",
                  }}
                />
              </div>
            ) : (
              <div className={`clipboard-text-preview-panel ${previewItem.group === "snippet" ? "snippet" : ""}`}>
                {previewItem.group === "snippet" ? (
                  <pre
                    className="clipboard-text-preview-full snippet"
                    dangerouslySetInnerHTML={{
                      __html: getHighlightedSnippetHtml(previewItem.content),
                    }}
                  />
                ) : (
                  <pre className="clipboard-text-preview-full">{previewItem.content}</pre>
                )}
              </div>
            )}
            <div className="clipboard-preview-footer">
              {previewItem.type === "text" && previewTextStats && (
                <div className="clipboard-preview-summary">
                  <Fragment>
                    <span>完整内容预览</span>
                    <span>字符 {previewTextStats.chars}</span>
                    <span>行数 {previewTextStats.lines}</span>
                  </Fragment>
                </div>
              )}
              <button className="clipboard-preview-copy" onClick={() => void copyToClipboard(previewItem)}>
                {previewItem.type === "image" ? "复制图片" : "复制完整内容"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ClipboardView;
