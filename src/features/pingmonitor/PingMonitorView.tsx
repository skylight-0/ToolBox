import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import SubViewHeader from "../../components/SubViewHeader";

type PingMonitorViewProps = {
  onBack: () => void;
};

type PingOnceResult = {
  host: string;
  success: boolean;
  latencyMs: number | null;
  error: string | null;
};

type PingSample = {
  id: number;
  timestamp: number;
  latency: number | null;
};

const MAX_SAMPLES = 80;
const FREQUENCY_OPTIONS = [1, 2, 5, 10, 30];
const CHART_HEIGHT = 180;
const CHART_MIN_YMAX = 50;

function cleanHost(value: string) {
  return value.trim();
}

function clampLower(value: number) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10) / 10;
}

function formatMs(value: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${Math.round(value * 10) / 10} ms`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function PingMonitorView({ onBack }: PingMonitorViewProps) {
  const [target, setTarget] = useState("example.com");
  const [frequency, setFrequency] = useState(2);
  const [samples, setSamples] = useState<PingSample[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const [chartWidth, setChartWidth] = useState(560);
  const chartContainerRef = useRef<HTMLDivElement>(null);

  const runningRef = useRef(false);
  const inflightRef = useRef(false);
  const counterRef = useRef(0);
  const hostRef = useRef("");

  const normalizedTarget = useMemo(() => cleanHost(target), [target]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    hostRef.current = normalizedTarget;
  }, [normalizedTarget]);

  useEffect(() => {
    const element = chartContainerRef.current;
    if (!element) return;

    const updateWidth = () => {
      const width = element.clientWidth;
      if (width > 0) setChartWidth(width);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const appendSample = (latency: number | null) => {
    counterRef.current += 1;
    const sample: PingSample = {
      id: counterRef.current,
      timestamp: Date.now(),
      latency,
    };
    setSamples((prev) => [...prev, sample].slice(-MAX_SAMPLES));
  };

  const handlePing = async () => {
    if (inflightRef.current || !runningRef.current) return;
    inflightRef.current = true;
    try {
      const result = await invoke<PingOnceResult>("ping_once", {
        request: { host: hostRef.current },
      });
      if (!runningRef.current) return;
      if (result.success) {
        appendSample(clampLower(result.latencyMs ?? 0));
        setError("");
      } else {
        appendSample(null);
        setError(result.error || "Ping 失败");
      }
    } catch (taskError) {
      if (!runningRef.current) return;
      appendSample(null);
      setError(String(taskError));
    } finally {
      inflightRef.current = false;
    }
  };

  useEffect(() => {
    if (!running) return;
    void handlePing();
    const intervalMs = Math.max(500, frequency * 1000);
    const intervalId = window.setInterval(() => {
      void handlePing();
    }, intervalMs);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, frequency]);

  const stats = useMemo(() => {
    if (!samples.length) {
      return { count: 0, success: 0, loss: 0, min: null, max: null, avg: null, last: null, jitter: null };
    }
    const latencies = samples
      .map((sample) => sample.latency)
      .filter((value): value is number => value !== null && Number.isFinite(value));

    const last = samples[samples.length - 1]?.latency ?? null;
    if (!latencies.length) {
      return {
        count: samples.length,
        success: 0,
        loss: 100,
        min: null,
        max: null,
        avg: null,
        last,
        jitter: null,
      };
    }

    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    const sum = latencies.reduce((total, value) => total + value, 0);
    const avg = sum / latencies.length;

    let jitter = 0;
    if (latencies.length > 1) {
      let totalDiff = 0;
      for (let index = 1; index < latencies.length; index += 1) {
        totalDiff += Math.abs(latencies[index] - latencies[index - 1]);
      }
      jitter = totalDiff / (latencies.length - 1);
    }

    return {
      count: samples.length,
      success: latencies.length,
      loss: ((samples.length - latencies.length) / samples.length) * 100,
      min,
      max,
      avg,
      last,
      jitter,
    };
  }, [samples]);

  const chartYMax = useMemo(() => {
    const candidate = stats.max === null ? 0 : stats.max * 1.2;
    return Math.max(candidate, CHART_MIN_YMAX);
  }, [stats.max]);

  const chart = useMemo(() => {
    const width = chartWidth;
    const height = CHART_HEIGHT;
    const padding = { top: 12, right: 8, bottom: 18, left: 38 };
    const plotWidth = Math.max(0, width - padding.left - padding.right);
    const plotHeight = Math.max(0, height - padding.top - padding.bottom);

    if (!samples.length) {
      return { width, height, padding, plotWidth, plotHeight, segments: [], gridLines: [] };
    }

    const denom = Math.max(1, samples.length - 1);
    const pointX = (index: number) => padding.left + (index / denom) * plotWidth;
    const pointY = (latency: number) =>
      padding.top + plotHeight - (Math.min(latency, chartYMax) / chartYMax) * plotHeight;

    const segments: { points: { x: number; y: number; index: number }[] }[] = [];
    let current: { x: number; y: number; index: number }[] = [];
    samples.forEach((sample, index) => {
      if (sample.latency === null) {
        if (current.length) {
          segments.push({ points: current });
          current = [];
        }
        return;
      }
      current.push({ x: pointX(index), y: pointY(sample.latency), index });
    });
    if (current.length) segments.push({ points: current });

    const gridLineValues = [0, chartYMax / 2, chartYMax];
    const gridLines = gridLineValues.map((value) => ({
      y: padding.top + plotHeight - (value / chartYMax) * plotHeight,
      label: Math.round(value),
    }));

    return { width, height, padding, plotWidth, plotHeight, segments, gridLines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, chartWidth, chartYMax]);

  const startMonitoring = () => {
    if (!normalizedTarget) {
      setError("请填写目标地址");
      return;
    }
    setError("");
    setSamples([]);
    counterRef.current = 0;
    setRunning(true);
  };

  const stopMonitoring = () => {
    setRunning(false);
  };

  const clearSamples = () => {
    setSamples([]);
    counterRef.current = 0;
    setError("");
  };

  return (
    <div className="sub-view">
      <SubViewHeader title="Ping 监控" onBack={onBack} />
      <div className="sub-view-content network-tool ping-monitor">
        <section className="network-target-panel">
          <label className="network-field">
            <span>目标</span>
            <input
              className="network-input"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                if (running) setRunning(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !running) void startMonitoring();
              }}
              placeholder="域名、IP 或 URL"
            />
          </label>
          <div className="network-inline-fields">
            <label className="network-field">
              <span>采样频率</span>
              <select
                className="network-input"
                value={frequency}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) setFrequency(value);
                }}
              >
                {FREQUENCY_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    每 {value} 秒
                  </option>
                ))}
              </select>
            </label>
            <div className="network-field">
              <span>状态</span>
              <div className={`ping-status-pill ${running ? "running" : ""}`}>
                <span className={`ping-dot ${running ? "active" : ""}`} />
                {running ? "监控中" : "已停止"}
              </div>
            </div>
          </div>
          <div className="network-action-row">
            <button
              className="format-btn"
              onClick={() => (running ? stopMonitoring() : void startMonitoring())}
              disabled={!normalizedTarget}
            >
              {running ? "停止监控" : "开始监控"}
            </button>
            <button
              className="action-btn"
              onClick={() => void clearSamples()}
              disabled={running || !samples.length}
            >
              清空记录
            </button>
          </div>
        </section>

        {error && (
          <div className="network-message error">最近错误：{error}</div>
        )}

        <section className="network-card ping-stats-grid">
          <div className="ping-stat">
            <span className="ping-stat-label">当前</span>
            <strong className="ping-stat-value">{formatMs(stats.last)}</strong>
          </div>
          <div className="ping-stat">
            <span className="ping-stat-label">平均</span>
            <strong className="ping-stat-value">{formatMs(stats.avg)}</strong>
          </div>
          <div className="ping-stat">
            <span className="ping-stat-label">最小</span>
            <strong className="ping-stat-value">{formatMs(stats.min)}</strong>
          </div>
          <div className="ping-stat">
            <span className="ping-stat-label">最大</span>
            <strong className="ping-stat-value">{formatMs(stats.max)}</strong>
          </div>
          <div className="ping-stat">
            <span className="ping-stat-label">抖动</span>
            <strong className="ping-stat-value">{formatMs(stats.jitter)}</strong>
          </div>
          <div className="ping-stat">
            <span className="ping-stat-label">丢包率</span>
            <strong className={`ping-stat-value ${stats.loss > 0 ? "warn" : ""}`}>
              {formatPercent(stats.loss)}
            </strong>
          </div>
        </section>

        <section className="network-card ping-chart-card">
          <div className="network-card-header">
            <div>
              <h3>延迟折线图</h3>
              <span>
                共 {stats.count} 次 · 成功 {stats.success} · 失败 {stats.count - stats.success}
              </span>
            </div>
          </div>
          <div className="ping-chart-wrapper" ref={chartContainerRef}>
            {!samples.length ? (
              <div className="network-empty">点击“开始监控”后开始记录延迟数据</div>
            ) : (
              <svg
                className="ping-chart"
                width={chart.width}
                height={chart.height}
                preserveAspectRatio="none"
              >
                {chart.gridLines.map((line) => (
                  <g key={`grid-${line.label}`}>
                    <line
                      x1={chart.padding.left}
                      x2={chart.width - chart.padding.right}
                      y1={line.y}
                      y2={line.y}
                      stroke="rgba(255,255,255,0.08)"
                      strokeWidth={1}
                    />
                    <text
                      x={chart.padding.left - 6}
                      y={line.y + 3}
                      textAnchor="end"
                      className="ping-chart-label"
                    >
                      {line.label} ms
                    </text>
                  </g>
                ))}
                {chart.segments.map((segment, segmentIndex) => {
                  if (segment.points.length === 0) return null;
                  if (segment.points.length === 1) {
                    const point = segment.points[0];
                    return (
                      <circle
                        key={`seg-${segmentIndex}`}
                        cx={point.x}
                        cy={point.y}
                        r={3}
                        className="ping-chart-line"
                      />
                    );
                  }
                  const path = segment.points
                    .map((point, index) => {
                      const segmentStart = index === 0 ? "M" : "L";
                      return `${segmentStart}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
                    })
                    .join(" ");
                  const last = segment.points[segment.points.length - 1];
                  return (
                    <g key={`seg-${segmentIndex}`}>
                      <path
                        d={path}
                        fill="none"
                        className="ping-chart-line"
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                      <circle
                        cx={last.x}
                        cy={last.y}
                        r={3.4}
                        className="ping-chart-dot"
                      />
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default PingMonitorView;