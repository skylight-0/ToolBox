import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import SubViewHeader from "../../components/SubViewHeader";

export type ClipboardDefaultDateFilter = "today" | "last7" | "all";

type SettingsViewProps = {
  onBack: () => void;
  sidebarWidth: number;
  clipboardMonitoring: boolean;
  clipboardDefaultDateFilter: ClipboardDefaultDateFilter;
  onSidebarWidthChange: (width: number) => void;
  onClipboardMonitoringChange: (enabled: boolean) => void;
  onClipboardDefaultDateFilterChange: (filter: ClipboardDefaultDateFilter) => void;
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
  onSidebarWidthChange,
  onClipboardMonitoringChange,
  onClipboardDefaultDateFilterChange,
}: SettingsViewProps) {
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [isLoadingAutostart, setIsLoadingAutostart] = useState(true);
  const [settingsError, setSettingsError] = useState("");

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

  const updateSidebarWidth = (width: number) => {
    onSidebarWidthChange(width);
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
      </div>
    </div>
  );
}

export default SettingsView;
