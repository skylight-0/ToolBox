import { useState } from "react";
import type { PrfItem } from "../types/clash";

type ProfileViewProps = {
  profiles: PrfItem[];
  loading: boolean;
  importing: boolean;
  onImport: (url: string, name?: string) => Promise<void>;
  onSelect: (uid: string) => Promise<void>;
  onUpdate: (uid: string) => Promise<void>;
  onDelete: (uid: string) => Promise<void>;
};

function formatTime(updated?: number) {
  if (!updated) return "未更新";
  const date = new Date(updated * 1000);
  return date.toLocaleString();
}

function ProfileView({
  profiles,
  loading,
  importing,
  onImport,
  onSelect,
  onUpdate,
  onDelete,
}: ProfileViewProps) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");

  const handleImport = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    try {
      await onImport(trimmed, name.trim() || undefined);
      setUrl("");
      setName("");
    } catch (error) {
      console.error("[clash] import failed", error);
    }
  };

  return (
    <div className="clash-profiles">
      <div className="clash-section-header">
        <span>配置订阅</span>
      </div>
      <div className="clash-import-form">
        <input
          className="clash-input"
          type="url"
          placeholder="订阅链接"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <input
          className="clash-input"
          type="text"
          placeholder="名称（可选）"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="clash-mini-btn primary"
          onClick={handleImport}
          disabled={importing || !url.trim()}
        >
          {importing ? "导入中..." : "导入"}
        </button>
      </div>

      <div className="clash-profile-list">
        {loading && profiles.length === 0 ? (
          <div className="clash-empty">加载中...</div>
        ) : profiles.length === 0 ? (
          <div className="clash-empty">暂无订阅配置。</div>
        ) : (
          profiles.map((profile) => (
            <div key={profile.uid} className={`profile-item ${profile.selected ? "selected" : ""}`}>
              <div className="profile-item-main" onClick={() => onSelect(profile.uid)}>
                <div className="profile-item-name">
                  {profile.selected && <span className="profile-selected-dot" />}
                  {profile.name}
                  <span className="profile-item-type">{profile.type}</span>
                </div>
                <div className="profile-item-meta">{formatTime(profile.updated)}</div>
              </div>
              <div className="profile-item-actions">
                {profile.type === "remote" && (
                  <button className="clash-mini-btn" onClick={() => onUpdate(profile.uid)}>
                    更新
                  </button>
                )}
                <button
                  className="clash-mini-btn danger"
                  onClick={() => onDelete(profile.uid)}
                >
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default ProfileView;