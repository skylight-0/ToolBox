import type { ProxyGroupInfo } from "../types/clash";

type ProxyGroupViewProps = {
  groups: ProxyGroupInfo[];
  loading: boolean;
  delays: Record<string, number | null>;
  testing: Record<string, boolean>;
  groupTesting: Record<string, boolean>;
  onRefresh: () => void;
  onSelectProxy: (group: string, proxy: string) => void;
  onTestDelay: (proxy: string) => void;
  onTestGroupDelay: (group: string) => void;
};

function formatDelay(delay: number | null | undefined) {
  if (delay === null || delay === undefined) return "--";
  return `${delay}ms`;
}

function delayClass(delay: number | null | undefined) {
  if (delay === null || delay === undefined) return "proxy-delay-unknown";
  if (delay < 100) return "proxy-delay-good";
  if (delay < 300) return "proxy-delay-ok";
  return "proxy-delay-bad";
}

function ProxyGroupView({
  groups,
  loading,
  delays,
  testing,
  groupTesting,
  onRefresh,
  onSelectProxy,
  onTestDelay,
  onTestGroupDelay,
}: ProxyGroupViewProps) {
  if (loading && groups.length === 0) {
    return <div className="clash-empty">加载代理组中...</div>;
  }
  if (groups.length === 0) {
    return (
      <div className="clash-empty">
        暂无代理组。请确认已导入订阅、选中订阅并启动内核。
      </div>
    );
  }

  return (
    <div className="clash-proxy-groups">
      <div className="clash-section-header">
        <span>代理组</span>
        <button className="clash-mini-btn" onClick={onRefresh} disabled={loading}>
          刷新
        </button>
      </div>
      {groups.map((group) => {
        // 仅 Selector 组支持手动切换节点，其它类型(URLTest/Fallback/...)由内核自动选最优
        const selectable = group.type === "Selector";
        return (
          <div key={group.name} className="proxy-group">
          <div className="proxy-group-title">
            <span>{group.name}</span>
            <span className="proxy-group-type">{group.type}</span>
            <button
              className="clash-mini-btn primary"
              disabled={!!groupTesting[group.name]}
              onClick={() => onTestGroupDelay(group.name)}
              title="测试本组所有节点延迟"
            >
              {groupTesting[group.name] ? "测速中..." : "测速"}
            </button>
          </div>
          <div className="proxy-nodes">
            {group.proxies.map((proxy) => {
              const active = group.now === proxy;
              return (
                <button
                  key={proxy}
                  className={`proxy-node ${active ? "active" : ""} ${selectable ? "" : "non-selectable"}`}
                  disabled={!selectable}
                  title={selectable ? "切换到此节点" : `${group.type} 组由内核自动选择，无法手动切换`}
                  onClick={selectable ? () => onSelectProxy(group.name, proxy) : undefined}
                >
                  <span className="proxy-node-name">{proxy}</span>
                  <span
                    className={`proxy-node-delay ${delayClass(delays[proxy])}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onTestDelay(proxy);
                    }}
                  >
                    {testing[proxy] ? "..." : formatDelay(delays[proxy])}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        );
      })}
    </div>
  );
}

export default ProxyGroupView;