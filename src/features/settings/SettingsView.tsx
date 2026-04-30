import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { DragEvent, MutableRefObject } from "react";
import SubViewHeader from "../../components/SubViewHeader";
import type { ToolId, ToolItem } from "../../types/sidebar";

export type ClipboardDefaultDateFilter = "today" | "last7" | "all";

type SettingsViewProps = {
  onBack: () => void;
  sidebarWidth: number;
  clipboardMonitoring: boolean;
  clipboardDefaultDateFilter: ClipboardDefaultDateFilter;
  passwordRequireAuth: boolean;
  tools: ToolItem[];
  isDialogOpenRef: MutableRefObject<boolean>;
  onSidebarWidthChange: (width: number) => void;
  onClipboardMonitoringChange: (enabled: boolean) => void;
  onClipboardDefaultDateFilterChange: (filter: ClipboardDefaultDateFilter) => void;
  onPasswordRequireAuthChange: (enabled: boolean) => void;
  onToolOrderChange: (toolIds: ToolId[]) => void;
  onToolOrderReset: () => void;
};

const dateFilterOptions: Array<{ id: ClipboardDefaultDateFilter; label: string; description: string }> = [
  { id: "today", label: "今天", description: "剪切板页面默认只显示当天记录" },
  { id: "last7", label: "最近 7 天", description: "适合需要跨天查找近期内容" },
  { id: "all", label: "全部", description: "打开剪切板页面时直接显示完整历史" },
];

