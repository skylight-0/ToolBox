import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PrfItem } from "../types/clash";

type UseProfileResult = {
  profiles: PrfItem[];
  loading: boolean;
  importing: boolean;
  refresh: () => Promise<void>;
  importRemote: (url: string, name?: string) => Promise<void>;
  selectProfile: (uid: string) => Promise<void>;
  updateProfile: (uid: string) => Promise<void>;
  deleteProfile: (uid: string) => Promise<void>;
};

export function useProfile(): UseProfileResult {
  const [profiles, setProfiles] = useState<PrfItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<PrfItem[]>("clash_get_profiles");
      setProfiles(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const importRemote = useCallback(
    async (url: string, name?: string) => {
      setImporting(true);
      try {
        await invoke("clash_import_profile", { url, name: name ?? null });
        await refresh();
      } finally {
        setImporting(false);
      }
    },
    [refresh],
  );

  const selectProfile = useCallback(
    async (uid: string) => {
      await invoke("clash_select_profile", { uid });
      await refresh();
    },
    [refresh],
  );

  const updateProfile = useCallback(
    async (uid: string) => {
      await invoke("clash_update_profile", { uid });
      await refresh();
    },
    [refresh],
  );

  const deleteProfile = useCallback(
    async (uid: string) => {
      await invoke("clash_delete_profile", { uid });
      await refresh();
    },
    [refresh],
  );

  return {
    profiles,
    loading,
    importing,
    refresh,
    importRemote,
    selectProfile,
    updateProfile,
    deleteProfile,
  };
}