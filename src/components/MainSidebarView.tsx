import type { ToggleSwitchItem, ToolItem } from "../types/sidebar";

type MainSidebarViewProps = {
  currentTime: Date;
  tools: ToolItem[];
  switches: ToggleSwitchItem[];
  onToolClick: (toolId: ToolItem["id"]) => void;
  onSwitchClick: (switchId: ToggleSwitchItem["id"]) => void;
};

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
  onToolClick,
  onSwitchClick,
}: MainSidebarViewProps) {
  return (
    <div className="main-view">
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

      <div className="switches-area">
        <h2 className="section-title">
          <span className="section-icon">🎛️</span>
          开关区
        </h2>
        <div className="switch-grid">
          {switches.map((item) => (
            <div
              className={`switch-card ${item.active ? "active" : ""}`}
              key={item.id}
              onClick={() => onSwitchClick(item.id)}
            >
              <div className="content-left">
                <div className="switch-icon">{item.icon}</div>
                <div className="switch-label">{item.label}</div>
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
