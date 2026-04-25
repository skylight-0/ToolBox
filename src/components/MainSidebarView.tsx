import type { KeyboardEvent, RefObject } from "react";
import type { ToggleSwitchItem, ToolItem } from "../types/sidebar";

export type CommandPaletteResult = {
  id: string;
  icon: string;
  title: string;
  subtitle: string;
  meta?: string;
  group: string;
  hint?: string;
  secondaryHint?: string;
  category?: string;
};

export type SidebarNotification = {
  id: string;
  level: string;
  title: string;
  message: string;
  source: string;
  createdAt: number;
  read: boolean;
};

type MainSidebarViewProps = {
  currentTime: Date;
  tools: ToolItem[];
  switches: ToggleSwitchItem[];
  commandQuery: string;
  isCommandPaletteOpen: boolean;
  selectedCommandId: string | null;
  commandResults: CommandPaletteResult[];
  commandFilter: string;
  commandFilters: Array<{ id: string; label: string }>;
  notifications: SidebarNotification[];
  unreadNotificationCount: number;
  isNotificationCenterOpen: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onCommandPaletteOpen: () => void;
  onCommandInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onCommandQueryChange: (value: string) => void;
  onCommandFilterChange: (filterId: string) => void;
  onCommandResultHover: (resultId: string) => void;
  onCommandResultClick: (result: CommandPaletteResult) => void;
  onCommandResultSecondaryClick: (result: CommandPaletteResult) => void;
  onNotificationToggle: () => void;
  onNotificationRead: (id: string, read: boolean) => void;
  onNotificationClear: () => void;
  onToolClick: (toolId: ToolItem["id"]) => void;
  onSwitchClick: (switchId: ToggleSwitchItem["id"]) => void;
};

function renderHighlightedText(value: string, query: string) {
  const keyword = query.trim();
  if (!keyword) return value;

  const lowerValue = value.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const start = lowerValue.indexOf(lowerKeyword);

  if (start === -1) return value;

  const end = start + keyword.length;
  return (
    <>
      {value.slice(0, start)}
      <mark className="command-highlight">{value.slice(start, end)}</mark>
      {value.slice(end)}
    </>
  );
}

