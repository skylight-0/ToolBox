import type { ClashInfo, SysproxyConfig } from "../types/clash";

type ClashSettingsProps = {
  info: ClashInfo | null;
  sysProxy: SysproxyConfig | null;
  onResetSystemProxy: () => Promise<void>;
};

function ClashSettings({ info, sysProxy, onResetSystemProxy }: ClashSettingsProps) {
  return (
    <div className="clash-settings">
      <div className="clash-section-header">
        <span>运行信息</span>
      </div>
      <div className="clash-info-grid">
        <div className="clash-info-row">
          <span className="label">运行模式</span>
          <span className="value">{info?.runningMode ?? "NotRunning"}</span>
        </div>
        <div className="clash-info-row">
          <span className="label">Mixed 端口</span>
          <span className="value">{info?.mixedPort ?? "-"}</span>
        </div>
        <div className="clash-info-row">
          <span className="label">HTTP 端口</span>
          <span className="value">{info?.httpPort ?? "-"}</span>
        </div>
        <div className="clash-info-row">
          <span className="label">SOCKS 端口</span>
          <span className="value">{info?.socksPort ?? "-"}</span>
        </div>
      </div>

      <div className="clash-section-header">
        <span>系统代理</span>
      </div>
      <div className="clash-info-grid">
        <div className="clash-info-row">
          <span className="label">代理地址</span>
          <span className="value">
            {sysProxy ? `${sysProxy.host}:${sysProxy.port}` : "-"}
          </span>
        </div>
        <div className="clash-info-row">
          <span className="label">代理状态</span>
          <span className="value">{sysProxy?.enable ? "已启用" : "已关闭"}</span>
        </div>
      </div>
      <button className="clash-mini-btn danger" onClick={onResetSystemProxy}>
        重置系统代理
      </button>

      <div className="clash-hint">
        提示：将 mihomo 内核二进制放入 src-tauri/binaries 目录后，
        启动内核才会真正运行代理进程。
      </div>
    </div>
  );
}

export default ClashSettings;