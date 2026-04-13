import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // 拖拽预览状态：拖拽中显示预览线，松手后才真正改变宽度
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);

  // 拖拽开始
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStartX.current = e.screenX;
    dragStartWidth.current = sidebarWidth;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  }, [sidebarWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      // 向左拖拽增大宽度（因为侧边栏在右侧）
      const delta = dragStartX.current - e.screenX;
      const newWidth = Math.max(280, Math.min(1200, dragStartWidth.current + delta));
      // 只更新预览宽度，不实际调整窗口
      setPreviewWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        // 松手时才真正调整窗口宽度
        setPreviewWidth((finalWidth) => {
          if (finalWidth !== null) {
            const w = Math.round(finalWidth);
            setSidebarWidth(w);
            invoke("resize_sidebar", { width: w });
          }
          return null;
        });
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // 当前时间
  const [currentTime, setCurrentTime] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
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

  // 快捷工具项
  const tools = [
    { icon: "📋", label: "剪贴板", desc: "历史记录" },
    { icon: "📝", label: "笔记", desc: "快速记录" },
    { icon: "🔍", label: "搜索", desc: "全局搜索" },
    { icon: "⚙️", label: "设置", desc: "系统设置" },
    { icon: "📁", label: "文件", desc: "快速访问" },
    { icon: "🖥️", label: "终端", desc: "命令行" },
  ];

  return (
    <div className="sidebar-container" ref={sidebarRef}>
      {/* 拖拽预览线：拖拽时显示目标宽度位置 */}
      {previewWidth !== null && (
        <div
          className="drag-preview-line"
          style={{ left: `${Math.max(0, sidebarWidth - previewWidth)}px` }}
        >
          <div className="drag-preview-label">
            {Math.round(previewWidth)}px
          </div>
        </div>
      )}

      {/* 左边缘拖拽手柄 */}
      <div
        className={`drag-handle ${previewWidth !== null ? 'dragging' : ''}`}
        onMouseDown={handleMouseDown}
      >
        <div className="drag-handle-indicator" />
      </div>

      {/* 侧边栏主体内容 */}
      <div className="sidebar-content">
        {/* 顶部时间区域 */}
        <header className="sidebar-header">
          <div className="time-display">{formatTime(currentTime)}</div>
          <div className="date-display">{formatDate(currentTime)}</div>
        </header>

        {/* 快捷工具网格 */}
        <section className="tools-section">
          <h2 className="section-title">
            <span className="section-icon">⚡</span>
            快捷工具
          </h2>
          <div className="tools-grid">
            {tools.map((tool, index) => (
              <div className="tool-card" key={index}>
                <div className="tool-icon">{tool.icon}</div>
                <div className="tool-info">
                  <span className="tool-label">{tool.label}</span>
                  <span className="tool-desc">{tool.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 系统快捷键提示 */}
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
            <div className="shortcut-item">
              <span className="shortcut-label">调整宽度</span>
              <span className="shortcut-hint">拖拽左边缘</span>
            </div>
          </div>
        </section>

        {/* 底部信息 */}
        <footer className="sidebar-footer">
          <div className="footer-text">ToolBox v0.1.0</div>
        </footer>
      </div>
    </div>
  );
}

export default App;
