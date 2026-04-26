import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import SubViewHeader from "../../components/SubViewHeader";

type NetworkToolViewProps = {
  onBack: () => void;
};

type DnsLookupResult = {
  host: string;
  addresses: string[];
  durationMs: number;
};

type TcpPortCheckResult = {
  host: string;
  port: number;
  reachable: boolean;
  resolvedAddress?: string | null;
  durationMs: number;
  error?: string | null;
};

type PingResult = {
  host: string;
  success: boolean;
  exitCode?: number | null;
  durationMs: number;
  packetLossPercent?: number | null;
  averageMs?: number | null;
  output: string;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function cleanHost(value: string) {
  return value.trim();
}

function formatMs(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${Math.round(value)} ms`;
}

function formatPercent(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function buildDiagnosticText(
  target: string,
  dnsResult: DnsLookupResult | null,
  portResult: TcpPortCheckResult | null,
  pingResult: PingResult | null,
) {
  const lines = [`目标：${target || "-"}`];

  if (dnsResult) {
    lines.push(`DNS：${dnsResult.addresses.join(", ") || "无结果"} (${dnsResult.durationMs} ms)`);
  }
  if (portResult) {
    lines.push(
      `端口：${portResult.host}:${portResult.port} ${
        portResult.reachable ? "可连接" : "不可连接"
      } (${portResult.durationMs} ms)`,
    );
    if (portResult.resolvedAddress) lines.push(`连接地址：${portResult.resolvedAddress}`);
    if (portResult.error) lines.push(`端口错误：${portResult.error}`);
  }
  if (pingResult) {
    lines.push(
      `Ping：${pingResult.success ? "成功" : "失败"}，丢包 ${formatPercent(
        pingResult.packetLossPercent,
      )}，平均 ${formatMs(pingResult.averageMs)}`,
    );
    if (pingResult.output) lines.push(`\n${pingResult.output}`);
  }

  return lines.join("\n");
}

function NetworkToolView({ onBack }: NetworkToolViewProps) {
  const [target, setTarget] = useState("example.com");
  const [port, setPort] = useState("443");
  const [pingCount, setPingCount] = useState("4");
  const [dnsResult, setDnsResult] = useState<DnsLookupResult | null>(null);
  const [portResult, setPortResult] = useState<TcpPortCheckResult | null>(null);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [activeTask, setActiveTask] = useState<"dns" | "port" | "ping" | "all" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const normalizedTarget = useMemo(() => cleanHost(target), [target]);
  const parsedPort = Number(port);
  const parsedPingCount = Number(pingCount);
  const canRunPort = normalizedTarget && Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535;
  const canRunPing = normalizedTarget && Number.isInteger(parsedPingCount) && parsedPingCount > 0 && parsedPingCount <= 10;

  const resolveDns = async () => {
    if (!normalizedTarget) return null;
    setActiveTask("dns");
    setError("");
    setMessage("");

    try {
      const result = await invoke<DnsLookupResult>("resolve_dns", { host: normalizedTarget });
      setDnsResult(result);
      return result;
    } catch (taskError) {
      setError(getErrorMessage(taskError));
      return null;
    } finally {
      setActiveTask(null);
    }
  };

  const checkPort = async () => {
    if (!canRunPort) {
      setError("端口必须在 1-65535 之间");
      return null;
    }
    setActiveTask("port");
    setError("");
    setMessage("");

    try {
      const result = await invoke<TcpPortCheckResult>("check_tcp_port", {
        request: {
          host: normalizedTarget,
          port: parsedPort,
          timeoutMs: 2500,
        },
      });
      setPortResult(result);
      return result;
    } catch (taskError) {
      setError(getErrorMessage(taskError));
      return null;
    } finally {
      setActiveTask(null);
    }
  };

  const runPing = async () => {
    if (!canRunPing) {
      setError("Ping 次数必须在 1-10 之间");
      return null;
    }
    setActiveTask("ping");
    setError("");
    setMessage("");

    try {
      const result = await invoke<PingResult>("run_ping", {
        request: {
          host: normalizedTarget,
          count: parsedPingCount,
        },
      });
      setPingResult(result);
      return result;
    } catch (taskError) {
      setError(getErrorMessage(taskError));
      return null;
    } finally {
      setActiveTask(null);
    }
  };

  const runAll = async () => {
    if (!normalizedTarget) return;
    setActiveTask("all");
    setError("");
    setMessage("");

    try {
      const [dns, portCheck, ping] = await Promise.all([
        invoke<DnsLookupResult>("resolve_dns", { host: normalizedTarget }),
        canRunPort
          ? invoke<TcpPortCheckResult>("check_tcp_port", {
              request: { host: normalizedTarget, port: parsedPort, timeoutMs: 2500 },
            })
          : Promise.resolve(null),
        canRunPing
          ? invoke<PingResult>("run_ping", {
              request: { host: normalizedTarget, count: parsedPingCount },
            })
          : Promise.resolve(null),
      ]);

      setDnsResult(dns);
      setPortResult(portCheck);
      setPingResult(ping);
      setMessage("诊断完成");
    } catch (taskError) {
      setError(getErrorMessage(taskError));
    } finally {
      setActiveTask(null);
    }
  };

  const copyDiagnostics = async () => {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(buildDiagnosticText(normalizedTarget, dnsResult, portResult, pingResult));
      setMessage("已复制结果");
      setError("");
    } catch (copyError) {
      setError(getErrorMessage(copyError));
    }
  };

  return (
    <div className="sub-view">
      <SubViewHeader title="网络小工具" onBack={onBack} />
      <div className="sub-view-content network-tool">
        <section className="network-target-panel">
          <label className="network-field">
            <span>目标</span>
            <input
              className="network-input"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setMessage("");
                setError("");
              }}
              placeholder="域名、IP 或 URL"
            />
          </label>
          <div className="network-inline-fields">
            <label className="network-field">
              <span>端口</span>
              <input
                className="network-input"
                value={port}
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
              />
            </label>
            <label className="network-field">
              <span>Ping 次数</span>
              <input
                className="network-input"
                value={pingCount}
                inputMode="numeric"
                onChange={(event) => setPingCount(event.target.value.replace(/\D/g, "").slice(0, 2))}
              />
            </label>
          </div>
          <div className="network-action-row">
            <button className="format-btn" onClick={() => void runAll()} disabled={!normalizedTarget || activeTask !== null}>
              {activeTask === "all" ? "诊断中" : "一键诊断"}
            </button>
            <button className="action-btn" onClick={() => void copyDiagnostics()} disabled={!dnsResult && !portResult && !pingResult}>
              复制结果
            </button>
          </div>
        </section>

        {(message || error) && (
          <div className={`network-message ${error ? "error" : "success"}`}>
            {error || message}
          </div>
        )}

        <section className="network-card">
          <div className="network-card-header">
            <div>
              <h3>DNS</h3>
              <span>{dnsResult ? `${dnsResult.durationMs} ms` : "未运行"}</span>
            </div>
            <button className="network-mini-btn" onClick={() => void resolveDns()} disabled={!normalizedTarget || activeTask !== null}>
              {activeTask === "dns" ? "解析中" : "解析"}
            </button>
          </div>
          <div className="network-result-list">
            {dnsResult?.addresses.length ? (
              dnsResult.addresses.map((address) => (
                <div className="network-result-chip" key={address}>
                  {address}
                </div>
              ))
            ) : (
              <div className="network-empty">暂无结果</div>
            )}
          </div>
        </section>

        <section className="network-card">
          <div className="network-card-header">
            <div>
              <h3>端口检测</h3>
              <span>{portResult ? `${portResult.durationMs} ms` : "未运行"}</span>
            </div>
            <button className="network-mini-btn" onClick={() => void checkPort()} disabled={!canRunPort || activeTask !== null}>
              {activeTask === "port" ? "检测中" : "检测"}
            </button>
          </div>
          {portResult ? (
            <div className={`network-status ${portResult.reachable ? "success" : "failed"}`}>
              <strong>{portResult.reachable ? "可连接" : "不可连接"}</strong>
              <span>
                {portResult.resolvedAddress ||
                  portResult.error ||
                  `${portResult.host}:${portResult.port}`}
              </span>
            </div>
          ) : (
            <div className="network-empty">暂无结果</div>
          )}
        </section>

        <section className="network-card">
          <div className="network-card-header">
            <div>
              <h3>Ping</h3>
              <span>{pingResult ? `${pingResult.durationMs} ms` : "未运行"}</span>
            </div>
            <button className="network-mini-btn" onClick={() => void runPing()} disabled={!canRunPing || activeTask !== null}>
              {activeTask === "ping" ? "执行中" : "Ping"}
            </button>
          </div>
          {pingResult ? (
            <>
              <div className={`network-status ${pingResult.success ? "success" : "failed"}`}>
                <strong>{pingResult.success ? "成功" : "失败"}</strong>
                <span>
                  丢包 {formatPercent(pingResult.packetLossPercent)} · 平均{" "}
                  {formatMs(pingResult.averageMs)}
                </span>
              </div>
              <pre className="network-output">{pingResult.output || "无输出"}</pre>
            </>
          ) : (
            <div className="network-empty">暂无结果</div>
          )}
        </section>
      </div>
    </div>
  );
}

export default NetworkToolView;
