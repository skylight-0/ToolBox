import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, MutableRefObject } from "react";

type PasswordViewProps = {
  onBack: () => void;
  isDialogOpenRef: MutableRefObject<boolean>;
  requirePasswordAuth: boolean;
};

type PasswordAccount = {
  id: string;
  username: string;
  password: string;
  note: string;
};

type PasswordDomain = {
  id: string;
  domain: string;
  accounts: PasswordAccount[];
};

type PasswordVault = {
  domains: PasswordDomain[];
};

const emptyVault: PasswordVault = { domains: [] };
const narrowLayoutQuery = "(max-width: 520px)";

function createId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isNarrowLayout() {
  return window.matchMedia(narrowLayoutQuery).matches;
}

function PasswordView({ onBack, isDialogOpenRef, requirePasswordAuth }: PasswordViewProps) {
  const [vault, setVault] = useState<PasswordVault>(emptyVault);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [authError, setAuthError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [selectedDomainId, setSelectedDomainId] = useState("");
  const [domainSearch, setDomainSearch] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newNote, setNewNote] = useState("");
  const [visiblePasswordIds, setVisiblePasswordIds] = useState<Record<string, boolean>>({});
  const [isNarrowPasswordLayout, setIsNarrowPasswordLayout] = useState(isNarrowLayout);
  const autoUnlockStartedRef = useRef(false);

  const selectedDomain = vault.domains.find((domain) => domain.id === selectedDomainId);
  const filteredDomains = useMemo(() => {
    const keyword = domainSearch.trim().toLowerCase();
    if (!keyword) return vault.domains;

    return vault.domains.filter(
      (domain) =>
        domain.domain.toLowerCase().includes(keyword) ||
        domain.accounts.some(
          (account) =>
            account.username.toLowerCase().includes(keyword) ||
            account.note.toLowerCase().includes(keyword),
        ),
    );
  }, [domainSearch, vault.domains]);

  const persistVault = (nextVault: PasswordVault) => {
    setVault(nextVault);
    void invoke("save_password_vault", { vault: nextVault })
      .then(() => setSaveError(""))
      .catch((error) => setSaveError(String(error)));
  };

  const loadVault = async () => {
    const loadedVault = await invoke<PasswordVault>("load_password_vault");
    const normalizedVault = loadedVault?.domains ? loadedVault : emptyVault;
    setVault(normalizedVault);
    setSelectedDomainId(isNarrowLayout() ? "" : normalizedVault.domains[0]?.id ?? "");
    setIsUnlocked(true);
  };

  const unlockVault = async () => {
    setIsUnlocking(true);
    setAuthError("");
    setSaveError("");
    isDialogOpenRef.current = requirePasswordAuth;

    try {
      if (requirePasswordAuth) {
        const authenticated = await invoke<boolean>("authenticate_password_vault");
        if (!authenticated) {
          setAuthError("Windows 用户密码验证未通过或已取消");
          return;
        }
      }

      await loadVault();
    } catch (error) {
      setAuthError(String(error));
    } finally {
      isDialogOpenRef.current = false;
      setIsUnlocking(false);
    }
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia(narrowLayoutQuery);
    const updateNarrowLayout = () => {
      const isNarrow = mediaQuery.matches;
      setIsNarrowPasswordLayout(isNarrow);
      if (isNarrow) setSelectedDomainId("");
    };

    updateNarrowLayout();
    mediaQuery.addEventListener("change", updateNarrowLayout);
    return () => mediaQuery.removeEventListener("change", updateNarrowLayout);
  }, []);

  useEffect(() => {
    if (autoUnlockStartedRef.current) return;
    autoUnlockStartedRef.current = true;
    void unlockVault();
  }, [requirePasswordAuth]);

  useEffect(() => {
    if (!isUnlocked || isNarrowPasswordLayout) return;
    if (vault.domains.some((domain) => domain.id === selectedDomainId)) return;
    setSelectedDomainId(vault.domains[0]?.id ?? "");
  }, [isNarrowPasswordLayout, isUnlocked, selectedDomainId, vault.domains]);

  const lockVault = () => {
    setVault(emptyVault);
    setSelectedDomainId("");
    setVisiblePasswordIds({});
    setIsUnlocked(false);
    onBack();
  };

  const addDomain = () => {
    const domainName = newDomain.trim();
    if (!domainName) return;
    if (vault.domains.some((domain) => domain.domain.toLowerCase() === domainName.toLowerCase())) {
      setSaveError("该域名已存在");
      return;
    }

    const domain: PasswordDomain = {
      id: createId(),
      domain: domainName,
      accounts: [],
    };
    persistVault({ domains: [domain, ...vault.domains] });
    setSelectedDomainId(domain.id);
    setNewDomain("");
  };

  const deleteDomain = (domainId: string, event: MouseEvent) => {
    event.stopPropagation();
    persistVault({ domains: vault.domains.filter((domain) => domain.id !== domainId) });
  };

  const openDomain = (domainId: string) => {
    setSelectedDomainId(domainId);
    setVisiblePasswordIds({});
  };

  const showDomainList = () => {
    setSelectedDomainId("");
    setVisiblePasswordIds({});
  };

  const addAccount = () => {
    if (!selectedDomain || !newUsername.trim() || !newPassword.trim()) return;

    const account: PasswordAccount = {
      id: createId(),
      username: newUsername.trim(),
      password: newPassword,
      note: newNote.trim(),
    };
    persistVault({
      domains: vault.domains.map((domain) =>
        domain.id === selectedDomain.id
          ? { ...domain, accounts: [account, ...domain.accounts] }
          : domain,
      ),
    });
    setNewUsername("");
    setNewPassword("");
    setNewNote("");
  };

  const deleteAccount = (domainId: string, accountId: string) => {
    persistVault({
      domains: vault.domains.map((domain) =>
        domain.id === domainId
          ? {
              ...domain,
              accounts: domain.accounts.filter((account) => account.id !== accountId),
            }
          : domain,
      ),
    });
  };

  const copyText = async (text: string) => {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      setSaveError("");
    } catch (error) {
      setSaveError(String(error));
    }
  };

  const copyAccount = (username: string) => copyText(username);

  const copyPassword = (password: string) => copyText(password);

  const copyDomain = (domainName: string, event: MouseEvent) => {
    event.stopPropagation();
    void copyText(domainName);
  };

  if (!isUnlocked) {
    return (
      <div className="sub-view password-auth-view">
        <div className="sub-view-header">
          <div className="back-btn" onClick={onBack}>
            <span className="back-icon">←</span> 返回
          </div>
          <h2 className="sub-view-title">密码管理</h2>
        </div>
        <div className="sub-view-content password-auth-content">
          <div className="password-auth-card">
            <div className="password-auth-icon">🔐</div>
            <div className="password-auth-title">需要 Windows 用户密码</div>
            <div className="password-auth-desc">通过当前 Windows 用户密码验证后才能打开密码库。</div>
            {authError && <div className="password-error">{authError}</div>}
            <button className="password-add-account-btn" onClick={unlockVault} disabled={isUnlocking}>
              {isUnlocking ? "验证中..." : "验证并打开"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`sub-view password-split-view ${
        isNarrowPasswordLayout && selectedDomain ? "password-detail-only" : "password-domain-list-only"
      }`}
    >
      <div className="password-sidebar">
        <div className="password-sidebar-header">
          <div className="back-btn" onClick={lockVault}>
            <span className="back-icon">←</span> 返回
          </div>
          <h2 className="sub-view-title">密码管理</h2>
        </div>

        <div className="password-search-wrap">
          <input
            className="password-search-input"
            placeholder="搜索域名或账号..."
            value={domainSearch}
            onChange={(event) => setDomainSearch(event.target.value)}
          />
        </div>

        <div className="password-domain-add">
          <input
            className="password-domain-input"
            placeholder="添加域名..."
            value={newDomain}
            onChange={(event) => setNewDomain(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && addDomain()}
          />
          <button className="password-icon-btn" onClick={addDomain} title="添加域名">
            +
          </button>
        </div>

        <div className="password-domain-list">
          {filteredDomains.length === 0 && <div className="password-empty small">暂无域名</div>}
          {filteredDomains.map((domain) => (
            <div
              key={domain.id}
              className={`password-domain-item ${selectedDomainId === domain.id ? "active" : ""}`}
              onClick={() => openDomain(domain.id)}
            >
              <div className="password-domain-text">
                <span className="password-domain-name">{domain.domain}</span>
                <span className="password-domain-count">{domain.accounts.length} 个账号</span>
              </div>
              <div className="password-domain-actions">
                <button
                  className="password-domain-copy"
                  onClick={(event) => copyDomain(domain.domain, event)}
                  title="复制域名"
                >
                  复制
                </button>
                <button
                  className="password-domain-delete"
                  onClick={(event) => deleteDomain(domain.id, event)}
                  title="删除域名"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="password-main">
        <div className="password-main-header">
          {isNarrowPasswordLayout && selectedDomain && (
            <div className="password-detail-topbar">
              <div className="back-btn password-domain-back-btn" onClick={showDomainList}>
                <span className="back-icon">←</span> 选择域名
              </div>
              <button className="password-lock-btn" onClick={lockVault}>
                锁定
              </button>
            </div>
          )}
          <div>
            <h2 className="sub-view-title">{selectedDomain?.domain ?? "选择一个域名"}</h2>
            <div className="password-header-meta">
              {selectedDomain
                ? `${selectedDomain.accounts.length} 个账号`
                : "先添加域名，再添加账号"}
            </div>
          </div>
          {(!isNarrowPasswordLayout || !selectedDomain) && (
            <div className="password-header-actions">
              <button className="password-lock-btn" onClick={lockVault}>
                锁定
              </button>
            </div>
          )}
        </div>

        <div className="sub-view-content password-content">
          {saveError && <div className="password-error">{saveError}</div>}

          {selectedDomain ? (
            <>
              <div className="password-account-form">
                <input
                  className="password-form-input"
                  placeholder="账号 / 用户名"
                  value={newUsername}
                  onChange={(event) => setNewUsername(event.target.value)}
                />
                <input
                  className="password-form-input"
                  type="password"
                  placeholder="密码"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
                <input
                  className="password-form-input note"
                  placeholder="备注（可选）"
                  value={newNote}
                  onChange={(event) => setNewNote(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && addAccount()}
                />
                <button className="password-add-account-btn" onClick={addAccount}>
                  添加账号
                </button>
              </div>

              <div className="password-account-list">
                {selectedDomain.accounts.length === 0 && (
                  <div className="password-empty">这个域名下还没有账号</div>
                )}
                {selectedDomain.accounts.map((account) => {
                  const isVisible = !!visiblePasswordIds[account.id];
                  return (
                    <div className="password-account-item" key={account.id}>
                      <div className="password-account-top">
                        <button
                          className="password-account-user"
                          onClick={() => void copyAccount(account.username)}
                          title="复制账号"
                        >
                          {account.username}
                        </button>
                        <div className="password-account-actions">
                          <button
                            className="password-small-btn"
                            onClick={() => void copyAccount(account.username)}
                          >
                            复制账号
                          </button>
                          <button
                            className="password-small-btn"
                            onClick={() =>
                              setVisiblePasswordIds((current) => ({
                                ...current,
                                [account.id]: !current[account.id],
                              }))
                            }
                          >
                            {isVisible ? "隐藏" : "显示"}
                          </button>
                          <button
                            className="password-small-btn"
                            onClick={() => void copyPassword(account.password)}
                          >
                            复制
                          </button>
                          <button
                            className="password-delete-account"
                            onClick={() => deleteAccount(selectedDomain.id, account.id)}
                            title="删除账号"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                      <div className="password-value">
                        {isVisible
                          ? account.password
                          : "•".repeat(Math.min(Math.max(account.password.length, 8), 24))}
                      </div>
                      <div className="password-note">{account.note || "无备注"}</div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="password-empty">左侧添加或选择一个域名</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default PasswordView;
