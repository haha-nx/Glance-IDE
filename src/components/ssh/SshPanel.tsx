import { useCallback, useEffect, useState } from "react";
import { sshApi } from "../../services/ssh";
import { explorerStore } from "../../stores/explorer";
import {
  CmdError,
  type ConnectOutcome,
  type ConnectionProfileDto,
  type ProfileInput,
  type SessionDto,
} from "../../types/ssh";
import { Button, Modal, PrimaryButton } from "../common/Modal";
import {
  IconEdit,
  IconPlug,
  IconPlus,
  IconRemote,
  IconTrash,
  IconWarning,
} from "../common/icons";
import { RegisterIdentityDialog } from "./ConnectDialogs";
import { ProfileDialog } from "./ProfileDialog";

type RegisterState = {
  profile: ConnectionProfileDto;
  outcome: Extract<ConnectOutcome, { status: "unknownIdentity" | "identityChanged" }>;
} | null;

function shortFp(fp: string): string {
  return fp.startsWith("SHA256:") ? fp.slice(7, 7 + 16) + "…" : fp.slice(0, 16) + "…";
}

export function SshPanel() {
  const [profiles, setProfiles] = useState<ConnectionProfileDto[]>([]);
  const [sessions, setSessions] = useState<SessionDto[]>([]);
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

  const refresh = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([sshApi.listProfiles(), sshApi.listSessions()]);
      setProfiles(p);
      setSessions(s);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof CmdError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function connect(profile: ConnectionProfileDto) {
    setConnectingId(profile.id);
    setConnectError(null);
    try {
      const outcome = await sshApi.connectProfile(profile.id);
      switch (outcome.status) {
        case "connected":
          await refresh();
          break;
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
      await refresh();
      // 登记完成后立即重试连接（§4.4 第 5→6 步）
      await connect(profile);
    } catch (err) {
      setConnectError(err instanceof CmdError ? err.message : String(err));
      setRegister(null);
    } finally {
      setBusy(false);
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
      await refresh();
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
      await refresh();
    } catch (err) {
      alert(err instanceof CmdError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function unbindIdentity(profileId: string, identityId: string) {
    try {
      await sshApi.unbindIdentity(profileId, identityId);
      await refresh();
    } catch (err) {
      alert(err instanceof CmdError ? err.message : String(err));
    }
  }

  async function disconnect(sessionId: string) {
    try {
      // 通知远程 LSP 桥释放该设备上下文（§6.5）
      const session = sessions.find((s) => s.sessionId === sessionId);
      await sshApi.disconnectSession(sessionId);
      if (session) {
        window.dispatchEvent(
          new CustomEvent("glance:session-disconnected", {
            detail: { deviceIdentityId: session.deviceIdentityId },
          }),
        );
      }
      await refresh();
    } catch (err) {
      alert(err instanceof CmdError ? err.message : String(err));
    }
  }

  /** 会话 → 打开远程工作区（M3）：切到资源管理器并展示远程文件树 */
  // 发现面板「新建连接 →」预填 host/port
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ host: string; port: number }>).detail;
      if (detail) {
        setPrefill(detail);
        setDialog({ kind: "create" });
      }
    };
    window.addEventListener("glance:prefill-profile", handler);
    return () => window.removeEventListener("glance:prefill-profile", handler);
  }, []);

  async function openRemoteWorkspace(session: SessionDto) {
    try {
      const home = await sshApi.remoteHome(session.sessionId);
      await explorerStore.getState().openRoot(`remote://${session.deviceIdentityId}${home}`);
      window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "explorer" }));
    } catch (err) {
      alert(err instanceof CmdError ? err.message : String(err));
    }
  }

  /** 远程语言环境检测（M6 基础，§6.6）：只读探测，不安装任何东西 */
  const [envInfo, setEnvInfo] = useState<string | null>(null);
  const [envBusy, setEnvBusy] = useState(false);
  async function detectEnvironment(session: SessionDto) {
    setEnvBusy(true);
    setEnvInfo(null);
    try {
      const home = await sshApi.remoteHome(session.sessionId);
      const [servers, project] = await Promise.all([
        sshApi.lspDetect(session.sessionId),
        sshApi.projectDetect(session.sessionId, home),
      ]);
      const lines = [
        `工程类型：${project.kind}${project.hasCompileCommands ? " · compile_commands ✓" : " · compile_commands ✗（clangd 需要）"}`,
        ...project.details.slice(0, 3).map((d) => `· ${d}`),
        ...servers.map(
          (s) =>
            `${s.available ? "✓" : "✗"} ${s.server}（${s.language}）${s.version ?? "未安装"}${s.arch ? ` · ${s.arch}` : ""}`,
        ),
      ];
      setEnvInfo(lines.join("\n"));
    } catch (err) {
      setEnvInfo(`检测失败：${err instanceof CmdError ? err.message : String(err)}`);
    } finally {
      setEnvBusy(false);
    }
  }

  const authLabel: Record<string, string> = {
    password: "密码",
    public_key: "私钥",
    agent: "Agent",
  };

  return (
    <div className="flex h-full flex-col bg-zinc-900">
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <span>远程设备</span>
        <button
          title="新建连接配置"
          onClick={() => setDialog({ kind: "create" })}
          className="text-zinc-500 hover:text-zinc-300"
        >
          <IconPlus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {loadError && (
          <p className="px-1 py-2 text-xs text-red-400">
            <IconWarning size={12} className="mr-1 inline" />
            {loadError}
          </p>
        )}

        {connectError && (
          <div className="mx-1 mb-2 rounded border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-xs text-red-300">
            <div className="flex items-start justify-between gap-2">
              <span>{connectError}</span>
              <button onClick={() => setConnectError(null)} className="text-red-400/70 hover:text-red-300">
                ✕
              </button>
            </div>
          </div>
        )}

        {envInfo && (
        <pre className="mx-2 mb-2 max-h-40 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed text-zinc-400 select-text">
          {envInfo}
        </pre>
      )}

      {profiles.length === 0 && !loadError && (
          <div className="flex flex-col items-center gap-2 px-4 pt-8 text-center">
            <IconRemote size={32} className="text-zinc-700" />
            <p className="text-sm text-zinc-500">尚无连接配置</p>
            <p className="text-xs text-zinc-600">
              新建连接配置，首次连接时登记设备指纹，即可在同一 IP 上识别多台轮换设备
            </p>
            <PrimaryButton className="mt-2" onClick={() => setDialog({ kind: "create" })}>
              新建连接配置
            </PrimaryButton>
          </div>
        )}

        {profiles.map((profile) => {
          const activeSessions = sessions.filter((s) => s.profileId === profile.id);
          const isConnecting = connectingId === profile.id;
          return (
            <div key={profile.id} className="mb-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="truncate text-sm font-medium text-zinc-200">{profile.name}</span>
                <div className="flex shrink-0 gap-1 text-zinc-500">
                  <button
                    title="编辑"
                    onClick={() => setDialog({ kind: "edit", profile })}
                    className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-300"
                  >
                    <IconEdit size={13} />
                  </button>
                  <button
                    title="删除"
                    onClick={() => setDialog({ kind: "delete", profile })}
                    className="rounded p-0.5 hover:bg-zinc-800 hover:text-red-400"
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </div>
              <p className="mt-0.5 select-text text-xs text-zinc-500">
                {profile.username}@{profile.host}:{profile.port} · {authLabel[profile.authMethod]}
                {profile.identities.length > 0 && ` · ${profile.identities.length} 台已登记设备`}
              </p>

              {profile.identities.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {profile.identities.map((idn) => (
                    <span
                      key={idn.id}
                      title={idn.fingerprint}
                      className="group inline-flex items-center gap-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-400"
                    >
                      <span className={idn.displayName ? "text-zinc-300" : "font-mono"}>
                        {idn.displayName || shortFp(idn.fingerprint)}
                      </span>
                      <button
                        title="从设备池移除"
                        onClick={() => void unbindIdentity(profile.id, idn.id)}
                        className="text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {activeSessions.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-zinc-800 pt-2">
                  {activeSessions.map((s) => (
                    <div key={s.sessionId} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        <span className="text-zinc-300">{s.deviceName || "未命名设备"}</span>
                        <span className="text-zinc-600">{s.endpoint}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <button
                          onClick={() => void openRemoteWorkspace(s)}
                          className="text-sky-400 hover:text-sky-300"
                          title="在资源管理器中打开该设备的工作区"
                        >
                          打开文件
                        </button>
                        <button
                          onClick={() => void detectEnvironment(s)}
                          disabled={envBusy}
                          className="text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
                          title="检测远程语言服务器与工程环境（只读）"
                        >
                          {envBusy ? "检测中…" : "环境"}
                        </button>
                        <button onClick={() => void disconnect(s.sessionId)} className="text-zinc-500 hover:text-red-400">
                          断开
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-2.5">
                <PrimaryButton
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs"
                  onClick={() => void connect(profile)}
                  disabled={isConnecting}
                >
                  <IconPlug size={13} />
                  {isConnecting ? "连接中…" : activeSessions.length > 0 ? "再次连接" : "连接"}
                </PrimaryButton>
              </div>
            </div>
          );
        })}
      </div>

      {dialog?.kind === "create" && (
        <ProfileDialog
          existing={null}
          prefill={prefill}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={submitProfile}
        />
      )}
      {dialog?.kind === "edit" && (
        <ProfileDialog existing={dialog.profile} busy={busy} onCancel={() => setDialog(null)} onSubmit={submitProfile} />
      )}
      {dialog?.kind === "delete" && (
        <Modal
          title="删除连接配置"
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button onClick={() => setDialog(null)}>取消</Button>
              <PrimaryButton className="bg-red-600/90 hover:bg-red-500" onClick={() => void deleteProfile(dialog.profile)} disabled={busy}>
                删除
              </PrimaryButton>
            </>
          }
        >
          <p>
            确定删除 <span className="text-zinc-100">{dialog.profile.name}</span>
            （{dialog.profile.host}:{dialog.profile.port}）？其保存的凭据将一并从系统钥匙串清除。
            已登记的设备身份记录会保留。
          </p>
        </Modal>
      )}

      {register && (
        <RegisterIdentityDialog
          profile={register.profile}
          outcome={register.outcome}
          busy={busy}
          onCancel={() => setRegister(null)}
          onConfirm={(name) => void handleRegisterConfirm(name)}
        />
      )}
    </div>
  );
}
