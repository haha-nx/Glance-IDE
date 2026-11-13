import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { TitleBar } from "./components/common/TitleBar";
import { TooltipLayer } from "./components/common/TooltipLayer";
import { ActivityBar } from "./components/common/ActivityBar";
import { StatusBar } from "./components/common/StatusBar";
import { ExplorerPanel } from "./components/explorer/ExplorerPanel";
import { SearchPanel } from "./components/search/SearchPanel";
import { GitPanel } from "./components/git/GitPanel";
import { RemotePanel } from "./components/remote/RemotePanel";
import { DiscoveryPanel } from "./components/discovery/DiscoveryPanel";
import { EditorArea } from "./components/editor/EditorArea";
import { useGlobalSave } from "./components/editor/MonacoHost";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { SaveConflictModal, UnsavedCloseModal } from "./components/editor/Dialogs";
import { SettingsModal, type SettingsSection } from "./components/common/SettingsModal";
import { tabsStore } from "./stores/tabs";
import { explorerStore } from "./stores/explorer";
import { gitStore } from "./stores/git";
import {
  clampBottomPanelHeight,
  clampSidebarWidth,
  DEFAULT_SETTINGS,
  settingsStore,
} from "./stores/settings";
import { requestApplyUpdate, updaterStore } from "./stores/updater";
import { calcPercent, formatBytes, formatSpeed } from "./lib/format";
import { workspaceApi } from "./services/workspace";
import { appApi } from "./services/files";
import { sshApi } from "./services/ssh";
import { CmdError, type ConnectionProfileDto } from "./types/ssh";
import { isBlankWindow } from "./lib/windowState";
import { Button, Modal, PrimaryButton } from "./components/common/Modal";
import { IconWarning } from "./components/common/icons";

