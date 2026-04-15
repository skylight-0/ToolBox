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

  // 文件对话框打开标记，防止对话框打开时侧边栏自动隐藏
  const isDialogOpenRef = useRef(false);

  // 监听后端发来的显隐事件以及窗口失焦（也就是点击了桌面或其他地方）
  useEffect(() => {
    let isCurrentlyClosing = false;
    let hideTimeoutId: number | null = null;

    const triggerHide = () => {
      if (isCurrentlyClosing || isDialogOpenRef.current) return;
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

  // 当前视图状态：'main' | 'json' | 'todo'
  const [activeView, setActiveView] = useState("main");

  // 快捷工具项
  const tools = [
    { id: "json", icon: "✨", label: "JSON 格式化", desc: "粘贴文本格式化" },
    { id: "todo", icon: "☑️", label: "待办事项", desc: "本地待办清单" },
    { id: "notepad", icon: "📝", label: "记事本", desc: "快速新建文本" },
    { id: "calc", icon: "🧮", label: "计算器", desc: "打开计算器" },
    { id: "terminal", icon: "🖥️", label: "终端", desc: "命令行面板" },
    { id: "quicklaunch", icon: "📌", label: "快捷访问", desc: "常用程序启动" },
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
    if (toolId === "json" || toolId === "todo" || toolId === "quicklaunch") {
      setActiveView(toolId);
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

  // ============================================
  // JSON 格式化器逻辑
  // ============================================
  const [jsonInput, setJsonInput] = useState("");
  const [jsonError, setJsonError] = useState("");

  const formatJson = () => {
    if (!jsonInput.trim()) {
      setJsonError("");
      return;
    }
    try {
      const parsed = JSON.parse(jsonInput);
      setJsonInput(JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch (e: any) {
      setJsonError("无效的 JSON 文本: " + e.message);
    }
  };

  const escapeJson = () => {
    if (!jsonInput) return;
    const escaped = JSON.stringify(jsonInput).slice(1, -1);
    setJsonInput(escaped);
    setJsonError("");
  };

  const unescapeJson = () => {
    if (!jsonInput) return;
    try {
      const parsed = JSON.parse(`"${jsonInput}"`);
      setJsonInput(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch (e) {
      const unescaped = jsonInput
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      setJsonInput(unescaped);
      setJsonError("");
    }
  };

  const renderJsonView = () => (
    <div className="sub-view">
      <div className="sub-view-header">
        <div className="back-btn" onClick={() => setActiveView("main")}>
          <span className="back-icon">←</span> 返回
        </div>
        <h2 className="sub-view-title">JSON 工具</h2>
      </div>
      <div className="sub-view-content json-formatter">
        <textarea 
          className="json-input single-textarea" 
          placeholder="在此粘贴被处理的 JSON 文本..." 
          value={jsonInput}
          onChange={(e) => setJsonInput(e.target.value)}
        />
        <div className="json-btn-group">
          <button className="format-btn" onClick={formatJson}>格式化</button>
          <button className="action-btn" onClick={escapeJson}>转义</button>
          <button className="action-btn" onClick={unescapeJson}>去转义</button>
        </div>
        {jsonError && <div className="json-error">{jsonError}</div>}
      </div>
    </div>
  );

  // ============================================
  // TODO 待办事项逻辑
  // ============================================
  type TodoItem = { id: string; text: string; completed: boolean };
  const [todos, setTodos] = useState<TodoItem[]>(() => {
    try {
      const saved = localStorage.getItem("toolbox_todos");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [todoInput, setTodoInput] = useState("");

  useEffect(() => {
    localStorage.setItem("toolbox_todos", JSON.stringify(todos));
  }, [todos]);

  const addTodo = () => {
    if (!todoInput.trim()) return;
    setTodos([{ id: Date.now().toString(), text: todoInput.trim(), completed: false }, ...todos]);
    setTodoInput("");
  };

  const toggleTodo = (id: string) => {
    setTodos(todos.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
  };

  const deleteTodo = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTodos(todos.filter(t => t.id !== id));
  };

  const renderTodoView = () => (
    <div className="sub-view">
      <div className="sub-view-header">
        <div className="back-btn" onClick={() => setActiveView("main")}>
          <span className="back-icon">←</span> 返回
        </div>
        <h2 className="sub-view-title">待办事项</h2>
      </div>
      <div className="sub-view-content todo-container">
        <div className="todo-input-group">
          <input 
            type="text" 
            className="todo-input" 
            placeholder="添加新待办，回车保存..." 
            value={todoInput}
            onChange={e => setTodoInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addTodo()}
          />
          <button className="todo-add-btn" onClick={addTodo}>添加</button>
        </div>
        <div className="todo-list">
          {todos.length === 0 && <div className="todo-empty">暂无待办事项，快去添加吧！</div>}
          {todos.map(todo => (
            <div 
              key={todo.id} 
              className={`todo-item ${todo.completed ? 'completed' : ''}`}
              onClick={() => toggleTodo(todo.id)}
            >
              <div className="todo-checkbox">
                {todo.completed && <span className="todo-check-icon">✓</span>}
              </div>
              <span className="todo-text">{todo.text}</span>
              <button 
                className="todo-delete-btn" 
                onClick={(e) => deleteTodo(todo.id, e)}
                title="删除"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // ============================================
  // 快捷访问逻辑
  // ============================================
  type QuickLaunchGroup = { id: string; name: string };
  type QuickLaunchItem = { id: string; name: string; path: string; icon?: string; groupId?: string };

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

  useEffect(() => {
    localStorage.setItem("toolbox_quicklaunch_groups", JSON.stringify(quickLaunchGroups));
  }, [quickLaunchGroups]);

  useEffect(() => {
    localStorage.setItem("toolbox_quicklaunch", JSON.stringify(quickLaunchItems));
  }, [quickLaunchItems]);

  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [isAddingGroup, setIsAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const saveEditGroup = (id: string) => {
    if (editingGroupName.trim()) {
      setQuickLaunchGroups(prev => prev.map(g => g.id === id ? { ...g, name: editingGroupName.trim() } : g));
    }
    setEditingGroupId(null);
  };

  const saveNewGroup = () => {
    if (newGroupName.trim()) {
      const id = Date.now().toString();
      setQuickLaunchGroups(prev => [...prev, { id, name: newGroupName.trim() }]);
      setActiveGroupId(id);
    }
    setIsAddingGroup(false);
    setNewGroupName("");
  };

  const deleteGroup = (groupId: string) => {
    setQuickLaunchItems(prev => prev.map(item => item.groupId === groupId ? { ...item, groupId: "default" } : item));
    setQuickLaunchGroups(prev => prev.filter(g => g.id !== groupId));
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

      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        for (const filePath of paths) {
          const fileName = filePath.split("\\").pop() || filePath;
          const name = fileName.replace(/\.\w+$/, "");
          const id = Date.now().toString() + Math.random().toString(36).slice(2);

          setQuickLaunchItems(prev => [...prev, { id, name, path: filePath, groupId: activeGroupId }]);

          // 异步提取程序图标
          invoke<string>("extract_program_icon", { path: filePath })
            .then((icon) => {
              setQuickLaunchItems(prev =>
                prev.map(item => item.id === id ? { ...item, icon } : item)
              );
            })
            .catch(() => {});
        }
      }
    } finally {
      isDialogOpenRef.current = false;
    }
  };

  const removeQuickLaunchItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setQuickLaunchItems(prev => prev.filter(item => item.id !== id));
  };

  const launchProgram = (path: string) => {
    invoke("launch_program", { path }).catch(console.error);
  };

  const renderQuickLaunchView = () => {
    const currentItems = quickLaunchItems.filter(item => (item.groupId || "default") === activeGroupId);
    const activeGroupName = quickLaunchGroups.find(g => g.id === activeGroupId)?.name || "快捷访问";

    return (
      <div className="sub-view quicklaunch-split-view">
        {/* 左侧垂直侧栏 */}
        <div className="sub-view-sidebar">
          <div className="sub-view-sidebar-header">
            <div className="back-btn" onClick={() => setActiveView("main")}>
              <span className="back-icon">←</span> 返回
            </div>
            <h2 className="sub-view-title">分类分组</h2>
          </div>
          <div className="quicklaunch-nav">
            {quickLaunchGroups.map(group => (
              <div 
                key={group.id} 
                className={`quicklaunch-nav-item ${activeGroupId === group.id ? 'active' : ''}`}
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
                    onChange={e => setEditingGroupName(e.target.value)}
                    onBlur={() => saveEditGroup(group.id)}
                    onKeyDown={e => e.key === 'Enter' && saveEditGroup(group.id)}
                  />
                ) : (
                  <>
                    <span className="nav-text" title={group.name}>{group.name}</span>
                    {group.id !== "default" && (
                      <span className="nav-delete" title="删除分组" onClick={(e) => { e.stopPropagation(); deleteGroup(group.id); }}>×</span>
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
                onChange={e => setNewGroupName(e.target.value)}
                onBlur={saveNewGroup}
                onKeyDown={e => e.key === 'Enter' && saveNewGroup()}
              />
            ) : (
              <div className="quicklaunch-nav-item add-btn" title="新建分组" onClick={() => setIsAddingGroup(true)}>
                + 新建
              </div>
            )}
          </div>
        </div>

        {/* 右侧主内容 */}
        <div className="sub-view-main">
          <div className="sub-view-main-header">
            <h2 className="sub-view-title active-group-title">{activeGroupName}</h2>
            <button className="add-program-btn" onClick={addQuickLaunchItem}>+ 添加程序</button>
          </div>
          <div className="sub-view-content quicklaunch-container">
            {currentItems.length === 0 ? (
              <div className="quicklaunch-empty">
                此分组还没有添加程序
              </div>
            ) : (
              <div className="quicklaunch-grid">
                {currentItems.map(item => (
                  <div
                    key={item.id}
                    className="quicklaunch-item"
                    onClick={() => launchProgram(item.path)}
                    title={item.path}
                  >
                    <button
                      className="quicklaunch-delete-btn"
                      onClick={(e) => removeQuickLaunchItem(item.id, e)}
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
  };


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
                    <div className="content-left">
                      <div className="switch-icon">{sw.icon}</div>
                      <div className="switch-label">{sw.label}</div>
                    </div>
                    <div className="switch-toggle-track">
                      <div className="switch-toggle-thumb" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : activeView === "json" ? (
          renderJsonView()
        ) : activeView === "todo" ? (
          renderTodoView()
        ) : activeView === "quicklaunch" ? (
          renderQuickLaunchView()
        ) : null}
      </div>
    </div>
  );
}

export default App;
