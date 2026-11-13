import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { TitleBar } from "./components/common/TitleBar";
import { ToastHost } from "./components/common/ToastHost";
import { TooltipLayer } from "./components/common/TooltipLayer";
import { ActivityBar } from "./components/common/ActivityBar";
import { StatusBar } from "./components/common/StatusBar";
import { ExplorerPanel } from "./components/explorer/ExplorerPanel";
import { EditorArea } from "./components/editor/EditorArea";
import { useGlobalSave } from "./components/editor/MonacoHost";
import { SaveConflictModal, UnsavedCloseModal } from "./components/editor/Dialogs";
import type { SettingsSection } from "./components/common/SettingsModal";

const SearchPanel = lazy(() =>
  import("./components/search/SearchPanel").then((m) => ({ default: m.SearchPanel })),
);
const GitPanel = lazy(() =>
  import("./components/git/GitPanel").then((m) => ({ default: m.GitPanel })),
);
const RemotePanel = lazy(() =>
  import("./components/remote/RemotePanel").then((m) => ({ default: m.RemotePanel })),
);
const DiscoveryPanel = lazy(() =>
  import("./components/discovery/DiscoveryPanel").then((m) => ({ default: m.DiscoveryPanel })),
);
const TerminalPanel = lazy(() =>
  import("./components/terminal/TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);
const SettingsModal = lazy(() =>
  import("./components/common/SettingsModal").then((m) => ({ default: m.SettingsModal })),
);
import { tabsStore } from "./stores/tabs";
import { explorerStore } from "./stores/explorer";
import { gitStore } from "./stores/git";
import {
  clampBottomPanelHeight,
  clampSidebarWidth,
  DEFAULT_SETTINGS,
  settingsStore,
} from "./stores/settings";
import { updaterStore } from "./stores/updater";
import { workspaceApi } from "./services/workspace";
import { appApi } from "./services/files";
import { sshApi } from "./services/ssh";
import { CmdError, type ConnectionProfileDto } from "./types/ssh";
import { isPrimaryWindow } from "./lib/windowState";
import {
  AppOverlays,
  type SshLostState,
  type SshReconnectFailState,
} from "./components/common/AppOverlays";
import { useCloseGuard, useWorkspacePersistence } from "./hooks/useWorkspacePersistence";

export function App() {
  const [activePanel, setActivePanel] = useState<string>("explorer");
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [terminalCount, setTerminalCount] = useState(0);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [pendingWindowClose, setPendingWindowClose] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  const [resizing, setResizing] = useState<"sidebar" | "bottom" | null>(null);
  const [sshReconnectFail, setSshReconnectFail] = useState<SshReconnectFailState | null>(null);
  /** 运行中的 SSH 会话意外掉线（设备关机 / 网络中断） */
  const [sshLost, setSshLost] = useState<SshLostState | null>(null);

  const sidebarWidth = settingsStore((s) => s.sidebarWidth);
  const bottomPanelHeight = settingsStore((s) => s.bottomPanelHeight);
  const [pendingUpdatePath, setPendingUpdatePath] = useState<string | null>(null);

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

  // SSH 会话意外掉线 / 跨窗口重连同步：
  // - 所有受影响窗口都清理自身远程目录缓存、SSH 终端与远端 LSP
  // - 仅 promptWindowLabel 匹配的窗口弹出掉线确认模态框，避免多开窗口（或本地窗口）重复弹窗
  useEffect(() => {
    const myLabel = getCurrentWindow().label;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const bind = (fn: () => void) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };

    void listen<{
      sessionId: string;
      profileId: string;
      deviceIdentityId: string;
      deviceName: string | null;
      endpoint: string;
      promptWindowLabel?: string | null;
    }>("ssh:session-lost", (event) => {
      const payload = event.payload;
      // 仅清掉该断线设备的远程目录缓存，避免影响另一台设备窗口
      explorerStore.getState().invalidateRemote(payload.deviceIdentityId);
      // 通知终端面板回收该会话的 SSH 终端标签、远程 LSP 复位
      window.dispatchEvent(
        new CustomEvent("glance:session-disconnected", {
          detail: { deviceIdentityId: payload.deviceIdentityId },
        }),
      );
      if (payload.promptWindowLabel === myLabel) {
        setSshLost(payload);
      }
    }).then(bind);

    void listen<{
      sessionId: string;
      profileId: string;
      deviceIdentityId: string;
      initiatorWindowLabel: string;
    }>("ssh:session-connected", (event) => {
      const payload = event.payload;
      setSshLost((cur) => (cur?.deviceIdentityId === payload.deviceIdentityId ? null : cur));
      if (payload.initiatorWindowLabel !== myLabel) {
        const root = explorerStore.getState().rootPath;
        if (root && root.startsWith(`remote://${payload.deviceIdentityId}`)) {
          void explorerStore.getState().refresh(root, { silent: true });
        }
        window.dispatchEvent(
          new CustomEvent("glance:session-connected", {
            detail: { deviceIdentityId: payload.deviceIdentityId, sessionId: payload.sessionId },
          }),
        );
      }
    }).then(bind);

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // 初始化设置，并在「自动检测更新」明确开启时后台检测 GitHub 版本更新（默认关闭时不主动检查或推送）
  useEffect(() => {
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let unlistenMenuSettings: (() => void) | null = null;

    void settingsStore
      .getState()
      .hydrate()
      .then((resolved) => {
        if (!disposed && resolved.autoCheckUpdate && isPrimaryWindow()) {
          checkTimer = setTimeout(() => {
            void updaterStore.getState().checkForUpdates({ manual: false });
          }, 2500);
        }
      });

    void getCurrentWebviewWindow()
      .listen("menu:settings", () => {
        setSettingsSection("appearance");
        setSettingsOpen(true);
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlistenMenuSettings = fn;
        }
      });

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsSection("appearance");
        setSettingsOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === "g") {
          e.preventDefault();
          setActivePanel("git");
        } else if (k === "e") {
          e.preventDefault();
          setActivePanel("explorer");
        } else if (k === "f") {
          e.preventDefault();
          setActivePanel("search");
        } else if (k === "r") {
          e.preventDefault();
          setActivePanel("remote");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      disposed = true;
      unlistenMenuSettings?.();
      window.removeEventListener("keydown", onKeyDown);
      if (checkTimer) clearTimeout(checkTimer);
    };
  }, []);

  const workspaceRootPath = explorerStore((s) => s.rootPath);

  // 向 Rust 侧汇报本窗口当前绑定的远程设备身份，确保掉线弹窗只发往真正相关的窗口
  useEffect(() => {
    const match = workspaceRootPath?.match(/^remote:\/\/([^/]+)/);
    void sshApi.setWindowRemoteDevice(match ? match[1] : null);
  }, [workspaceRootPath]);

  // 后台同步源代码管理状态与资源管理器文件树，保持角标与侧栏及时响应外部/终端修改
  useEffect(() => {
    if (!workspaceRootPath) {
      gitStore.getState().clear();
      return;
    }
    void gitStore.getState().refresh(workspaceRootPath, true);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastExplorerFocusSync = 0;
    const prevDirty = new Map<string, boolean>();
    for (const t of tabsStore.getState().tabs) {
      prevDirty.set(t.uri, t.dirty);
    }

    const scheduleGitRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void gitStore.getState().refresh(workspaceRootPath, true);
      }, 300);
    };

    const unsubTabs = tabsStore.subscribe((s) => {
      let savedTransition = false;
      const next = new Map<string, boolean>();
      for (const t of s.tabs) {
        next.set(t.uri, t.dirty);
        if (prevDirty.get(t.uri) === true && !t.dirty) {
          savedTransition = true;
        }
      }
      prevDirty.clear();
      for (const [k, v] of next) prevDirty.set(k, v);
      if (savedTransition) scheduleGitRefresh();
    });

    const onFocus = () => {
      scheduleGitRefresh();
      const now = Date.now();
      if (now - lastExplorerFocusSync >= 1500) {
        lastExplorerFocusSync = now;
        void explorerStore.getState().refresh(workspaceRootPath, { silent: true });
      }
    };
    window.addEventListener("focus", onFocus);

    return () => {
      unsubTabs();
      window.removeEventListener("focus", onFocus);
      if (timer) clearTimeout(timer);
    };
  }, [workspaceRootPath]);

  // 侧边栏与下边栏拖拽调节
  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = settingsStore.getState().sidebarWidth;
    let latestWidth = startWidth;
    setResizing("sidebar");

    const onMove = (ev: MouseEvent) => {
      const maxW = Math.min(600, Math.max(240, Math.floor(window.innerWidth * 0.55)));
      latestWidth = Math.min(maxW, clampSidebarWidth(startWidth + (ev.clientX - startX)));
      settingsStore.getState().setSidebarWidth(latestWidth, false);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizing(null);
      settingsStore.getState().setSidebarWidth(latestWidth, true);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const startBottomResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = settingsStore.getState().bottomPanelHeight;
    let latestHeight = startHeight;
    setResizing("bottom");

    const onMove = (ev: MouseEvent) => {
      const maxH = Math.max(200, Math.floor(window.innerHeight * 0.75));
      latestHeight = Math.min(maxH, clampBottomPanelHeight(startHeight + (startY - ev.clientY)));
      settingsStore.getState().setBottomPanelHeight(latestHeight, false);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizing(null);
      settingsStore.getState().setBottomPanelHeight(latestHeight, true);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // 持久化活动侧边栏面板（非主窗口不写入，避免覆盖主窗口状态）
  useEffect(() => {
    if (!isPrimaryWindow()) return;
    void workspaceApi.setUiState("workspace.activePanel", activePanel).catch(() => {});
    localStorage.setItem("glance.activePanel", activePanel);
  }, [activePanel]);

  useEffect(() => {
    if (bottomPanelOpen) {
      setTerminalMounted(true);
    }
  }, [bottomPanelOpen]);

  // 监听新窗口自连与直开目录参数（?open_folder=... / ?connect_ssh=... / ?connect_wsl=...）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const openFolder = params.get("open_folder");
    const connectSsh = params.get("connect_ssh");
    const connectWsl = params.get("connect_wsl");
    if (openFolder) {
      void explorerStore.getState().openRoot(openFolder);
      setActivePanel("explorer");
    } else if (connectSsh) {
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

  // 打开设置并定位到指定分区
  useEffect(() => {
    const handler = (e: Event) => {
      const section = (e as CustomEvent<{ section?: SettingsSection }>).detail?.section;
      if (section) setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener("glance:open-settings", handler);
    return () => window.removeEventListener("glance:open-settings", handler);
  }, []);

  // 执行更新重启前统一检查未保存标签页
  useEffect(() => {
    const handler = (e: Event) => {
      const savedPath = (e as CustomEvent<{ savedPath?: string }>).detail?.savedPath;
      if (!savedPath) return;
      if (tabsStore.getState().hasDirty()) {
        setSettingsOpen(false);
        setPendingUpdatePath(savedPath);
      } else {
        void updaterStore.getState().applyUpdate(savedPath);
      }
    };
    window.addEventListener("glance:apply-update", handler);
    return () => window.removeEventListener("glance:apply-update", handler);
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
      setTerminalMounted(true);
      setBottomPanelOpen(true);
      if (terminalMounted && terminalCount > 0) {
        window.dispatchEvent(new CustomEvent("glance:new-terminal"));
      }
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

  /** SSH 意外掉线后点击「重新连接」：按 id 取真实配置，成功后恢复远程工作区 */
  const handleReconnectLostSession = async (lost: {
    profileId: string;
    deviceName: string | null;
    endpoint: string;
  }) => {
    const fallbackProfile: ConnectionProfileDto = {
      id: lost.profileId,
      name: lost.deviceName ?? lost.endpoint,
      host: lost.endpoint.split(":")[0] ?? lost.endpoint,
      port: Number(lost.endpoint.split(":")[1] ?? 22),
      username: "",
      authMethod: "password",
      identityMode: "single",
      keyPath: null,
      identities: [],
    };
    try {
      const profiles = await sshApi.listProfiles();
      const profile = profiles.find((p) => p.id === lost.profileId);
      if (!profile) {
        setSshReconnectFail({
          profile: fallbackProfile,
          reason: "连接配置已被删除，请重新创建连接。",
        });
        return;
      }
      await handleRetrySsh(profile);
    } catch (err) {
      setSshReconnectFail({
        profile: fallbackProfile,
        reason: err instanceof CmdError ? err.message : String(err),
      });
    }
  };

  const showSidebar =
    activePanel === "explorer" ||
    activePanel === "search" ||
    activePanel === "git" ||
    activePanel === "remote" ||
    activePanel === "ssh" ||
    activePanel === "wsl" ||
    activePanel === "discovery";

  return (
    <div className="flex h-full flex-col bg-[var(--glance-bg)] overflow-hidden select-none">
      <TooltipLayer />
      <ToastHost />
      {/* 顶部单行自定义标题导航栏 */}
      <TitleBar
        onToggleTerminal={() => setBottomPanelOpen((v) => !v)}
        onNewTerminal={handleNewTerminal}
        onOpenSettings={() => {
          setSettingsSection("appearance");
          setSettingsOpen(true);
        }}
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
        {showSidebar && (
          <div
            style={{ width: `${sidebarWidth}px` }}
            className="relative flex min-h-0 shrink-0 flex-col border-r border-zinc-800"
          >
            <div className="min-h-0 flex-1 overflow-hidden">
              {activePanel === "explorer" && <ExplorerPanel />}
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center p-4 text-xs text-zinc-500">
                    正在加载面板...
                  </div>
                }
              >
                {activePanel === "search" && <SearchPanel />}
                {activePanel === "git" && <GitPanel />}
                {(activePanel === "remote" || activePanel === "ssh" || activePanel === "wsl") && (
                  <RemotePanel />
                )}
                {activePanel === "discovery" && <DiscoveryPanel />}
              </Suspense>
            </div>
            {/* 侧边栏右边缘拖拽调节手柄 */}
            <div
              role="separator"
              aria-orientation="vertical"
              title="拖拽调节侧边栏宽度（双击恢复默认）"
              onMouseDown={startSidebarResize}
              onDoubleClick={() =>
                settingsStore.getState().setSidebarWidth(DEFAULT_SETTINGS.sidebarWidth, true)
              }
              className={`absolute top-0 bottom-0 right-0 z-20 -mr-0.5 w-1.5 cursor-col-resize transition-colors ${
                resizing === "sidebar" ? "bg-sky-500" : "hover:bg-sky-500/70"
              }`}
            />
          </div>
        )}

        {/* 主编辑工作台与终端区（严格位于侧边栏右侧） */}
        <div className="flex flex-1 flex-col min-w-0">
          <div className={`min-h-0 ${bottomPanelOpen && terminalMaximized ? "hidden" : "flex-1"}`}>
            <EditorArea />
          </div>
          {terminalMounted && (
            <div
              style={terminalMaximized ? undefined : { height: `${bottomPanelHeight}px` }}
              className={`relative shrink-0 border-t border-zinc-800 flex-col ${
                bottomPanelOpen ? "flex" : "hidden"
              } ${terminalMaximized ? "flex-1 h-full" : ""}`}
            >
              {/* 下边栏上边缘拖拽调节手柄 */}
              {!terminalMaximized && (
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  title="拖拽调节下边栏高度（双击恢复默认）"
                  onMouseDown={startBottomResize}
                  onDoubleClick={() =>
                    settingsStore
                      .getState()
                      .setBottomPanelHeight(DEFAULT_SETTINGS.bottomPanelHeight, true)
                  }
                  className={`absolute left-0 right-0 top-0 z-20 -mt-0.5 h-1.5 cursor-row-resize transition-colors ${
                    resizing === "bottom" ? "bg-sky-500" : "hover:bg-sky-500/70"
                  }`}
                />
              )}
              <Suspense fallback={null}>
                <TerminalPanel
                  visible={bottomPanelOpen}
                  onClose={() => setBottomPanelOpen(false)}
                  isMaximized={terminalMaximized}
                  onToggleMaximize={() => setTerminalMaximized((v) => !v)}
                  onTerminalCountChange={setTerminalCount}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>
      <StatusBar onToggleTerminal={() => setBottomPanelOpen((v) => !v)} />

      {/* 拖拽面板时的全局透明手势捕获层，避免 Monaco/xterm 截获鼠标移动事件 */}
      {resizing && (
        <div
          className={`fixed inset-0 z-[9998] ${
            resizing === "sidebar" ? "cursor-col-resize" : "cursor-row-resize"
          }`}
        />
      )}

      {/* 冲突弹窗 */}
      <SaveConflictModal />

      {/* 关闭脏文件确认 */}
      <UnsavedCloseModal />

      {/* 设置界面 */}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            initialSection={settingsSection}
            onClose={() => setSettingsOpen(false)}
          />
        </Suspense>
      )}

      <AppOverlays
        pendingUpdatePath={pendingUpdatePath}
        onClearPendingUpdate={() => setPendingUpdatePath(null)}
        pendingWindowClose={pendingWindowClose}
        onCancelWindowClose={() => setPendingWindowClose(false)}
        onCloseAnyway={() => void closeAnyway()}
        onSaveAllAndClose={() => void saveAllAndClose()}
        sshReconnectFail={sshReconnectFail}
        onClearSshReconnectFail={() => setSshReconnectFail(null)}
        onRetrySsh={(prof) => void handleRetrySsh(prof)}
        sshLost={sshLost}
        onClearSshLost={() => setSshLost(null)}
        onReconnectLostSession={(lost) => void handleReconnectLostSession(lost)}
        onOpenSettings={(section) => {
          setSettingsSection(section);
          setSettingsOpen(true);
        }}
        onSwitchPanel={setActivePanel}
      />
    </div>
  );
}

export default App;
