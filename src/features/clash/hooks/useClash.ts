import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClashInfo, RunningMode, SysproxyConfig } from "../types/clash";

type UseClashResult = {
  loading: boolean;
  info: ClashInfo | null;
  runningMode: RunningMode;
  sysProxy: SysproxyConfig | null;
  toggleCore: () => Promise<void>;
  restartCore: () => Promise<void>;
  toggleSysProxy: (enable?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
};

export function useClash(): UseClashResult {
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<ClashInfo | null>(null);
  const [runningMode, setRunningMode] = useState<RunningMode>("NotRunning");
  const [sysProxy, setSysProxy] = useState<SysproxyConfig | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [mode, infoResult, proxy] = await Promise.all([
        invoke<RunningMode>("clash_get_running_mode"),
        invoke<ClashInfo>("clash_get_info"),
        invoke<SysproxyConfig>("clash_get_sysproxy"),
      ]);
      setRunningMode(mode);
      setInfo(infoResult);
      setSysProxy(proxy);
    } catch (error) {
      console.error("[clash] refresh failed", error);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleCore = useCallback(async () => {
    console.error("[clash] 当前状态", runningMode,runningMode === "NotRunning");
    setLoading(true);
    try {
      if (runningMode === "NotRunning") {
        await invoke("clash_start_core");
      } else {
        // 停止内核前先关闭系统代理，避免留下指向已关闭端口的无效代理
        if (sysProxy?.enable) {
          try {
            await invoke("clash_reset_sysproxy");
          } catch (error) {
            console.error("[clash] reset sysproxy before stop failed", error);
          }
        }
        await invoke("clash_stop_core");
      }
      await refresh();
    } catch (error) {
      console.error("[clash] toggle core failed", error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [runningMode, sysProxy, refresh]);

  const restartCore = useCallback(async () => {
    setLoading(true);
    try {
      await invoke("clash_restart_core");
      await refresh();
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const toggleSysProxy = useCallback(
    async (enable?: boolean) => {
      if (!sysProxy) return;
      const nextEnable = enable ?? !sysProxy.enable;
      const mixedPort = info?.mixedPort ?? null;
      // 开启系统代理时强制使用内核实际监听端口与地址，避免残留注册表值指向错误端口
      const next: SysproxyConfig = {
        ...sysProxy,
        enable: nextEnable,
        host: nextEnable && mixedPort ? "127.0.0.1" : sysProxy.host,
        port: nextEnable && mixedPort ? mixedPort : sysProxy.port,
      };
      try {
        await invoke("clash_set_sysproxy", { config: next });
        setSysProxy(next);
      } catch (error) {
        console.error("[clash] toggle sysproxy failed", error);
        throw error;
      }
    },
    [sysProxy, info],
  );

  return {
    loading,
    info,
    runningMode,
    sysProxy,
    toggleCore,
    restartCore,
    toggleSysProxy,
    refresh,
  };
}