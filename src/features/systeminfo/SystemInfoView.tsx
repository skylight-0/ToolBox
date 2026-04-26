import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import SubViewHeader from "../../components/SubViewHeader";

type SystemInfoViewProps = {
  onBack: () => void;
};

type SystemInfoSnapshot = {
  collectedAt: number;
  os: {
    name?: string | null;
    version?: string | null;
    longVersion?: string | null;
    kernelVersion?: string | null;
    hostName?: string | null;
    architecture: string;
    uptimeSeconds: number;
    bootTime: number;
  };
  cpu: {
    brand: string;
    vendor: string;
    physicalCoreCount?: number | null;
    logicalCoreCount: number;
    frequencyMhz: number;
    usagePercent: number;
  };
  memory: {
    total: number;
    used: number;
    available: number;
    free: number;
    totalSwap: number;
    usedSwap: number;
    freeSwap: number;
  };
  diskSummary: {
    total: number;
    used: number;
    available: number;
  };
  disks: Array<{
    name: string;
    mountPoint: string;
    fileSystem: string;
    kind: string;
    total: number;
    available: number;
    used: number;
    isRemovable: boolean;
    isReadOnly: boolean;
  }>;
  networks: Array<{
    name: string;
    macAddress: string;
    ipAddresses: string[];
    received: number;
    transmitted: number;
    packetsReceived: number;
    packetsTransmitted: number;
    mtu: number;
  }>;
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = unitIndex <= 1 ? 0 : size >= 100 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

function getUsagePercent(used: number, total: number) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function formatTime(timestamp: number) {
  if (!timestamp) return "未知";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function optionalText(value?: string | null) {
  return value && value.trim() ? value : "未知";
}

function buildSummary(info: SystemInfoSnapshot) {
  const memoryUsage = getUsagePercent(info.memory.used, info.memory.total);
  const diskUsage = getUsagePercent(info.diskSummary.used, info.diskSummary.total);

  return [
    `主机：${optionalText(info.os.hostName)}`,
    `系统：${optionalText(info.os.longVersion || info.os.name)}`,
    `CPU：${info.cpu.brand}，${info.cpu.logicalCoreCount} 线程，当前 ${formatPercent(info.cpu.usagePercent)}`,
    `内存：${formatBytes(info.memory.used)} / ${formatBytes(info.memory.total)} (${formatPercent(memoryUsage)})`,
    `磁盘：${formatBytes(info.diskSummary.used)} / ${formatBytes(info.diskSummary.total)} (${formatPercent(diskUsage)})`,
    `网络接口：${info.networks.length}`,
  ].join("\n");
}

function SystemInfoView({ onBack }: SystemInfoViewProps) {
  const [info, setInfo] = useState<SystemInfoSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const memoryUsagePercent = info ? getUsagePercent(info.memory.used, info.memory.total) : 0;
  const diskUsagePercent = info
    ? getUsagePercent(info.diskSummary.used, info.diskSummary.total)
    : 0;

  const primaryNetworks = useMemo(() => {
    if (!info) return [];
    return info.networks.filter((network) => network.ipAddresses.length > 0).slice(0, 6);
  }, [info]);

  const loadSystemInfo = async (showLoading = true) => {
    if (showLoading) setIsLoading(true);
    setError("");

    try {
      const snapshot = await invoke<SystemInfoSnapshot>("get_system_info");
      setInfo(snapshot);
      setMessage(showLoading ? "" : "已刷新");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (showLoading) setIsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const snapshot = await invoke<SystemInfoSnapshot>("get_system_info");
        if (!active) return;
        setInfo(snapshot);
        setError("");
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (active) setIsLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 15000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const copySummary = async () => {
    if (!info) return;

    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(buildSummary(info));
      setMessage("已复制摘要");
      setError("");
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };

  const actions = (
    <div className="systeminfo-header-actions">
      <button className="systeminfo-header-btn" onClick={() => void loadSystemInfo(false)}>
        刷新
      </button>
    </div>
  );

  return (
    <div className="sub-view">
      <SubViewHeader title="本机信息" onBack={onBack} actions={actions} />
      <div className="sub-view-content systeminfo-view">
        {isLoading && <div className="systeminfo-state">正在读取本机信息...</div>}
        {error && <div className="systeminfo-message error">{error}</div>}
        {message && !error && <div className="systeminfo-message success">{message}</div>}

        {info && (
          <>
            <div className="systeminfo-toolbar">
              <button className="systeminfo-toolbar-btn" onClick={() => void copySummary()}>
                复制摘要
              </button>
            </div>

            <div className="systeminfo-overview">
              <section className="systeminfo-metric-card">
                <span className="systeminfo-metric-label">CPU</span>
                <strong>{formatPercent(info.cpu.usagePercent)}</strong>
                <span>{info.cpu.logicalCoreCount} 线程</span>
              </section>
              <section className="systeminfo-metric-card">
                <span className="systeminfo-metric-label">内存</span>
                <strong>{formatPercent(memoryUsagePercent)}</strong>
                <span>{formatBytes(info.memory.available)} 可用</span>
              </section>
              <section className="systeminfo-metric-card">
                <span className="systeminfo-metric-label">磁盘</span>
                <strong>{formatPercent(diskUsagePercent)}</strong>
                <span>{info.disks.length} 个挂载点</span>
              </section>
            </div>

            <section className="systeminfo-section">
              <div className="systeminfo-section-header">
                <h3>系统</h3>
                <span>{formatTime(info.collectedAt)}</span>
              </div>
              <div className="systeminfo-kv-grid">
                <div>
                  <span>主机名</span>
                  <strong>{optionalText(info.os.hostName)}</strong>
                </div>
                <div>
                  <span>系统版本</span>
                  <strong>{optionalText(info.os.longVersion || info.os.name)}</strong>
                </div>
                <div>
                  <span>内核</span>
                  <strong>{optionalText(info.os.kernelVersion)}</strong>
                </div>
                <div>
                  <span>架构</span>
                  <strong>{info.os.architecture}</strong>
                </div>
                <div>
                  <span>已运行</span>
                  <strong>{formatDuration(info.os.uptimeSeconds)}</strong>
                </div>
                <div>
                  <span>启动时间</span>
                  <strong>{formatTime(info.os.bootTime * 1000)}</strong>
                </div>
              </div>
            </section>

            <section className="systeminfo-section">
              <div className="systeminfo-section-header">
                <h3>CPU 与内存</h3>
                <span>{info.cpu.vendor}</span>
              </div>
              <div className="systeminfo-detail-card">
                <div className="systeminfo-detail-title">{info.cpu.brand}</div>
                <div className="systeminfo-detail-meta">
                  <span>{info.cpu.physicalCoreCount || "-"} 核</span>
                  <span>{info.cpu.logicalCoreCount} 线程</span>
                  <span>{info.cpu.frequencyMhz || "-"} MHz</span>
                </div>
                <div className="systeminfo-progress-row">
                  <span>CPU 使用率</span>
                  <span>{formatPercent(info.cpu.usagePercent)}</span>
                </div>
                <div className="systeminfo-progress-track">
                  <div style={{ width: formatPercent(info.cpu.usagePercent) }} />
                </div>
              </div>
              <div className="systeminfo-detail-card">
                <div className="systeminfo-progress-row">
                  <span>内存</span>
                  <span>
                    {formatBytes(info.memory.used)} / {formatBytes(info.memory.total)}
                  </span>
                </div>
                <div className="systeminfo-progress-track">
                  <div style={{ width: formatPercent(memoryUsagePercent) }} />
                </div>
                <div className="systeminfo-detail-meta">
                  <span>可用 {formatBytes(info.memory.available)}</span>
                  <span>空闲 {formatBytes(info.memory.free)}</span>
                  <span>
                    交换 {formatBytes(info.memory.usedSwap)} / {formatBytes(info.memory.totalSwap)}
                  </span>
                </div>
              </div>
            </section>

            <section className="systeminfo-section">
              <div className="systeminfo-section-header">
                <h3>磁盘</h3>
                <span>{formatBytes(info.diskSummary.available)} 可用</span>
              </div>
              <div className="systeminfo-list">
                {info.disks.map((disk) => {
                  const usage = getUsagePercent(disk.used, disk.total);
                  return (
                    <div className="systeminfo-list-item" key={`${disk.mountPoint}-${disk.name}`}>
                      <div className="systeminfo-list-top">
                        <strong>{disk.mountPoint || disk.name}</strong>
                        <span>{formatPercent(usage)}</span>
                      </div>
                      <div className="systeminfo-progress-track">
                        <div style={{ width: formatPercent(usage) }} />
                      </div>
                      <div className="systeminfo-detail-meta">
                        <span>{disk.fileSystem || "未知文件系统"}</span>
                        <span>{disk.kind}</span>
                        <span>
                          {formatBytes(disk.used)} / {formatBytes(disk.total)}
                        </span>
                        {disk.isRemovable && <span>可移动</span>}
                        {disk.isReadOnly && <span>只读</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="systeminfo-section">
              <div className="systeminfo-section-header">
                <h3>网络</h3>
                <span>{info.networks.length} 个接口</span>
              </div>
              <div className="systeminfo-list">
                {(primaryNetworks.length > 0 ? primaryNetworks : info.networks.slice(0, 6)).map(
                  (network) => (
                    <div className="systeminfo-list-item" key={network.name}>
                      <div className="systeminfo-list-top">
                        <strong>{network.name}</strong>
                        <span>MTU {network.mtu || "-"}</span>
                      </div>
                      <div className="systeminfo-network-addresses">
                        {network.ipAddresses.length > 0 ? network.ipAddresses.join(" · ") : "无 IP"}
                      </div>
                      <div className="systeminfo-detail-meta">
                        <span>MAC {network.macAddress}</span>
                        <span>收 {formatBytes(network.received)}</span>
                        <span>发 {formatBytes(network.transmitted)}</span>
                        <span>
                          包 {network.packetsReceived} / {network.packetsTransmitted}
                        </span>
                      </div>
                    </div>
                  ),
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default SystemInfoView;