/** 窗口关闭时若有未保存更改，先确认（未保存提示） */
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
    if (
      params.get("blank") === "1" ||
      params.get("connect_ssh") ||
      params.get("connect_wsl") ||
      params.get("open_folder")
    ) {
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
  // 空白窗口不写入，避免覆盖主窗口的工作区状态
  useEffect(() => {
    if (isBlankWindow()) return;
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

  // 根目录持久化（空白窗口不写入）
  useEffect(() => {
    if (isBlankWindow()) return;
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  const [resizing, setResizing] = useState<"sidebar" | "bottom" | null>(null);
  const [sshReconnectFail, setSshReconnectFail] = useState<{
    profile: ConnectionProfileDto;
    reason: string;
  } | null>(null);
  /** 运行中的 SSH 会话意外掉线（设备关机 / 网络中断） */
  const [sshLost, setSshLost] = useState<{
    sessionId: string;
    profileId: string;
    deviceIdentityId: string;
    deviceName: string | null;
    endpoint: string;
  } | null>(null);

  const sidebarWidth = settingsStore((s) => s.sidebarWidth);
  const bottomPanelHeight = settingsStore((s) => s.bottomPanelHeight);
  const updatePromptVisible = updaterStore((s) => s.promptVisible);
  const updateResult = updaterStore((s) => s.result);
  const updateDownloading = updaterStore((s) => s.downloading);
  const updateDownloadProgress = updaterStore((s) => s.downloadProgress);
  const updateDownloadResult = updaterStore((s) => s.downloadResult);
  const updateApplying = updaterStore((s) => s.applying);
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
    const params = new URLSearchParams(window.location.search);

    void settingsStore
      .getState()
      .hydrate()
      .then((resolved) => {
        if (resolved.autoCheckUpdate && params.get("blank") !== "1") {
          checkTimer = setTimeout(() => {
            void updaterStore.getState().checkForUpdates({ manual: false });
          }, 2500);
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

  // 持久化活动侧边栏面板（空白窗口不写入，避免覆盖主窗口状态）
  useEffect(() => {
    if (isBlankWindow()) return;
    void workspaceApi.setUiState("workspace.activePanel", activePanel).catch(() => {});
    localStorage.setItem("glance.activePanel", activePanel);
  }, [activePanel]);

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
              {activePanel === "search" && <SearchPanel />}
              {activePanel === "git" && <GitPanel />}
              {(activePanel === "remote" || activePanel === "ssh" || activePanel === "wsl") && (
                <RemotePanel />
              )}
              {activePanel === "discovery" && <DiscoveryPanel />}
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
          {bottomPanelOpen && (
            <div
              style={terminalMaximized ? undefined : { height: `${bottomPanelHeight}px` }}
              className={`relative shrink-0 border-t border-zinc-800 flex flex-col ${
                terminalMaximized ? "flex-1 h-full" : ""
              }`}
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
        <SettingsModal
          initialSection={settingsSection}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* 仅在「自动检测更新」开启且检测到新版本时展示的右下角更新提示 */}
      {updatePromptVisible && updateResult?.hasUpdate && (
        <div className="fixed bottom-9 right-4 z-40 w-80 rounded-lg border border-sky-500/50 bg-zinc-900 p-3.5 text-xs text-zinc-200 shadow-2xl">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5 font-semibold text-zinc-100">
                <span className="h-2 w-2 rounded-full bg-sky-400" />
                <span>发现新版本 v{updateResult.latestVersion}</span>
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">
                当前版本 v{updateResult.currentVersion}，GitHub 端已发布新版更新。
              </p>
            </div>
            <button
              onClick={() => updaterStore.getState().dismissPrompt()}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              title="关闭"
            >
              ✕
            </button>
          </div>
          {updateDownloading && updateDownloadProgress && (
            <div className="mt-2.5 space-y-1">
              <div className="flex items-center justify-between text-[11px] text-zinc-400">
                <span>正在下载更新…</span>
                <span className="font-mono text-sky-400">
                  {calcPercent(
                    updateDownloadProgress.downloadedBytes,
                    updateDownloadProgress.totalBytes,
                  )}
                  %
                  {updateDownloadProgress.speedBytesPerSec > 0
                    ? ` · ${formatSpeed(updateDownloadProgress.speedBytesPerSec)}`
                    : ""}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-sky-500 transition-all duration-150"
                  style={{
                    width: `${calcPercent(
                      updateDownloadProgress.downloadedBytes,
                      updateDownloadProgress.totalBytes,
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}
          {updateDownloadResult && (
            <p className="mt-2 rounded border border-emerald-700/50 bg-emerald-950/30 px-2 py-1 text-[11px] text-emerald-300">
              {updateDownloadResult.installMode === "manual"
                ? `已下载：${updateDownloadResult.savedPath}`
                : `更新包已就绪 (${formatBytes(updateDownloadResult.size)})，可一键重启完成升级`}
            </p>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              onClick={() => {
                updaterStore.getState().dismissPrompt();
                setSettingsSection("updates");
                setSettingsOpen(true);
              }}
              className="border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
            >
              查看详情
            </Button>
            {updateDownloading ? (
              <Button
                onClick={() => void updaterStore.getState().cancelDownload()}
                className="border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] text-red-300 hover:bg-zinc-700"
              >
                取消下载
              </Button>
            ) : updateDownloadResult ? (
              <PrimaryButton
                disabled={updateApplying}
                onClick={() => requestApplyUpdate(updateDownloadResult.savedPath)}
                className="px-2.5 py-1 text-[11px]"
              >
                {updateApplying
                  ? "正在准备重启…"
                  : updateDownloadResult.installMode === "manual"
                    ? "启动安装"
                    : "立即重启更新"}
              </PrimaryButton>
            ) : (
              updateResult.assetUrl && (
                <PrimaryButton
                  disabled={updateDownloading}
                  onClick={() => void updaterStore.getState().downloadLatestInstaller()}
                  className="px-2.5 py-1 text-[11px]"
                >
                  下载更新
                </PrimaryButton>
              )
            )}
          </div>
        </div>
      )}

      {/* 应用更新重启前未保存文件确认 */}
      {pendingUpdatePath && (
        <Modal
          title="安装更新并重启"
          onClose={() => setPendingUpdatePath(null)}
          footer={
            <>
              <Button onClick={() => setPendingUpdatePath(null)}>取消</Button>
              <Button
                onClick={() => {
                  const p = pendingUpdatePath;
                  setPendingUpdatePath(null);
                  void updaterStore.getState().applyUpdate(p);
                }}
                className="text-red-400 hover:text-red-300"
              >
                丢弃并更新
              </Button>
              <PrimaryButton
                onClick={async () => {
                  const p = pendingUpdatePath;
                  const ok = await tabsStore.getState().saveAll();
                  if (ok) {
                    setPendingUpdatePath(null);
                    void updaterStore.getState().applyUpdate(p);
                  }
                }}
              >
                全部保存并更新
              </PrimaryButton>
            </>
          }
        >
          <p className="text-sm text-zinc-300">
            有未保存的文件，重启以完成版本更新将丢失这些修改。是否先保存全部更改？
          </p>
        </Modal>
      )}

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
      {/* 运行中的 SSH 会话意外掉线（设备关机 / 断网） */}
      {sshLost && (
        <Modal
          title="远程设备连接已断开"
          onClose={() => setSshLost(null)}
          footer={
            <div className="flex w-full items-center justify-between">
              <Button
                onClick={() => {
                  const lost = sshLost;
                  setSshLost(null);
                  void explorerStore.getState().closeRoot();
                  setActivePanel("explorer");
                  window.dispatchEvent(
                    new CustomEvent("glance:session-disconnected", {
                      detail: { deviceIdentityId: lost.deviceIdentityId },
                    }),
                  );
                }}
              >
                断开连接
              </Button>
              <PrimaryButton
                onClick={() => {
                  const lost = sshLost;
                  setSshLost(null);
                  void handleReconnectLostSession(lost);
                }}
              >
                重新连接
              </PrimaryButton>
            </div>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-amber-400">
              <IconWarning size={18} />
              <span className="font-medium text-zinc-100">
                与远程设备的连接已中断
              </span>
            </div>
            <p className="text-xs text-zinc-300">
              连接
              <span className="mx-1 font-mono text-sky-400">
                {sshLost.deviceName || sshLost.endpoint}
                {sshLost.deviceName ? ` (${sshLost.endpoint})` : ""}
              </span>
              已断开，可能是设备关机、休眠或网络中断。远程文件操作与终端将不可用。
            </p>
            <p className="text-[11px] text-zinc-500">
              选择「重新连接」重建会话并恢复远程工作区，或「断开连接」切回本地工作区。
            </p>
          </div>
        </Modal>
      )}

    </div>
  );
}

export default App;
