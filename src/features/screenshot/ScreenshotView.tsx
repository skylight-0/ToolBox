import { invoke } from "@tauri-apps/api/core";
import SubViewHeader from "../../components/SubViewHeader";

type ScreenshotViewProps = {
  onBack: () => void;
  shortcutEnabled: boolean;
  onShortcutToggle: (enabled: boolean) => void;
};

export default function ScreenshotView({ onBack, shortcutEnabled, onShortcutToggle }: ScreenshotViewProps) {
  const start = () => {
    void invoke("start_screenshot").catch((error) => console.error("启动截图失败", error));
  };

  return (
    <div className="sub-view">
      <SubViewHeader title="截图与钉图" onBack={onBack} />
      <div className="sub-view-content screenshot-view">
        <div className="screenshot-hero">
          <div className="screenshot-hero-title">区域截图 · 钉在桌面置顶</div>
          <div className="screenshot-hero-desc">
            按下快捷键或点击按钮，框选屏幕任意区域，可复制到剪贴板、保存为 PNG，或钉在桌面置顶显示。
          </div>
          <button className="format-btn screenshot-start-btn" onClick={start}>
            开始截图
          </button>
        </div>

        <section className="app-settings-section">
          <div className="app-settings-section-header">
            <h3>快捷键</h3>
          </div>
          <label className="app-settings-row">
            <div>
              <div className="app-settings-row-title">Ctrl + Shift + A</div>
              <div className="app-settings-row-description">开启后随时按下快捷键进入截图模式</div>
            </div>
            <input
              type="checkbox"
              className="app-settings-switch"
              checked={shortcutEnabled}
              onChange={(event) => onShortcutToggle(event.target.checked)}
            />
          </label>
        </section>

        <section className="app-settings-section screenshot-tips">
          <div className="app-settings-section-header">
            <h3>操作说明</h3>
          </div>
          <ul className="screenshot-tip-list">
            <li>拖拽鼠标选择截图区域</li>
            <li>Enter 复制到剪贴板，Esc 取消截图</li>
            <li>多显示器时使用 ← / → 切换屏幕</li>
            <li>钉图后可在桌面任意拖动，滚轮缩放，右键关闭</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
