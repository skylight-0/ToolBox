import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import SubViewHeader from "../../components/SubViewHeader";
import ProxyGroupView from "./components/ProxyGroupView";
import ProfileView from "./components/ProfileView";
import ClashSettings from "./components/ClashSettings";
import { useClash } from "./hooks/useClash";
import { useProfile } from "./hooks/useProfile";
import { useProxy } from "./hooks/useProxy";
import type { ClashTab } from "./types/clash";

type ClashViewProps = {
  onBack: () => void;
};

const TABS: Array<{ id: ClashTab; label: string }> = [
  { id: "proxy", label: "代理" },
  { id: "profile", label: "订阅" },
  { id: "settings", label: "设置" },
];

function ClashView({ onBack }: ClashViewProps) {
  const [tab, setTab] = useState<ClashTab>("proxy");
  const clash = useClash();
  const profile = useProfile();
  const proxy = useProxy();

  const running = clash.runningMode !== "NotRunning";
  const sysProxyOn = !!clash.sysProxy?.enable;

  // 内核启停后刷新代理组列表
  useEffect(() => {
    proxy.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clash.runningMode]);

  // 选择/导入新 Profile 后刷新内核信息（启停状态保持，但下次启动才会生效）
  const handleSelectProfile = async (uid: string) => {
    await profile.selectProfile(uid);
    // 若内核正在运行，提示用户重启以应用新订阅
    if (running) {
      try {
        await clash.restartCore();
      } catch (error) {
        console.error("[clash] restart after select failed", error);
      }
    }
  };

  const handleImport = async (url: string, name?: string) => {
    await profile.importRemote(url, name);
  };

  const headerActions = useMemo(() => {
    return (
      <div className="clash-status-bar">
        <button
          className={`clash-pill-btn ${running ? "active" : ""}`}
          onClick={() => clash.toggleCore()}
          disabled={clash.loading}
          title="切换内核运行状态"
        >
          <span className={`clash-dot ${running ? "on" : "off"}`} />
          {running ? "内核运行中" : "内核已停止"}
        </button>
        <button
          className={`clash-pill-btn ${sysProxyOn ? "active" : ""}`}
          onClick={() => clash.toggleSysProxy()}
          disabled={!clash.sysProxy || !running}
          title={running ? "切换系统代理" : "需先启动内核"}
        >
          <span className={`clash-dot ${sysProxyOn ? "on" : "off"}`} />
          系统代理
        </button>
      </div>
    );
  }, [clash, running, sysProxyOn]);

  return (
    <div className="sub-view">
      <SubViewHeader title="Clash 代理" onBack={onBack} actions={headerActions} />
      <div className="sub-view-content">
        <div className="clash-tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`clash-tab ${tab === item.id ? "active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === "proxy" && (
          <ProxyGroupView
            groups={proxy.groups}
            loading={proxy.loading}
            delays={proxy.delays}
            testing={proxy.testing}
            groupTesting={proxy.groupTesting}
            onRefresh={proxy.refresh}
            onSelectProxy={proxy.selectProxy}
            onTestDelay={proxy.testDelay}
            onTestGroupDelay={proxy.testGroupDelay}
          />
        )}
        {tab === "profile" && (
          <ProfileView
            profiles={profile.profiles}
            loading={profile.loading}
            importing={profile.importing}
            onImport={handleImport}
            onSelect={handleSelectProfile}
            onUpdate={profile.updateProfile}
            onDelete={profile.deleteProfile}
          />
        )}
        {tab === "settings" && (
          <ClashSettings
            info={clash.info}
            sysProxy={clash.sysProxy}
            onResetSystemProxy={async () => {
              try {
                await invoke("clash_reset_sysproxy");
                await clash.refresh();
              } catch (error) {
                console.error("[clash] reset sysproxy failed", error);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

export default ClashView;