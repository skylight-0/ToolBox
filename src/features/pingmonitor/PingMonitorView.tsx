import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import type { EChartsOption } from "echarts";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import SubViewHeader from "../../components/SubViewHeader";

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

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

function formatTimestamp(value: number) {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildPingChartOption(samples: PingSample[]): EChartsOption {
  return {
    grid: { left: 50, right: 20, top: 18, bottom: 30 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(15, 23, 42, 0.94)",
      borderColor: "rgba(148, 163, 184, 0.24)",
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: "#f8fafc", fontSize: 12 },
      axisPointer: {
        type: "line",
        lineStyle: { color: "rgba(37, 99, 235, 0.4)", width: 1 },
      },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        const dataIndex: number = p?.dataIndex;
        const sample = Number.isInteger(dataIndex) ? samples[dataIndex] : undefined;
        if (!sample) return "";
        const rows: Array<[string, string]> = [
          ["采集时间", formatTimestamp(sample.timestamp)],
          ["延迟", typeof sample.latency === "number" && Number.isFinite(sample.latency) ? formatMs(sample.latency) : "失败"],
          ["当前时间", formatTimestamp(Date.now())],
        ];
        return rows
          .map(
            ([label, value]) =>
              `<div style="display:flex;justify-content:space-between;gap:14px;line-height:1.7;white-space:nowrap;">` +
              `<span style="color:#94a3b8;">${label}</span>` +
              `<span style="font-weight:600;font-family:Consolas,'Courier New',monospace;">${value}</span>` +
              `</div>`
          )
          .join("");
      },
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: samples.map((_, index) => String(index + 1)),
      axisLine: { lineStyle: { color: "rgba(76, 96, 130, 0.2)" } },
      axisTick: { show: false },
      axisLabel: { color: "#737f91", fontSize: 10, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      min: 0,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: "#737f91", fontSize: 10, formatter: "{value} ms" },
      splitLine: { lineStyle: { color: "rgba(15, 23, 42, 0.08)" } },
    },
    series: [
      {
        type: "line",
        showSymbol: false,
        symbol: "circle",
        symbolSize: 6,
        connectNulls: false,
        data: samples.map((sample) => sample.latency),
        lineStyle: { width: 2, color: "#2563eb" },
        itemStyle: { color: "#2563eb" },
        areaStyle: { color: "rgba(37, 99, 235, 0.1)" },
        emphasis: { focus: "series" },
      },
    ],
  };
}

function PingMonitorView({ onBack }: PingMonitorViewProps) {
  const [target, setTarget] = useState("example.com");
  const [frequency, setFrequency] = useState(2);
  const [samples, setSamples] = useState<PingSample[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<ReturnType<typeof echarts.init> | null>(null);

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
    const el = chartRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartInstanceRef.current = chart;
    chart.setOption(buildPingChartOption(samples));
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(el);
    return () => {
      resizeObserver.disconnect();
      chart.dispose();
      chartInstanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chart = chartInstanceRef.current;
    if (!chart) return;
    chart.setOption(buildPingChartOption(samples));
  }, [samples]);

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
          <div className="ping-chart-wrapper">
            <div className="ping-chart-canvas" ref={chartRef} />
            {!samples.length && (
              <div className="ping-chart-empty">点击“开始监控”后开始记录延迟数据</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default PingMonitorView;
