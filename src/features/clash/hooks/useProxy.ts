import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DelayResult, ProxyGroupInfo } from "../types/clash";

type UseProxyResult = {
  groups: ProxyGroupInfo[];
  loading: boolean;
  delays: Record<string, number | null>;
  testing: Record<string, boolean>;
  groupTesting: Record<string, boolean>;
  refresh: () => Promise<void>;
  selectProxy: (group: string, proxy: string) => Promise<void>;
  testDelay: (proxy: string, url?: string) => Promise<void>;
  testGroupDelay: (groupName: string, url?: string) => Promise<void>;
};

const DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204";

export function useProxy(): UseProxyResult {
  const [groups, setGroups] = useState<ProxyGroupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [delays, setDelays] = useState<Record<string, number | null>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [groupTesting, setGroupTesting] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<ProxyGroupInfo[]>("clash_get_proxy_groups");
      setGroups(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectProxy = useCallback(
    async (group: string, proxy: string) => {
      await invoke("clash_select_proxy", { group, proxy });
      await refresh();
    },
    [refresh],
  );

  const testDelay = useCallback(
    async (proxy: string, url: string = DEFAULT_TEST_URL) => {
      setTesting((prev) => ({ ...prev, [proxy]: true }));
      try {
        // 使用 mihomo API 的 /proxies/:name/delay（经由该节点探测目标 URL）
        const result = await invoke<DelayResult>("clash_test_proxy_delay", {
          proxy,
          testUrl: url,
          timeoutMs: 5000,
        });
        // 仅当后端确实返回节点延迟时才更新；错误时显示为不可达
        if (result.delay != null) {
          setDelays((prev) => ({ ...prev, [proxy]: result.delay }));
        } else {
          setDelays((prev) => ({ ...prev, [proxy]: null }));
          if (result.error) {
            console.warn(`[clash] delay(${proxy}) failed: ${result.error}`);
          }
        }
      } catch (error) {
        setDelays((prev) => ({ ...prev, [proxy]: null }));
        console.error(`[clash] delay(${proxy}) invoke failed`, error);
      } finally {
        setTesting((prev) => ({ ...prev, [proxy]: false }));
      }
    },
    [],
  );

  const testGroupDelay = useCallback(
    async (groupName: string, url: string = DEFAULT_TEST_URL) => {
      const group = groups.find((g) => g.name === groupName);
      if (!group) return;
      setGroupTesting((prev) => ({ ...prev, [groupName]: true }));
      // 立即标记整组为测试中，让 UI 显示 "..."
      setTesting((prev) => {
        const next = { ...prev };
        group.proxies.forEach((p) => (next[p] = true));
        return next;
      });
      try {
        const result = await invoke<Record<string, number | null>>(
          "clash_test_group_delay",
          { group: groupName, testUrl: url, timeoutMs: 5000 },
        );
        setDelays((prev) => {
          const next = { ...prev };
          for (const [name, delay] of Object.entries(result)) {
            next[name] = delay ?? null;
          }
          return next;
        });
      } catch (error) {
        console.error(`[clash] group delay(${groupName}) failed`, error);
        setDelays((prev) => {
          const next = { ...prev };
          group.proxies.forEach((p) => (next[p] = null));
          return next;
        });
      } finally {
        setGroupTesting((prev) => ({ ...prev, [groupName]: false }));
        setTesting((prev) => {
          const next = { ...prev };
          group.proxies.forEach((p) => (next[p] = false));
          return next;
        });
      }
    },
    [groups],
  );

  return {
    groups,
    loading,
    delays,
    testing,
    groupTesting,
    refresh,
    selectProxy,
    testDelay,
    testGroupDelay,
  };
}