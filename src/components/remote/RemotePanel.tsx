import { useCallback, useEffect, useState } from "react";
import { sshApi } from "../../services/ssh";
import { wslApi } from "../../services/wsl";
import { appApi } from "../../services/files";
import { workspaceApi } from "../../services/workspace";
import { explorerStore } from "../../stores/explorer";
import { takePendingProfileConnect, takePendingPrefill } from "../../lib/windowState";
import { IS_MAC } from "../../lib/platform";
import {
  CmdError,
  type ConnectOutcome,
  type ConnectionProfileDto,
  type ProfileInput,
} from "../../types/ssh";
import type { WslDistroDto } from "../../types/wsl";
import { PrimaryButton } from "../common/Modal";
import {
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconWarning,
} from "../common/icons";
import { RegisterIdentityDialog } from "../ssh/ConnectDialogs";
import { ProfileDialog } from "../ssh/ProfileDialog";

type RegisterState = {
  profile: ConnectionProfileDto;
  outcome: Extract<ConnectOutcome, { status: "unknownIdentity" | "identityChanged" }>;
} | null;

export function RemotePanel() {
  const [activeTab, setActiveTab] = useState<"ssh" | "wsl">("ssh");
  const [profiles, setProfiles] = useState<ConnectionProfileDto[]>([]);
  const [wslDistros, setWslDistros] = useState<WslDistroDto[]>([]);
  const [wslAvailable, setWslAvailable] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "create" }
    | { kind: "edit"; profile: ConnectionProfileDto }
    | { kind: "delete"; profile: ConnectionProfileDto }
    | null
  >(null);
  const [register, setRegister] = useState<RegisterState>(null);
  const [busy, setBusy] = useState(false);
  const [prefill, setPrefill] = useState<{ host: string; port: number } | null>(null);

  const refreshSsh = useCallback(async () => {
    try {
      const p = await sshApi.listProfiles();
      setProfiles(p);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof CmdError ? err.message : String(err));
    }
  }, []);

  const refreshWsl = useCallback(async () => {
    try {
      const avail = await wslApi.isAvailable();
      setWslAvailable(avail);
      if (avail) {
        const list = await wslApi.listDistros();
        setWslDistros(list);
      } else {
        setWslDistros([]);
      }
    } catch {
      setWslAvailable(false);
      setWslDistros([]);
    }
  }, []);

  useEffect(() => {
    void refreshSsh();
    // macOS 不提供 WSL 功能，跳过探测
    if (!IS_MAC) void refreshWsl();
  }, [refreshSsh, refreshWsl]);

  // 发现面板预填新建 SSH 连接
  // 发现面板「新建连接 →」预填 host/port：
  // 面板挂载时先消费暂存数据（发现面板派发事件时本组件可能还没挂载），
  // 之后再监听事件用于「面板已打开」的场景。
  useEffect(() => {
    const applyPrefill = (detail: { host: string; port: number } | null) => {
      if (!detail) return;
      setActiveTab("ssh");
      setPrefill(detail);
      setDialog({ kind: "create" });
    };

    applyPrefill(takePendingPrefill());

    // 发现面板命中已保存 IP：挂载后直接发起连接
    const pendingId = takePendingProfileConnect();
    if (pendingId) {
      void (async () => {
        try {
          const list = await sshApi.listProfiles();
          const profile = list.find((p) => p.id === pendingId);
          if (profile) await connectCurrentWindow(profile);
        } catch {
          /* 连接失败信息由 connectCurrentWindow 自身呈现 */
        }
      })();
    }

    const handler = (e: Event) => {
      applyPrefill((e as CustomEvent<{ host: string; port: number }>).detail);
    };
    window.addEventListener("glance:prefill-profile", handler);
    return () => window.removeEventListener("glance:prefill-profile", handler);
  }, []);

  // 当前窗口连接 SSH
  async function connectCurrentWindow(profile: ConnectionProfileDto) {
    setConnectingId(profile.id);
    setConnectError(null);
    try {
      const outcome = await sshApi.connectProfile(profile.id);
      switch (outcome.status) {
        case "connected": {
          await refreshSsh();
          explorerStore.getState().invalidateRemote();
          void workspaceApi.setUiState("workspace.lastSshProfileId", profile.id).catch(() => {});
          localStorage.setItem("glance.lastSshProfileId", profile.id);
          window.dispatchEvent(
            new CustomEvent("glance:session-connected", {
              detail: { deviceIdentityId: outcome.deviceIdentityId, sessionId: outcome.sessionId },
            }),
          );
          const home = await sshApi.remoteHome(outcome.sessionId);
          const cleanHome = home.startsWith("/") ? home : `/${home}`;
          await explorerStore.getState().openRoot(`remote://${outcome.deviceIdentityId}${cleanHome}`);
          window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "explorer" }));
          break;
        }
        case "unknownIdentity":
        case "identityChanged":
          setRegister({ profile, outcome });
          break;
        case "authFailed":
        case "networkError":
          setConnectError(outcome.message);
          break;
      }
    } catch (err) {
      setConnectError(err instanceof CmdError ? err.message : String(err));
    } finally {
      setConnectingId(null);
    }
  }

  // 首次连接身份登记确认
  async function handleRegisterConfirm(displayName: string | null) {
    if (!register) return;
    setBusy(true);
    try {
      await sshApi.approveIdentity(
        register.profile.id,
        register.outcome.keyAlgorithm,
        register.outcome.fingerprint,
        displayName,
      );
      const profile = register.profile;
      setRegister(null);
      await refreshSsh();
      await connectCurrentWindow(profile);
    } catch (err) {
      alert(err instanceof CmdError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // 当前窗口连接 WSL
  async function connectCurrentWsl(distroName: string) {
    try {
      const home = await wslApi.getHome(distroName);
      const cleanHome = home.startsWith("/") ? home : `/${home}`;
      await explorerStore.getState().openRoot(`wsl://${distroName}${cleanHome}`);
      window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "explorer" }));
    } catch (err) {
      alert(`打开 WSL 失败: ${String(err)}`);
    }
  }

  async function submitProfile(input: ProfileInput) {
    setBusy(true);
    try {
      if (dialog?.kind === "edit") {
        await sshApi.updateProfile(dialog.profile.id, input);
      } else {
        await sshApi.createProfile(input);
      }
      setDialog(null);
      await refreshSsh();
    } catch (err) {
      alert(err instanceof CmdError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteProfile(profile: ConnectionProfileDto) {
    setBusy(true);
    try {
      await sshApi.deleteProfile(profile.id);
      setDialog(null);
      await refreshSsh();
    } catch (err) {
      alert(err instanceof CmdError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-zinc-900 select-none">
      {/* 顶部工具栏：左侧下拉切换，右侧新建/刷新按钮 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 px-2.5">
        {IS_MAC ? (
          <span className="px-1 text-xs font-medium text-zinc-200">SSH 远程设备</span>
        ) : (
          <select
            value={activeTab}
            onChange={(e) => setActiveTab(e.target.value as "ssh" | "wsl")}
            className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-200 outline-none hover:border-zinc-600 focus:border-sky-500"
          >
            <option value="ssh">SSH 远程设备</option>
            <option value="wsl">WSL 本地子系统</option>
          </select>
        )}

        <div className="flex items-center gap-1">
          {IS_MAC || activeTab === "ssh" ? (
            <button
              title="新建连接配置"
              onClick={() => setDialog({ kind: "create" })}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <IconPlus size={14} />
            </button>
          ) : (
            <button
              title="刷新 WSL 发行版列表"
              onClick={() => void refreshWsl()}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <IconRefresh size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loadError && (
          <p className="px-1 py-2 text-xs text-red-400">
            <IconWarning size={12} className="mr-1 inline" />
            {loadError}
          </p>
        )}

        {connectError && (
          <div className="mx-1 mb-2 rounded border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-xs text-red-300">
            {connectError}
          </div>
        )}

        {/* SSH 视图 */}
        {activeTab === "ssh" && (
          <>
            {profiles.length === 0 && (
              <div className="px-2 py-6 text-center text-xs text-zinc-500">
                <p>暂无连接配置</p>
                <PrimaryButton className="mt-3 text-xs" onClick={() => setDialog({ kind: "create" })}>
                  新建连接配置
                </PrimaryButton>
              </div>
            )}

            {profiles.map((profile) => {
              const displayName = profile.name || profile.host;
              const isConnecting = connectingId === profile.id;
              return (
                <div
                  key={profile.id}
                  className="mb-2 rounded-md border border-zinc-800 bg-zinc-950/70 p-2.5 transition-colors hover:border-zinc-700"
                >
                  {/* 第一行：名称（未填则显示 IP）、编辑、删除 */}
                  <div className="flex items-center justify-between">
                    <span className="truncate text-sm font-medium text-zinc-200" title={displayName}>
                      {displayName}
                    </span>
                    <div className="flex shrink-0 items-center gap-1 text-zinc-500">
                      <button
                        title="编辑配置"
                        onClick={() => setDialog({ kind: "edit", profile })}
                        className="rounded p-1 hover:bg-zinc-800 hover:text-zinc-300"
                      >
                        <IconEdit size={13} />
                      </button>
                      <button
                        title="删除配置"
                        onClick={() => setDialog({ kind: "delete", profile })}
                        className="rounded p-1 hover:bg-zinc-800 hover:text-red-400"
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>
                  </div>

                  {/* 第二行：用户名+ip、新建窗口连接和当前窗口连接图标按钮 */}
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="truncate select-text font-mono text-[11px] text-zinc-400">
                      {profile.username}@{profile.host}
                      {profile.port !== 22 ? `:${profile.port}` : ""}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        title="在新窗口中连接该设备"
                        onClick={() => void appApi.openNewWindow(profile.id)}
                        className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100 transition-colors"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </button>
                      <button
                        title="在当前窗口连接并打开工作区"
                        onClick={() => void connectCurrentWindow(profile)}
                        disabled={isConnecting}
                        className="flex h-6 w-6 items-center justify-center rounded text-sky-400 hover:bg-sky-500/15 hover:text-sky-300 disabled:opacity-50 transition-colors"
                      >
                        {isConnecting ? (
                          <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
                        ) : (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="5" y1="12" x2="19" y2="12" />
                            <polyline points="12 5 19 12 12 19" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* WSL 视图（仅 Windows） */}
        {!IS_MAC && activeTab === "wsl" && (
          <>
            {wslAvailable === false && (
              <div className="p-3 text-xs text-zinc-500">
                <p>当前系统未检测到 WSL 环境。</p>
              </div>
            )}

            {wslAvailable === true && wslDistros.length === 0 && (
              <div className="p-3 text-xs text-zinc-500">
                <p>未发现已安装的 Linux 发行版。</p>
              </div>
            )}

            {wslDistros.map((distro) => {
              const isRunning = distro.state.toLowerCase() === "running";
              return (
                <div
                  key={distro.name}
                  className="mb-2 flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/70 px-2.5 py-2 transition-colors hover:border-zinc-700"
                >
                  {/* 单行：用户名、发行版、新建窗口与当前窗口图标按钮 */}
                  <span className="truncate text-xs text-zinc-300">
                    <span className="font-medium text-zinc-200">{distro.user}</span>
                    <span className="text-zinc-500"> · {distro.name}</span>
                    {isRunning && (
                      <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" title="运行中" />
                    )}
                  </span>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      title="在新窗口中连接此 WSL 发行版"
                      onClick={() => void appApi.openNewWindow(undefined, distro.name)}
                      className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100 transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </button>
                    <button
                      title="在当前窗口连接并打开工作区"
                      onClick={() => void connectCurrentWsl(distro.name)}
                      className="flex h-6 w-6 items-center justify-center rounded text-sky-400 hover:bg-sky-500/15 hover:text-sky-300 transition-colors"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {(dialog?.kind === "create" || dialog?.kind === "edit") && (
        <ProfileDialog
          existing={dialog.kind === "edit" ? dialog.profile : null}
          prefill={dialog.kind === "create" ? prefill : null}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={submitProfile}
        />
      )}

      {dialog?.kind === "delete" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-80 rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-xl">
            <h3 className="text-sm font-semibold text-zinc-200">删除连接配置</h3>
            <p className="mt-2 text-xs text-zinc-400">
              确定要删除配置 “{dialog.profile.name || dialog.profile.host}” 吗？此操作无法撤销。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDialog(null)}
                className="rounded px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                取消
              </button>
              <button
                onClick={() => void deleteProfile(dialog.profile)}
                disabled={busy}
                className="rounded bg-red-600 px-2.5 py-1 text-xs text-white hover:bg-red-500 disabled:opacity-50"
              >
                {busy ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {register && (
        <RegisterIdentityDialog
          profile={register.profile}
          outcome={register.outcome}
          busy={busy}
          onCancel={() => setRegister(null)}
          onConfirm={handleRegisterConfirm}
        />
      )}
    </div>
  );
}