function SettingsView({
  onBack,
  sidebarWidth,
  clipboardMonitoring,
  clipboardDefaultDateFilter,
  passwordRequireAuth,
  tools,
  isDialogOpenRef,
  onSidebarWidthChange,
  onClipboardMonitoringChange,
  onClipboardDefaultDateFilterChange,
  onPasswordRequireAuthChange,
  onToolOrderChange,
  onToolOrderReset,
}: SettingsViewProps) {
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [isLoadingAutostart, setIsLoadingAutostart] = useState(true);
  const [isUpdatingPasswordAuth, setIsUpdatingPasswordAuth] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [draggingToolId, setDraggingToolId] = useState<ToolId | null>(null);

  useEffect(() => {
    invoke<boolean>("get_autostart_enabled")
      .then(setAutostartEnabled)
      .catch((error) => setSettingsError(String(error)))
      .finally(() => setIsLoadingAutostart(false));
  }, []);

  const updateAutostart = async (enabled: boolean) => {
    setAutostartEnabled(enabled);
    setSettingsError("");
    try {
      await invoke("set_autostart_enabled", { enabled });
    } catch (error) {
      setAutostartEnabled(!enabled);
      setSettingsError(String(error));
    }
  };

  const updateClipboardMonitoring = (enabled: boolean) => {
    onClipboardMonitoringChange(enabled);
  };

  const updateClipboardDateFilter = async (filter: ClipboardDefaultDateFilter) => {
    onClipboardDefaultDateFilterChange(filter);
    await invoke("set_setting", {
      key: "clipboard_default_date_filter",
      value: filter,
    }).catch((error) => setSettingsError(String(error)));
  };

  const updatePasswordRequireAuth = async (enabled: boolean) => {
    setSettingsError("");
    setIsUpdatingPasswordAuth(true);
    isDialogOpenRef.current = true;
    try {
      const authenticated = await invoke<boolean>("authenticate_password_vault");
      if (!authenticated) {
        setSettingsError("Windows 用户密码验证未通过或已取消");
        return;
      }
      onPasswordRequireAuthChange(enabled);
    } catch (error) {
      setSettingsError(String(error));
    } finally {
      isDialogOpenRef.current = false;
      setIsUpdatingPasswordAuth(false);
    }
  };

  const updateSidebarWidth = (width: number) => {
    onSidebarWidthChange(width);
  };

  const moveTool = (toolId: ToolId, direction: -1 | 1) => {
    const currentIndex = tools.findIndex((tool) => tool.id === toolId);
    const targetIndex = currentIndex + direction;

    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= tools.length) return;

    const nextTools = [...tools];
    const [movedTool] = nextTools.splice(currentIndex, 1);
    nextTools.splice(targetIndex, 0, movedTool);
    onToolOrderChange(nextTools.map((tool) => tool.id));
  };

  const handleToolDragStart = (event: DragEvent<HTMLDivElement>, toolId: ToolId) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", toolId);
    setDraggingToolId(toolId);
  };

  const handleToolDrop = (event: DragEvent<HTMLDivElement>, targetToolId: ToolId) => {
    event.preventDefault();

    if (!draggingToolId || draggingToolId === targetToolId) {
      setDraggingToolId(null);
      return;
    }

    const nextTools = [...tools];
    const fromIndex = nextTools.findIndex((tool) => tool.id === draggingToolId);
    const toIndex = nextTools.findIndex((tool) => tool.id === targetToolId);

    if (fromIndex < 0 || toIndex < 0) {
      setDraggingToolId(null);
      return;
    }

    const [movedTool] = nextTools.splice(fromIndex, 1);
    nextTools.splice(toIndex, 0, movedTool);
    onToolOrderChange(nextTools.map((tool) => tool.id));
    setDraggingToolId(null);
  };

  return (
    <div className="sub-view settings-view">
      <SubViewHeader title="设置" onBack={onBack} />
      <div className="sub-view-content app-settings-container">
        {settingsError && <div className="app-settings-error">{settingsError}</div>}

        <section className="app-settings-section">
          <div className="app-settings-section-header">
            <h3>系统</h3>
          </div>
          <label className="app-settings-row">
            <div>
              <div className="app-settings-row-title">开机自启</div>
              <div className="app-settings-row-description">登录 Windows 后自动启动 ToolBox</div>
            </div>
            <input
              type="checkbox"
              className="app-settings-switch"
              checked={autostartEnabled}
              disabled={isLoadingAutostart}
              onChange={(event) => void updateAutostart(event.target.checked)}
            />
          </label>
        </section>

        <section className="app-settings-section">
          <div className="app-settings-section-header">
            <h3>密码管理</h3>
          </div>
          <label className="app-settings-row">
            <div>
              <div className="app-settings-row-title">进入前验证 Windows 用户密码</div>
              <div className="app-settings-row-description">关闭后进入密码管理工具不再弹出用户密码验证；更改此配置仍需要验证</div>
            </div>
            <input
              type="checkbox"
              className="app-settings-switch"
              checked={passwordRequireAuth}
              disabled={isUpdatingPasswordAuth}
              onChange={(event) => void updatePasswordRequireAuth(event.target.checked)}
            />
          </label>
        </section>

        <section className="app-settings-section">
          <div className="app-settings-section-header">
            <h3>剪切板</h3>
          </div>
          <label className="app-settings-row">
            <div>
              <div className="app-settings-row-title">剪切板监控</div>
              <div className="app-settings-row-description">后台记录复制的文本和图片</div>
            </div>
            <input
              type="checkbox"
              className="app-settings-switch"
              checked={clipboardMonitoring}
              onChange={(event) => updateClipboardMonitoring(event.target.checked)}
            />
          </label>

          <div className="app-settings-field">
            <div className="app-settings-row-title">默认日期筛选</div>
            <div className="app-settings-segmented">
              {dateFilterOptions.map((option) => (
                <button
                  key={option.id}
                  className={clipboardDefaultDateFilter === option.id ? "active" : ""}
                  onClick={() => void updateClipboardDateFilter(option.id)}
                  title={option.description}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="app-settings-section">
          <div className="app-settings-section-header">
            <h3>侧边栏</h3>
            <span>{sidebarWidth}px</span>
          </div>
          <div className="app-settings-field">
            <input
              className="app-settings-range"
              type="range"
              min={280}
              max={1200}
              step={20}
              value={sidebarWidth}
              onChange={(event) => updateSidebarWidth(Number(event.target.value))}
            />
            <div className="app-settings-width-presets">
              {[360, 480, 640, 800].map((width) => (
                <button key={width} onClick={() => updateSidebarWidth(width)}>
                  {width}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="app-settings-section">
          <div className="app-settings-section-header">
            <h3>功能区</h3>
            <button
              className="app-settings-reset-btn"
              type="button"
              onClick={onToolOrderReset}
            >
              恢复默认
            </button>
          </div>
          <div className="app-settings-tool-list">
            {tools.map((tool, index) => (
              <div
                key={tool.id}
                className={`app-settings-tool-item ${draggingToolId === tool.id ? "dragging" : ""}`}
                draggable
                onDragStart={(event) => handleToolDragStart(event, tool.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => handleToolDrop(event, tool.id)}
                onDragEnd={() => setDraggingToolId(null)}
              >
                <div className="app-settings-tool-drag" aria-hidden="true">☰</div>
                <div className="app-settings-tool-icon" aria-hidden="true">
                  {tool.iconSrc ? <img src={tool.iconSrc} alt="" /> : tool.icon}
                </div>
                <div className="app-settings-tool-copy">
                  <div className="app-settings-row-title">{tool.label}</div>
                  <div className="app-settings-row-description">{tool.desc}</div>
                </div>
                <div className="app-settings-tool-actions">
                  <button
                    type="button"
                    onClick={() => moveTool(tool.id, -1)}
                    disabled={index === 0}
                    title="上移"
                    aria-label={`${tool.label} 上移`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveTool(tool.id, 1)}
                    disabled={index === tools.length - 1}
                    title="下移"
                    aria-label={`${tool.label} 下移`}
                  >
                    ↓
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export default SettingsView;
