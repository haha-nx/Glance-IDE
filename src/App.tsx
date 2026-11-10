import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TitleBar } from "./components/common/TitleBar";
import { ActivityBar } from "./components/common/ActivityBar";
import { StatusBar } from "./components/common/StatusBar";
import { ExplorerPanel } from "./components/explorer/ExplorerPanel";
import { SearchPanel } from "./components/search/SearchPanel";
import { RemotePanel } from "./components/remote/RemotePanel";
import { DiscoveryPanel } from "./components/discovery/DiscoveryPanel";
import { EditorArea } from "./components/editor/EditorArea";
import { useGlobalSave } from "./components/editor/MonacoHost";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { SaveConflictModal, UnsavedCloseModal } from "./components/editor/Dialogs";
import { SettingsModal } from "./components/common/SettingsModal";
import { tabsStore } from "./stores/tabs";
import { explorerStore } from "./stores/explorer";
import { workspaceApi } from "./services/workspace";
import { appApi } from "./services/files";
import { sshApi } from "./services/ssh";
import { CmdError, type ConnectionProfileDto } from "./types/ssh";
import { Button, Modal, PrimaryButton } from "./components/common/Modal";
import { IconWarning } from "./components/common/icons";

/** 窗口关闭时若有未保存更改，先确认（路线图 §12.4「未保存提示」） */
function useCloseGuard(onBlocked: () => void): void {
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    const promise = win.onCloseRequested((event) => {
      if (tabsStore.getState().hasDirty()) {
        event.preventDefault();
        onBlocked();
      }
    });
    void promise.then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [onBlocked]);
}

const ROOT_KEY = "glance.recentRoot";

interface WorkspacePersistenceProps {
  onSshReconnectFailed: (profile: ConnectionProfileDto, reason: string) => void;
  onPanelRestored: (panel: string) => void;
}

/** 启动恢复 + 变更持久化（含 SSH 自动重连与失败弹窗） */
function useWorkspacePersistence({
  onSshReconnectFailed,
  onPanelRestored,
}: WorkspacePersistenceProps) {
  const hasInitializedRef = useRef(false);
  const callbacksRef = useRef({ onSshReconnectFailed, onPanelRestored });
  callbacksRef.current = { onSshReconnectFailed, onPanelRestored };

  // 恢复（如果是新建空白窗口或者指定了自连参数，跳过常规恢复；生命周期内严格仅执行一次）
  useEffect(() => {
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    if (params.get("blank") === "1" || params.get("connect_ssh") || params.get("connect_wsl")) {
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
                explorerStore.getState().invalidateRemote();
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
                      await tabsStore.getState().openFileByPath(finalP);
                    }
                    if (parsed.active) {
                      let finalActive = parsed.active;
                      if (finalActive.startsWith("remote://")) {
                        const sub = finalActive.replace(/^remote:\/\/[^/]+/, "");
                        finalActive = `remote://${outcome.deviceIdentityId}${sub}`;
                      }
                      const { toModelUri } = await import("./lib/models");
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
              await tabsStore.getState().openFileByPath(p);
            }
          }
          if (parsed.active && !parsed.active.startsWith("remote://")) {
            const { toModelUri } = await import("./lib/models");
            tabsStore.getState().setActive(toModelUri(parsed.active));
          }
        }
      } catch (err) {
        console.warn("工作区恢复失败", err);
      }
    })();
  }, []);

  // 标签持久化（防抖 800ms）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = tabsStore.subscribe((s) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = s.tabs.filter((t) => !t.error).map((t) => t.path);
        const active = s.tabs.find((t) => t.uri === s.activeId);
        const payload = JSON.stringify({ paths, active: active?.path ?? null });
        void workspaceApi.setUiState("workspace.tabs", payload).catch(() => {});
      }, 800);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 根目录持久化
  useEffect(() => {
    const unsub = explorerStore.subscribe((s) => {
      if (s.rootPath) {
        void workspaceApi.setUiState("workspace.root", s.rootPath).catch(() => {});
      }
    });
    return unsub;
  }, []);
}

