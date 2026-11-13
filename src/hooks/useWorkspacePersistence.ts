import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { explorerStore } from "../stores/explorer";
import { tabsStore } from "../stores/tabs";
import { workspaceApi } from "../services/workspace";
import { sshApi } from "../services/ssh";
import { toModelUri } from "../lib/models";
import { isPrimaryWindow } from "../lib/windowState";
import { CmdError, type ConnectionProfileDto } from "../types/ssh";

const ROOT_KEY = "glance.recentRoot";

export interface WorkspacePersistenceProps {
  onSshReconnectFailed: (profile: ConnectionProfileDto, reason: string) => void;
  onPanelRestored: (panel: string) => void;
}

/** 窗口关闭时若有未保存更改，先确认（未保存提示） */
export function useCloseGuard(onBlocked: () => void): void {
  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const promise = win.onCloseRequested((event) => {
      if (tabsStore.getState().hasDirty()) {
        event.preventDefault();
        onBlocked();
      }
    });
    void promise.then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onBlocked]);
}

/** 启动恢复 + 变更持久化（含 SSH 自动重连与失败弹窗） */
export function useWorkspacePersistence({
  onSshReconnectFailed,
  onPanelRestored,
}: WorkspacePersistenceProps) {
  const hasInitializedRef = useRef(false);
  const callbacksRef = useRef({ onSshReconnectFailed, onPanelRestored });
  callbacksRef.current = { onSshReconnectFailed, onPanelRestored };

  // 恢复（如果是新开窗口或者指定了自连参数，跳过常规恢复；生命周期内严格仅执行一次）
  useEffect(() => {
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    if (!isPrimaryWindow()) {
      return;
    }

    void (async () => {
      try {
        let root: string | null = null;
        try {
          root = await workspaceApi.getUiState("workspace.root");
        } catch {
          /* 数据库不可用时退回 localStorage */
        }
        root = root ?? localStorage.getItem(ROOT_KEY);

        let lastProfileId: string | null = null;
        try {
          lastProfileId = await workspaceApi.getUiState("workspace.lastSshProfileId");
        } catch {}
        lastProfileId = lastProfileId ?? localStorage.getItem("glance.lastSshProfileId");

        let lastPanel: string | null = null;
        try {
          lastPanel = await workspaceApi.getUiState("workspace.activePanel");
        } catch {}
        lastPanel = lastPanel ?? localStorage.getItem("glance.activePanel");
        if (lastPanel) {
          callbacksRef.current.onPanelRestored(lastPanel);
        }

        let tabsJson: string | null = null;
        try {
          tabsJson = await workspaceApi.getUiState("workspace.tabs");
        } catch {}

        // 判断是否需要自动重连 SSH
        const isRemoteWorkspace = !!root && root.startsWith("remote://");
        const shouldReconnectSsh =
          isRemoteWorkspace ||
          (!!lastProfileId && (lastPanel === "remote" || lastPanel === "ssh"));

        if (shouldReconnectSsh) {
          let targetProfile: ConnectionProfileDto | undefined;
          try {
            const profiles = await sshApi.listProfiles();
            if (lastProfileId) {
              targetProfile = profiles.find((p) => p.id === lastProfileId);
            }
            if (!targetProfile && isRemoteWorkspace && root) {
              const devMatch = root.match(/^remote:\/\/([^/]+)/);
              const devId = devMatch ? devMatch[1] : null;
              if (devId) {
                targetProfile = profiles.find((p) =>
                  p.identities?.some((i) => i.id === devId),
                );
              }
            }
            if (
              !targetProfile &&
              profiles.length === 1 &&
              (lastPanel === "remote" || isRemoteWorkspace)
            ) {
              targetProfile = profiles[0];
            }

            if (targetProfile) {
              const outcome = await sshApi.connectProfile(targetProfile.id);
              if (outcome.status === "connected") {
                explorerStore.getState().invalidateRemote(outcome.deviceIdentityId);
                window.dispatchEvent(
                  new CustomEvent("glance:session-connected", {
                    detail: { deviceIdentityId: outcome.deviceIdentityId, sessionId: outcome.sessionId },
                  }),
                );

                // 恢复工作区根目录
                let finalRoot = root;
                if (finalRoot && finalRoot.startsWith("remote://")) {
                  const subpath = finalRoot.replace(/^remote:\/\/[^/]+/, "");
                  finalRoot = `remote://${outcome.deviceIdentityId}${subpath}`;
                } else {
                  const home = await sshApi.remoteHome(outcome.sessionId);
                  const cleanHome = home.startsWith("/") ? home : `/${home}`;
                  finalRoot = `remote://${outcome.deviceIdentityId}${cleanHome}`;
                }
                await explorerStore.getState().openRoot(finalRoot);

                // 恢复已打开的远程文件标签
                if (tabsJson) {
                  try {
                    const parsed = JSON.parse(tabsJson) as {
                      paths?: string[];
                      active?: string;
                    };
                    for (const p of parsed.paths ?? []) {
                      let finalP = p;
                      if (p.startsWith("remote://")) {
                        const sub = p.replace(/^remote:\/\/[^/]+/, "");
                        finalP = `remote://${outcome.deviceIdentityId}${sub}`;
                      }
                      await tabsStore.getState().openFileByPath(finalP, { preserveExisting: true });
                    }
                    if (parsed.active) {
                      let finalActive = parsed.active;
                      if (finalActive.startsWith("remote://")) {
                        const sub = finalActive.replace(/^remote:\/\/[^/]+/, "");
                        finalActive = `remote://${outcome.deviceIdentityId}${sub}`;
                      }
                      tabsStore.getState().setActive(toModelUri(finalActive));
                    }
                  } catch {}
                }
                return;
              } else {
                // 重连未成功（如设备指纹不匹配、密码错误、网络不可达等）
                const reason =
                  outcome.status === "networkError" || outcome.status === "authFailed"
                    ? outcome.message
                    : outcome.status === "identityChanged"
                      ? "远程设备指纹与历史记录不一致，连接被安全阻断"
                      : "需核对并登记远程设备身份";
                callbacksRef.current.onSshReconnectFailed(targetProfile, reason);
                return;
              }
            }
          } catch (err) {
            console.error("SSH 自动重连异常:", err);
            if (targetProfile) {
              const reason = err instanceof CmdError ? err.message : String(err);
              callbacksRef.current.onSshReconnectFailed(targetProfile, reason);
              return;
            }
          }
        }

        // 常规本地/WSL 工作区恢复
        if (root && !root.startsWith("remote://")) {
          await explorerStore.getState().openRoot(root);
        }
        if (tabsJson) {
          const parsed = JSON.parse(tabsJson) as { paths?: string[]; active?: string };
          for (const p of parsed.paths ?? []) {
            if (!p.startsWith("remote://")) {
              await tabsStore.getState().openFileByPath(p, { preserveExisting: true });
            }
          }
          if (parsed.active && !parsed.active.startsWith("remote://")) {
            tabsStore.getState().setActive(toModelUri(parsed.active));
          }
        }
      } catch (err) {
        console.warn("工作区恢复失败", err);
      }
    })();
  }, []);

  // 标签持久化（防抖 800ms）
  // 非主窗口不写入，避免覆盖主窗口的工作区状态
  useEffect(() => {
    if (!isPrimaryWindow()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = tabsStore.subscribe((s) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = s.tabs.filter((t) => !t.error && !t.diff).map((t) => t.path);
        const active = s.tabs.find((t) => t.uri === s.activeId && !t.diff);
        const payload = JSON.stringify({ paths, active: active?.path ?? null });
        void workspaceApi.setUiState("workspace.tabs", payload).catch(() => {});
      }, 800);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 根目录持久化（非主窗口不写入）
  useEffect(() => {
    if (!isPrimaryWindow()) return;
    const unsub = explorerStore.subscribe((s) => {
      if (s.rootPath) {
        void workspaceApi.setUiState("workspace.root", s.rootPath).catch(() => {});
      }
    });
    return unsub;
  }, []);
}
