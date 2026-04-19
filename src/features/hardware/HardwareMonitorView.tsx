import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import SubViewHeader from "../../components/SubViewHeader";

type HardwareMonitorViewProps = {
  onBack: () => void;
};

type HardwareMetrics = {
  cpu_usage: number | null;
  gpu_usage: number | null;
  memory_usage: number | null;
  memory_used_gb: number | null;
  memory_total_gb: number | null;
  cpu_temperature: number | null;
  gpu_temperature: number | null;
  updated_at: string | null;
};

const EMPTY_METRICS: HardwareMetrics = {
  cpu_usage: null,
  gpu_usage: null,
  memory_usage: null,
  memory_used_gb: null,
  memory_total_gb: null,
  cpu_temperature: null,
  gpu_temperature: null,
  updated_at: null,
};

function formatPercent(value: number | null) {
  return value === null ? "不可用" : `${value.toFixed(1)}%`;
}

function formatTemperature(value: number | null) {
  return value === null ? "不可用" : `${value.toFixed(1)}°C`;
}

function formatMemory(used: number | null, total: number | null) {
  if (used === null || total === null) return "不可用";
  return `${used.toFixed(1)} / ${total.toFixed(1)} GB`;
}

function HardwareMonitorView({ onBack }: HardwareMonitorViewProps) {
  const [metrics, setMetrics] = useState<HardwareMetrics>(EMPTY_METRICS);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let isMounted = true;

    const loadMetrics = async () => {
      try {
        const next = await invoke<HardwareMetrics>("get_hardware_metrics");
        if (!isMounted) return;
        setMetrics(next);
        setError("");
      } catch (err) {
        if (!isMounted) return;
        const message = err instanceof Error ? err.message : "读取硬件监控数据失败";
        setError(message);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    loadMetrics();
    const timer = window.setInterval(loadMetrics, 2500);

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="sub-view">
      <SubViewHeader title="硬件监控" onBack={onBack} />
      <div className="sub-view-content hardware-monitor-container">
        <div className="hardware-monitor-summary">
          <div className="hardware-monitor-summary-text">
            实时显示 CPU、GPU、内存使用情况，并尽力读取温度信息。
          </div>
          <div className="hardware-monitor-updated">
            {metrics.updated_at ? `更新于 ${metrics.updated_at}` : "等待首次采集..."}
          </div>
        </div>

        {error && <div className="hardware-monitor-error">{error}</div>}

        <div className="hardware-monitor-grid">
          <div className="hardware-card">
            <div className="hardware-card-label">CPU 使用率</div>
            <div className="hardware-card-value">{formatPercent(metrics.cpu_usage)}</div>
          </div>
          <div className="hardware-card">
            <div className="hardware-card-label">CPU 温度</div>
            <div className="hardware-card-value">
              {isLoading ? "加载中..." : formatTemperature(metrics.cpu_temperature)}
            </div>
          </div>
          <div className="hardware-card">
            <div className="hardware-card-label">GPU 使用率</div>
            <div className="hardware-card-value">{formatPercent(metrics.gpu_usage)}</div>
          </div>
          <div className="hardware-card">
            <div className="hardware-card-label">GPU 温度</div>
            <div className="hardware-card-value">
              {isLoading ? "加载中..." : formatTemperature(metrics.gpu_temperature)}
            </div>
          </div>
          <div className="hardware-card hardware-card-wide">
            <div className="hardware-card-label">内存使用率</div>
            <div className="hardware-card-value">{formatPercent(metrics.memory_usage)}</div>
            <div className="hardware-card-meta">
              已用 / 总量: {formatMemory(metrics.memory_used_gb, metrics.memory_total_gb)}
            </div>
          </div>
        </div>

        <div className="hardware-monitor-note">
          温度依赖 Windows 可提供的传感器数据。部分机器，尤其是某些 GPU 或主板环境下，温度可能显示为“不可用”。
        </div>
      </div>
    </div>
  );
}

export default HardwareMonitorView;