export function App() {
  const [activePanel, setActivePanel] = useState<string>("explorer");
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [pendingWindowClose, setPendingWindowClose] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sshReconnectFail, setSshReconnectFail] = useState<{
    profile: ConnectionProfileDto;
    reason: string;
  } | null>(null);

  const handleSshReconnectFailed = useCallback(
    (profile: ConnectionProfileDto, reason: string) => {
      setSshReconnectFail({ profile, reason });
    },
    [],
  );

  const handlePanelRestored = useCallback((panel: string) => {
    setActivePanel(panel);
  }, []);

  useWorkspacePersistence({
    onSshReconnectFailed: handleSshReconnectFailed,
    onPanelRestored: handlePanelRestored,
  });

  useCloseGuard(() => setPendingWindowClose(true));
  useGlobalSave();

  // 持久化活动侧边栏面板
  useEffect(() => {
    void workspaceApi.setUiState("workspace.activePanel", activePanel).catch(() => {});
    localStorage.setItem("glance.activePanel", activePanel);
  }, [activePanel]);

  // 监听新窗口自连参数（?connect_ssh=... 或 ?connect_wsl=...）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connectSsh = params.get("connect_ssh");
    const connectWsl = params.get("connect_wsl");
    if (connectSsh) {
      void (async () => {
        try {
          const outcome = await sshApi.connectProfile(connectSsh);
          if (outcome.status === "connected") {
            const home = await sshApi.remoteHome(outcome.sessionId);
            await explorerStore.getState().openRoot(`remote://${outcome.deviceIdentityId}${home}`);
            setActivePanel("explorer");
          }
        } catch (e) {
          console.error("新窗口 SSH 连接失败:", e);
        }
      })();
    } else if (connectWsl) {
      void (async () => {
        try {
          const { wslApi } = await import("./services/wsl");
          const home = await wslApi.getHome(connectWsl);
          await explorerStore.getState().openRoot(`wsl://${connectWsl}${home}`);
          setActivePanel("explorer");
        } catch (e) {
          console.error("新窗口 WSL 连接失败:", e);
        }
      })();
    }
  }, []);

  // 监听自定义请求关闭事件
  useEffect(() => {
    const handleReqClose = () => {
      if (tabsStore.getState().hasDirty()) {
        setPendingWindowClose(true);
      } else {
        void closeAnyway();
      }
    };
    window.addEventListener("glance:request-close", handleReqClose);
    return () => window.removeEventListener("glance:request-close", handleReqClose);
  }, []);

  // 激活指定侧边栏面板
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) setActivePanel(detail);
    };
    window.addEventListener("glance:activate-panel", handler);
    return () => window.removeEventListener("glance:activate-panel", handler);
  }, []);

  // 关闭当前窗口（多窗口时仅销毁当前窗口，最后一个窗口则彻底退出应用）
  async function closeAnyway() {
    await appApi.closeWindow();
  }

  async function saveAllAndClose() {
    const ok = await tabsStore.getState().saveAll();
    if (ok) await closeAnyway();
  }

  const handleNewTerminal = () => {
    if (!bottomPanelOpen) {
      setBottomPanelOpen(true);
    } else {
      window.dispatchEvent(new CustomEvent("glance:new-terminal"));
    }
  };

  // 重试连接 SSH 流程
  const handleRetrySsh = async (profile: ConnectionProfileDto) => {
    try {
      const outcome = await sshApi.connectProfile(profile.id);
      if (outcome.status === "connected") {
        setSshReconnectFail(null);
        window.dispatchEvent(
          new CustomEvent("glance:session-connected", {
            detail: { deviceIdentityId: outcome.deviceIdentityId, sessionId: outcome.sessionId },
          }),
        );
        const home = await sshApi.remoteHome(outcome.sessionId);
        const cleanHome = home.startsWith("/") ? home : `/${home}`;
        await explorerStore.getState().openRoot(`remote://${outcome.deviceIdentityId}${cleanHome}`);
        setActivePanel("explorer");
      } else {
        const reason =
          outcome.status === "networkError" || outcome.status === "authFailed"
            ? outcome.message
            : outcome.status === "identityChanged"
              ? "远程设备指纹与历史记录不一致"
              : "需首次核验登记设备指纹";
        setSshReconnectFail({ profile, reason });
      }
    } catch (err) {
      const reason = err instanceof CmdError ? err.message : String(err);
      setSshReconnectFail({ profile, reason });
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#18181b] overflow-hidden select-none">
      {/* 顶部单行自定义标题导航栏 */}
      <TitleBar
        onToggleTerminal={() => setBottomPanelOpen((v) => !v)}
        onNewTerminal={handleNewTerminal}
        onOpenSettings={() => setSettingsOpen(true)}
        onRequestClose={() => {
          if (tabsStore.getState().hasDirty()) {
            setPendingWindowClose(true);
          } else {
            void closeAnyway();
          }
        }}
      />

      <div className="flex min-h-0 flex-1">
        <ActivityBar active={activePanel} onActivate={setActivePanel} />
        {activePanel === "explorer" && (
          <div className="w-72 shrink-0 border-r border-zinc-800">
            <ExplorerPanel />
          </div>
        )}
        {activePanel === "search" && (
          <div className="w-72 shrink-0 border-r border-zinc-800">
            <SearchPanel />
          </div>
        )}
        {(activePanel === "remote" || activePanel === "ssh" || activePanel === "wsl") && (
          <div className="w-72 shrink-0 border-r border-zinc-800">
            <RemotePanel />
          </div>
        )}
        {activePanel === "discovery" && (
          <div className="w-72 shrink-0 border-r border-zinc-800">
            <DiscoveryPanel />
          </div>
        )}

        {/* 主编辑工作台与终端区（严格位于侧边栏右侧） */}
        <div className="flex flex-1 flex-col min-w-0">
          <div className={`min-h-0 ${bottomPanelOpen && terminalMaximized ? "hidden" : "flex-1"}`}>
            <EditorArea />
          </div>
          {bottomPanelOpen && (
            <div
              className={`shrink-0 border-t border-zinc-800 flex flex-col ${
                terminalMaximized ? "flex-1 h-full" : "h-64"
              }`}
            >
              <TerminalPanel
                onClose={() => setBottomPanelOpen(false)}
                isMaximized={terminalMaximized}
                onToggleMaximize={() => setTerminalMaximized((v) => !v)}
              />
            </div>
          )}
        </div>
      </div>
      <StatusBar onToggleTerminal={() => setBottomPanelOpen((v) => !v)} />

      {/* 冲突弹窗 */}
      <SaveConflictModal />

      {/* 关闭脏文件确认 */}
      <UnsavedCloseModal />

      {/* 设置弹窗 */}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {/* 退出应用未保存确认 */}
      {pendingWindowClose && (
        <Modal
          title="退出应用"
          onClose={() => setPendingWindowClose(false)}
          footer={
            <>
              <Button onClick={() => setPendingWindowClose(false)}>取消</Button>
              <Button onClick={() => void closeAnyway()} className="text-red-400 hover:text-red-300">
                丢弃并退出
              </Button>
              <PrimaryButton onClick={() => void saveAllAndClose()}>全部保存并退出</PrimaryButton>
            </>
          }
        >
          <p className="text-sm text-zinc-300">有未保存的文件，退出将丢失这些修改。是否保存全部更改？</p>
        </Modal>
      )}

      {/* 远程 SSH 设备自动重连失败弹窗 */}
      {sshReconnectFail && (
        <Modal
          title="无法连接到远程设备"
          onClose={() => setSshReconnectFail(null)}
          footer={
            <div className="flex w-full items-center justify-between">
              <Button
                onClick={() => {
                  setSshReconnectFail(null);
                  setActivePanel("remote");
                }}
              >
                打开远程配置
              </Button>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setSshReconnectFail(null);
                    void explorerStore.getState().closeRoot();
                    setActivePanel("explorer");
                  }}
                >
                  切换到本地
                </Button>
                <PrimaryButton
                  onClick={() => {
                    const prof = sshReconnectFail.profile;
                    void handleRetrySsh(prof);
                  }}
                >
                  重试连接
                </PrimaryButton>
              </div>
            </div>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-amber-400">
              <IconWarning size={18} />
              <span className="font-medium text-zinc-100">
                自动重新连接远程 SSH 设备失败
              </span>
            </div>
            <p className="text-xs text-zinc-300">
              检测到您上次退出前处于远程工作区（
              <span className="font-mono text-sky-400">
                {sshReconnectFail.profile.name || sshReconnectFail.profile.host}:
                {sshReconnectFail.profile.port}
              </span>
              ），本次启动尝试连接失败：
            </p>
            <div className="rounded border border-red-900/60 bg-red-950/40 p-2.5 font-mono text-xs text-red-300 break-all select-text">
              {sshReconnectFail.reason}
            </div>
            <p className="text-[11px] text-zinc-500">
              您可以检查远端服务器网络与 SSH 服务状态后点击“重试连接”，或切换至本地工作区继续开发。
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default App;