function formatTime(date: Date) {
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDate(date: Date) {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]}`;
}

function MainSidebarView({
  currentTime,
  tools,
  switches,
  commandQuery,
  isCommandPaletteOpen,
  selectedCommandId,
  commandResults,
  commandFilter,
  commandFilters,
  notifications,
  unreadNotificationCount,
  isNotificationCenterOpen,
  searchInputRef,
  onCommandPaletteOpen,
  onCommandInputKeyDown,
  onCommandQueryChange,
  onCommandFilterChange,
  onCommandResultHover,
  onCommandResultClick,
  onCommandResultSecondaryClick,
  onNotificationToggle,
  onNotificationRead,
  onNotificationClear,
  onToolClick,
  onSwitchClick,
}: MainSidebarViewProps) {
  let lastGroup = "";

  return (
    <div className="main-view">
      <div className="functional-area">
        <header className="sidebar-header">
          <div className="brand-block">
            <div className="brand-icon" aria-hidden="true">✦</div>
            <div className="brand-copy">
              <div className="brand-title">工具中心</div>
              <div className="brand-subtitle">
                {formatDate(currentTime)} · {formatTime(currentTime)}
              </div>
            </div>
          </div>
          <div className="sidebar-actions">
            <button
              className="notification-entry-btn"
              onClick={onNotificationToggle}
              title="通知中心"
              aria-label="通知中心"
            >
              <span>🔔</span>
              {unreadNotificationCount > 0 && (
                <span className="notification-entry-badge">{unreadNotificationCount}</span>
              )}
            </button>
          </div>
        </header>

        {isNotificationCenterOpen && (
          <section className="notification-center-card">
            <div className="notification-center-header">
              <div className="section-title">
                <span className="section-icon">🔔</span>
                通知中心
              </div>
              <button className="command-result-secondary" onClick={onNotificationClear}>
                清空历史
              </button>
            </div>
            <div className="notification-center-list">
              {notifications.length > 0 ? (
                notifications.map((notification) => (
                  <div
                    key={notification.id}
                    className={`notification-center-item ${notification.read ? "read" : "unread"} ${notification.level}`}
                    onClick={() => onNotificationRead(notification.id, true)}
                  >
                    <div className="notification-center-top">
                      <span className="notification-center-title">{notification.title}</span>
                      <span className="notification-center-source">{notification.source}</span>
                    </div>
                    <div className="notification-center-message">{notification.message}</div>
                  </div>
                ))
              ) : (
                <div className="command-results-empty">暂无通知</div>
              )}
            </div>
          </section>
        )}

        <section className="command-palette-section">
          <div className="section-title">
            <span className="section-icon">⌘</span>
            命令面板
          </div>
          <div className="command-palette-compact-shell" onClick={onCommandPaletteOpen}>
            <div className="command-palette-compact-placeholder">输入命令、程序、别名或文本内容...</div>
            <kbd className="command-palette-key">Ctrl + K</kbd>
          </div>
          {isCommandPaletteOpen && (
            <div className="command-palette-overlay" onMouseDown={(event) => event.preventDefault()}>
              <div className="command-palette-backdrop" />
              <div className="command-palette-modal">
                <div className="command-palette-shell">
                  <span className="command-palette-search-icon">⌕</span>
                  <input
                    ref={searchInputRef}
                    className="command-palette-input"
                    value={commandQuery}
                    onFocus={onCommandPaletteOpen}
                    onKeyDown={onCommandInputKeyDown}
                    onChange={(event) => onCommandQueryChange(event.target.value)}
                    placeholder="输入命令、程序、别名或文本内容..."
                  />
                  {commandQuery && (
                    <button
                      className="command-palette-clear"
                      onClick={() => onCommandQueryChange("")}
                      title="清空搜索"
                    >
                      ×
                    </button>
                  )}
                  <kbd className="command-palette-key">Esc</kbd>
                </div>
                <div className="command-results">
                  <div className="command-filter-row">
                    {commandFilters.map((filter) => (
                      <button
                        key={filter.id}
                        className={`command-filter-chip ${commandFilter === filter.id ? "active" : ""}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => onCommandFilterChange(filter.id)}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                  {commandResults.length > 0 ? (
                    <>
                      {commandResults.map((result) => {
                        const shouldRenderGroup = lastGroup !== result.group;
                        lastGroup = result.group;

                        return (
                          <div key={result.id}>
                            {shouldRenderGroup && (
                              <div className="command-results-group">{result.group}</div>
                            )}
                            <div
                              className={`command-result-item ${selectedCommandId === result.id ? "selected" : ""}`}
                              onMouseEnter={() => onCommandResultHover(result.id)}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => onCommandResultClick(result)}
                            >
                              <div className="command-result-icon">{result.icon}</div>
                              <div className="command-result-body">
                                <div className="command-result-title">
                                  {renderHighlightedText(result.title, commandQuery)}
                                </div>
                                <div className="command-result-subtitle">
                                  {renderHighlightedText(result.subtitle, commandQuery)}
                                </div>
                              </div>
                              <div className="command-result-side">
                                {result.meta && <div className="command-result-meta">{result.meta}</div>}
                                {result.hint && <div className="command-result-hint">{result.hint}</div>}
                                {result.secondaryHint && (
                                  <button
                                    className="command-result-secondary"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onCommandResultSecondaryClick(result);
                                    }}
                                  >
                                    {result.secondaryHint}
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <div className="command-results-footer">
                        <span>↑ ↓ 选择</span>
                        <span>Enter 执行</span>
                        <span>Tab / Ctrl+Enter 副动作</span>
                        <span>Esc 关闭</span>
                      </div>
                    </>
                  ) : (
                    <div className="command-results-empty">
                      {commandQuery ? "没有找到匹配结果" : "输入关键词，或直接从建议项里执行"}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="tools-section">
          <h2 className="section-title">
            <span className="section-icon">⚡</span>
            功能区
          </h2>
          <div className="tools-grid">
            {tools.map((tool) => (
              <div className="tool-card" key={tool.id} onClick={() => onToolClick(tool.id)}>
                <div className="tool-icon">{tool.icon}</div>
                <div className="tool-info">
                  <span className="tool-label">{tool.label}</span>
                  <span className="tool-desc">{tool.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="switches-area">
        <h2 className="section-title">
          <span className="section-icon">🎛️</span>
          开关区
        </h2>
        <div className="switch-grid">
          {switches.map((item) => (
            <div
              className={`switch-card ${item.active ? "active" : ""} ${item.pending ? "pending" : ""}`}
              key={item.id}
              onClick={() => !item.pending && onSwitchClick(item.id)}
            >
              <div className="content-left">
                <div className="switch-icon">{item.icon}</div>
                <div className="switch-info">
                  <div className="switch-label">{item.label}</div>
                  {item.desc && <div className="switch-desc">{item.desc}</div>}
                </div>
              </div>
              <div className="switch-toggle-track">
                <div className="switch-toggle-thumb" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default MainSidebarView;
