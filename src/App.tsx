import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

function App() {
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // 动画状态
  const [isClosing, setIsClosing] = useState(false);
  const [isOpening, setIsOpening] = useState(false);

  // 监听后端发来的显隐事件以及窗口失焦（也就是点击了桌面或其他地方）
  useEffect(() => {
    let isCurrentlyClosing = false;
    let hideTimeoutId: number | null = null;

    const triggerHide = () => {
      if (isCurrentlyClosing) return;
      isCurrentlyClosing = true;
      setIsClosing(true);

      // 离场动画播放完后，通知后端真正隐藏窗口
      if (hideTimeoutId !== null) window.clearTimeout(hideTimeoutId);
      hideTimeoutId = window.setTimeout(() => {
        setIsClosing(false);
        isCurrentlyClosing = false;
        hideTimeoutId = null;
        invoke("do_hide_sidebar");
      }, 250);
    };

    const unlistenShow = listen("show-sidebar", () => {
      // 停止上一轮还没走完的离场销毁逻辑（防止打开时立刻被藏起来）
      if (hideTimeoutId !== null) {
        window.clearTimeout(hideTimeoutId);
        hideTimeoutId = null;
      }
      setIsClosing(false);
      isCurrentlyClosing = false;

      setIsOpening(true);
      // 等待进场动画结束后移除状态
      setTimeout(() => setIsOpening(false), 300);
    });

    const unlistenHide = listen("hide-sidebar", () => {
      triggerHide();
    });

    // 窗口失去系统焦点时自动隐藏（即“点击了侧边栏外”）
    const unlistenBlur = listen("tauri://blur", () => {
      triggerHide();
    });

    return () => {
      unlistenShow.then(f => f());
      unlistenHide.then(f => f());
      unlistenBlur.then(f => f());
      if (hideTimeoutId !== null) window.clearTimeout(hideTimeoutId);
    };
  }, []);

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

  // 当前视图状态：'main' | 'json'
  const [activeView, setActiveView] = useState("main");

  // 快捷工具项
  const tools = [
    { id: "json", icon: "✨", label: "JSON 格式化", desc: "粘贴文本格式化" },
    { id: "notepad", icon: "📝", label: "记事本", desc: "快速新建文本" },
    { id: "calc", icon: "🧮", label: "计算器", desc: "打开计算器" },
    { id: "terminal", icon: "🖥️", label: "终端", desc: "命令行面板" },
    { id: "files", icon: "📁", label: "文件", desc: "快速访问资源" },
    { id: "settings", icon: "⚙️", label: "系统设置", desc: "Windows 设置" },
  ];

  // 开关项状态：true 表示显示/亮起，false 表示隐藏/暗下
  const [switchStates, setSwitchStates] = useState<Record<string, boolean>>({
    desktop: true, // 初始默认显示
    taskbar: true,
  });

  const switches = [
    { id: "desktop", icon: "👁️", label: "桌面图标", active: switchStates.desktop },
    { id: "taskbar", icon: "🚀", label: "任务栏", active: switchStates.taskbar },
  ];

  const handleToolClick = (toolId: string) => {
    if (toolId === "json") {
      setActiveView("json");
    } else {
      let action = "";
      if (toolId === "settings") action = "settings";
      if (toolId === "notepad") action = "notepad";
      if (toolId === "calc") action = "calc";
      if (toolId === "terminal") action = "terminal";

      if (action) {
        invoke("system_action", { action }).catch(console.error);
      }
    }
  };

  const handleSwitchClick = (switchId: string) => {
    // 获取未来的状态并应用到 UI
    const willBeActive = !switchStates[switchId];
    setSwitchStates(prev => ({ ...prev, [switchId]: willBeActive }));

    // 执行对应的系统调用，传入最新的绝对状态
    if (switchId === "desktop") {
      invoke("toggle_desktop", { show: willBeActive }).catch(console.error);
    } else if (switchId === "taskbar") {
      invoke("toggle_taskbar", { show: willBeActive }).catch(console.error);
    }
  };

  // JSON 格式化器状态
  const [jsonInput, setJsonInput] = useState("");
  const [jsonOutput, setJsonOutput] = useState("");
  const [jsonError, setJsonError] = useState("");

  const formatJson = () => {
    if (!jsonInput.trim()) {
      setJsonOutput("");
      setJsonError("");
      return;
    }
    try {
      const parsed = JSON.parse(jsonInput);
      setJsonOutput(JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch (e: any) {
      setJsonError("无效的 JSON 文本: " + e.message);
      setJsonOutput("");
    }
  };

  const renderJsonView = () => (
    <div className="sub-view">
      <div className="sub-view-header">
        <div className="back-btn" onClick={() => setActiveView("main")}>
          <span className="back-icon">←</span> 返回
        </div>
        <h2 className="sub-view-title">JSON 格式化</h2>
      </div>
      <div className="sub-view-content json-formatter">
        <textarea 
          className="json-input" 
          placeholder="在此粘贴 JSON 文本..." 
          value={jsonInput}
          onChange={(e) => setJsonInput(e.target.value)}
        />
        <button className="format-btn" onClick={formatJson}>格式化</button>
        {jsonError && <div className="json-error">{jsonError}</div>}
        <textarea 
          className="json-output" 
          placeholder="格式化结果..." 
          readOnly 
          value={jsonOutput}
        />
      </div>
    </div>
  );

  return (
    <div className={`sidebar-container ${isOpening ? 'slide-in' : ''} ${isClosing ? 'slide-out' : ''}`} ref={sidebarRef}>
      {/* 拖拽预览线 */}
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
        {activeView === "main" ? (
          <div className="main-view">
            {/* 上侧：功能区 (约 80%) */}
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
                  {tools.map((tool, index) => (
                    <div
                      className="tool-card"
                      key={index}
                      onClick={() => handleToolClick(tool.id)}
                    >
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

            {/* 下侧：开关区 (约 20%) */}
            <div className="switches-area">
              <h2 className="section-title">
                <span className="section-icon">🎛️</span>
                开关区
              </h2>
              <div className="switch-grid">
                {switches.map((sw, index) => (
                  <div
                    className={`switch-card ${sw.active ? 'active' : ''}`}
                    key={index}
                    onClick={() => handleSwitchClick(sw.id)}
                  >
                    <div className="switch-icon">{sw.icon}</div>
                    <div className="switch-label">{sw.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : activeView === "json" ? (
          renderJsonView()
        ) : null}
      </div>
    </div>
  );
}

export default App;
