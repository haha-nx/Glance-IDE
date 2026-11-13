import { useCallback, useEffect, useRef, useState, Fragment } from "react";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { sshApi } from "../../services/ssh";
import { wslApi } from "../../services/wsl";
import {
  base64ToBytes,
  terminalApi,
  type TerminalEvent,
} from "../../services/terminal";
import { tabsStore } from "../../stores/tabs";
import { explorerStore } from "../../stores/explorer";
import { settingsStore } from "../../stores/settings";
import { parseProblems, resolveProblemPath, type Problem } from "../../lib/problems";
import { isPrimaryWindow } from "../../lib/windowState";
import { IS_MAC } from "../../lib/platform";
import type { SessionDto } from "../../types/ssh";
import type { WslDistroDto } from "../../types/wsl";
import { IconClose } from "../common/icons";
import { PanelTab, ProblemsView, TasksView } from "./TerminalSubViews";
import {
  terminalThemeFor,
  type TermDragState,
  type TerminalPanelProps,
  type TermPane,
  type TermTabItem,
} from "./terminalTypes";

export function TerminalPanel({
  visible = true,
  onClose,
  isMaximized,
  onToggleMaximize,
  onTerminalCountChange,
}: TerminalPanelProps) {
  const [tab, setTab] = useState<"terminal" | "tasks" | "problems">("terminal");
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [wslDistros, setWslDistros] = useState<WslDistroDto[]>([]);
  const [, setTerms] = useState<TermTabItem[]>([]);

  // 多窗格分屏模型：每个窗格拥有独立的标签栏
  const [panes, setPanes] = useState<TermPane[]>([
    { id: "pane-0", tabIds: [], activeId: null },
  ]);
  const [activePaneId, setActivePaneId] = useState<string>("pane-0");

  // 终端标签拖拽分屏状态
  const [dragState, setDragState] = useState<TermDragState | null>(null);

  const [running, setRunning] = useState(false);
  const [taskOutput, setTaskOutput] = useState("");
  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemContext, setProblemContext] = useState<{ device: string | null; cwd: string } | null>(null);
  const [lastExit, setLastExit] = useState<{ code: number; ms: number } | null>(null);
  const [command, setCommand] = useState("cargo build");

  const outputRef = useRef<HTMLDivElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const termsMapRef = useRef<Map<string, TermTabItem>>(new Map());
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const openingAutoRef = useRef(false);
  const initialSshWaitDoneRef = useRef(false);
  const dragStateRef = useRef<TermDragState | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const onTerminalCountChangeRef = useRef(onTerminalCountChange);
  onTerminalCountChangeRef.current = onTerminalCountChange;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const fontSize = settingsStore((s) => s.fontSize);
  const theme = settingsStore((s) => s.theme);

  // 终端执行命令后静默刷新资源管理器（本地 / WSL / 远端 SSH 统一适用）
  const scheduleExplorerSync = useCallback((delayMs: number) => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      const root = explorerStore.getState().rootPath;
      if (root) {
        void explorerStore.getState().refresh(root, { silent: true });
      }
    }, delayMs);
  }, []);

  // 刷新会话与 WSL 发行版（macOS 不提供 WSL）
  useEffect(() => {
    sshApi.listSessions().then(setSessions).catch(() => setSessions([]));
    if (!IS_MAC) {
      wslApi.listDistros().then(setWslDistros).catch(() => setWslDistros([]));
    }

    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dragCleanupRef.current?.();
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      for (const item of termsMapRef.current.values()) {
        void terminalApi.close(item.channelId).catch(() => {});
        item.term.dispose();
        item.container.remove();
      }
      termsMapRef.current.clear();
      onTerminalCountChangeRef.current?.(0);
    };
  }, []);

  // 挂载终端实例
  const attachTerminal = useCallback(
    async (
      title: string,
      type: "local" | "wsl" | "ssh",
      openFn: (onEvent: (e: TerminalEvent) => void) => Promise<{ channelId: string }>,
      targetPaneId?: string,
      deviceIdentityId?: string,
    ) => {
      const { Terminal } = await import("@xterm/xterm");
      if (!mountedRef.current) return;

      const { fontSize: curFontSize, theme: curTheme } = settingsStore.getState();
      const term = new Terminal({
        fontFamily: '"SF Mono", Menlo, Consolas, monospace',
        fontSize: curFontSize,
        theme: terminalThemeFor(curTheme),
        cursorBlink: true,
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);

      const div = document.createElement("div");
      div.className = "absolute inset-0 p-1";
      term.open(div);

      const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      let pendingSyncUntil = 0;
      let info: { channelId: string };
      try {
        info = await openFn((e) => {
          if (e.type === "data" || e.type === "stdout" || e.type === "stderr") {
            term.write(base64ToBytes(e.bytes));
            if (Date.now() < pendingSyncUntil) {
              scheduleExplorerSync(450);
            }
          } else if (e.type === "closed") {
            term.writeln("\r\n[终端进程已结束]");
            pendingSyncUntil = 0;
            scheduleExplorerSync(300);
          }
        });
      } catch (err) {
        term.dispose();
        div.remove();
        console.warn("打开终端失败", err);
        return;
      }

      if (!mountedRef.current) {
        void terminalApi.close(info.channelId).catch(() => {});
        term.dispose();
        div.remove();
        return;
      }

      const item: TermTabItem = {
        id,
        title,
        type,
        channelId: info.channelId,
        deviceIdentityId,
        hasInput: false,
        term,
        fit,
        container: div,
      };

      term.onData((data) => {
        item.hasInput = true;
        void terminalApi.write(info.channelId, data);
        // 仅在提交命令（回车/换行）后计划刷新，避免普通按键期间频繁请求远端 SFTP
        if (data.includes("\r") || data.includes("\n")) {
          pendingSyncUntil = Date.now() + 5000;
          scheduleExplorerSync(700);
        }
      });

      termsMapRef.current.set(id, item);
      setTerms([...termsMapRef.current.values()]);
      onTerminalCountChangeRef.current?.(termsMapRef.current.size);

      // 将新建的终端添加到指定窗格（或当前活动窗格）
      setPanes((prev) => {
        const destPaneId = targetPaneId && prev.some((p) => p.id === targetPaneId)
          ? targetPaneId
          : prev[0]?.id || "pane-0";

        let found = false;
        const next = prev.map((p) => {
          if (p.id === destPaneId) {
            found = true;
            return {
              ...p,
              tabIds: [...p.tabIds, id],
              activeId: id,
            };
          }
          return p;
        });

        if (!found) {
          next.push({ id: destPaneId, tabIds: [id], activeId: id });
        }
        return next;
      });

      if (targetPaneId) setActivePaneId(targetPaneId);

      requestAnimationFrame(() => {
        if (!mountedRef.current || !termsMapRef.current.has(id)) return;
        try {
          fit.fit();
        } catch {}
        term.focus();
        void terminalApi.resize(info.channelId, term.cols, term.rows);
      });
    },
    [scheduleExplorerSync],
  );

  // 打开本机终端
  const openLocalTerminal = useCallback(
    (targetPaneId?: string) => {
      return attachTerminal("本机终端", "local", async (onEvent) => {
        return terminalApi.openLocal(null, onEvent);
      }, targetPaneId);
    },
    [attachTerminal],
  );

  // 打开 WSL 终端
  const openWslTerminal = useCallback(
    (distro: string, targetPaneId?: string) => {
      return attachTerminal(`WSL: ${distro}`, "wsl", async (onEvent) => {
        return terminalApi.openWsl(distro, null, onEvent);
      }, targetPaneId);
    },
    [attachTerminal],
  );

  // 打开 SSH 终端
  const openSshTerminal = useCallback(
    (session: SessionDto, targetPaneId?: string) => {
      return attachTerminal(session.deviceName || `SSH: ${session.endpoint}`, "ssh", async (onEvent) => {
        return terminalApi.open(session.sessionId, 80, 24, onEvent);
      }, targetPaneId, session.deviceIdentityId);
    },
    [attachTerminal],
  );

  // 新建当前窗口对应设备的终端（当前是本机就新建本机的，ssh就新建ssh的，wsl新建wsl的）
  const createTerminalForCurrentDevice = useCallback(
    async (targetPaneId?: string) => {
      // 非主窗口不读取共享 localStorage 的历史工作区，避免继承主窗口的 SSH/WSL 环境
      const root =
        explorerStore.getState().rootPath ||
        (isPrimaryWindow() ? localStorage.getItem("glance.recentRoot") : null);

      // 1. 如果当前工作区是 SSH 远程工作区（remote://...）
      if (root?.startsWith("remote://")) {
        const match = root.match(/^remote:\/\/([^/]+)/);
        const devId = match ? match[1] : null;
        let liveSessions = await sshApi.listSessions().catch(() => []);
        if (liveSessions.length === 0) {
          await new Promise((r) => setTimeout(r, 250));
          liveSessions = await sshApi.listSessions().catch(() => []);
        }
        if (liveSessions.length > 0) {
          setSessions(liveSessions);
          const session =
            liveSessions.find((s) => s.deviceIdentityId === devId || s.profileId === devId) ||
            liveSessions[0];
          if (session) {
            await openSshTerminal(session, targetPaneId);
            return;
          }
        }
      }

      // 2. 如果工作区是 WSL 子系统（wsl://...）；macOS 无 WSL
      if (!IS_MAC && root?.startsWith("wsl://")) {
        const match = root.match(/^wsl:\/\/([^/]+)/);
        const distro = match ? match[1] : (wslDistros[0]?.name || null);
        if (distro) {
          await openWslTerminal(distro, targetPaneId);
          return;
        }
      }

      // 3. 检查当前是否有活跃的 SSH 会话（例如在远程面板连接后未打开文件夹）
      //    非主窗口例外：SSH 会话是进程级共享的，新开项目/空白窗口不该被别处会话带偏。
      if (isPrimaryWindow()) {
        let liveSessions: SessionDto[] = [];
        try {
          liveSessions = await sshApi.listSessions();
          if (liveSessions.length > 0) setSessions(liveSessions);
        } catch {}

        if (liveSessions.length > 0 && (!root || root.startsWith("remote://"))) {
          await openSshTerminal(liveSessions[0], targetPaneId);
          return;
        }
      }

      // 4. 否则打开本机系统终端
      await openLocalTerminal(targetPaneId);
    },
    [wslDistros, openSshTerminal, openWslTerminal, openLocalTerminal],
  );

  // 面板可见且当前无终端时，自动打开对应环境终端；重新展开已有终端的面板时仅刷新尺寸并聚焦。
  const createDeviceTerminalRef = useRef(createTerminalForCurrentDevice);
  createDeviceTerminalRef.current = createTerminalForCurrentDevice;

  useEffect(() => {
    if (!visible || tab !== "terminal") return;

    if (termsMapRef.current.size > 0) {
      requestAnimationFrame(() => {
        for (const p of panes) {
          if (!p.activeId) continue;
          const item = termsMapRef.current.get(p.activeId);
          if (!item) continue;
          try {
            item.fit.fit();
            void terminalApi.resize(item.channelId, item.term.cols, item.term.rows);
          } catch {}
          if (p.id === activePaneId) {
            item.term.focus();
          }
        }
      });
      return;
    }

    if (openingAutoRef.current) return;

    const recentRoot = isPrimaryWindow() ? localStorage.getItem("glance.recentRoot") : null;
    const lastProfile = isPrimaryWindow() ? localStorage.getItem("glance.lastSshProfileId") : null;
    if (!initialSshWaitDoneRef.current && (recentRoot?.startsWith("remote://") || lastProfile)) {
      // 首次启动且上次处于 SSH 工作区时，短暂等待 SSH 恢复完成后再兜底创建
      const timer = setTimeout(() => {
        initialSshWaitDoneRef.current = true;
        if (!mountedRef.current || termsMapRef.current.size > 0 || openingAutoRef.current) return;
        openingAutoRef.current = true;
        void createDeviceTerminalRef.current().finally(() => {
          openingAutoRef.current = false;
        });
      }, 2500);
      return () => clearTimeout(timer);
    }

    initialSshWaitDoneRef.current = true;
    openingAutoRef.current = true;
    void createDeviceTerminalRef.current().finally(() => {
      openingAutoRef.current = false;
    });
  }, [tab, visible]);

  // 监听 SSH 连接与断开事件，动态同步最新会话池
  useEffect(() => {
    const handleConnected = async () => {
      try {
        const list = await sshApi.listSessions();
        setSessions(list);
        if (termsMapRef.current.size === 0) {
          if (visibleRef.current && !openingAutoRef.current) {
            openingAutoRef.current = true;
            void createTerminalForCurrentDevice().finally(() => {
              openingAutoRef.current = false;
            });
          }
        } else if (termsMapRef.current.size === 1) {
          const firstTerm = [...termsMapRef.current.values()][0];
          if (firstTerm && firstTerm.type === "local" && !firstTerm.hasInput) {
            // 将启动初期未交互的临时本机终端平滑替换为 SSH 远程终端
            void terminalApi.close(firstTerm.channelId).catch(() => {});
            firstTerm.term.dispose();
            firstTerm.container.remove();
            termsMapRef.current.delete(firstTerm.id);
            setPanes([{ id: "pane-0", tabIds: [], activeId: null }]);
            setTerms([]);
            onTerminalCountChangeRef.current?.(0);
            openingAutoRef.current = true;
            void createTerminalForCurrentDevice("pane-0").finally(() => {
              openingAutoRef.current = false;
            });
          }
        }
      } catch {}
    };

    const handleDisconnected = async (e: Event) => {
      const lostDeviceId = (e as CustomEvent<{ deviceIdentityId?: string }>).detail
        ?.deviceIdentityId;
      try {
        const list = await sshApi.listSessions();
        setSessions(list);

        // 会话已消失：回收对应的 SSH 终端标签（其 PTY 通道也会随传输断开而结束）
        const aliveDeviceIds = new Set(list.map((s) => s.deviceIdentityId));
        const staleIds = [...termsMapRef.current.values()]
          .filter((t) => {
            if (t.type !== "ssh") return false;
            // 已知掉线设备：精确匹配；否则退化为「设备已无活跃会话」
            if (lostDeviceId) return t.deviceIdentityId === lostDeviceId;
            return !t.deviceIdentityId || !aliveDeviceIds.has(t.deviceIdentityId);
          })
          .map((t) => t.id);

        for (const id of staleIds) {
          const item = termsMapRef.current.get(id);
          if (!item) continue;
          void terminalApi.close(item.channelId).catch(() => {});
          item.term.dispose();
          item.container.remove();
          termsMapRef.current.delete(id);
        }
        if (staleIds.length > 0) {
          setTerms([...termsMapRef.current.values()]);
          onTerminalCountChangeRef.current?.(termsMapRef.current.size);
          setPanes((prev) => {
            const next = prev.map((p) => {
              const tabIds = p.tabIds.filter((tid) => !staleIds.includes(tid));
              return {
                ...p,
                tabIds,
                activeId:
                  p.activeId && tabIds.includes(p.activeId)
                    ? p.activeId
                    : (tabIds[tabIds.length - 1] ?? null),
              };
            });
            return next.length > 1 ? next.filter((p) => p.tabIds.length > 0) : next;
          });
        }
      } catch {}
    };

    window.addEventListener("glance:session-connected", handleConnected);
    window.addEventListener("glance:session-disconnected", handleDisconnected);
    return () => {
      window.removeEventListener("glance:session-connected", handleConnected);
      window.removeEventListener("glance:session-disconnected", handleDisconnected);
    };
  }, [createTerminalForCurrentDevice]);

  // 响应标题栏或快捷指令派发的直接「新建终端」事件
  useEffect(() => {
    const handleNew = () => {
      setTab("terminal");
      void createTerminalForCurrentDevice(activePaneId);
    };
    window.addEventListener("glance:new-terminal", handleNew);
    return () => window.removeEventListener("glance:new-terminal", handleNew);
  }, [activePaneId, createTerminalForCurrentDevice]);

  // 窗格分屏：在指定窗格左侧或右侧创建新窗格，并放入指定终端（或新建终端）
  const splitPaneAt = (
    targetPaneId: string,
    moveTermId?: string,
    side: "left" | "right" = "right",
  ) => {
    const newPaneId = `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

    if (moveTermId) {
      // 从原窗格移除并移入新窗格（先移除空窗格再定位目标索引，避免源窗格消失引起错位）
      let didSplit = false;
      setPanes((prev) => {
        const targetPane = prev.find((p) => p.id === targetPaneId);
        if (!targetPane) return prev;
        if (targetPane.tabIds.includes(moveTermId) && targetPane.tabIds.length <= 1) {
          return prev;
        }

        const filtered = prev
          .map((p) => {
            if (p.tabIds.includes(moveTermId)) {
              const nextTabs = p.tabIds.filter((tid) => tid !== moveTermId);
              return {
                ...p,
                tabIds: nextTabs,
                activeId: p.activeId === moveTermId ? (nextTabs[nextTabs.length - 1] ?? null) : p.activeId,
              };
            }
            return p;
          })
          .filter((p) => p.tabIds.length > 0);

        const targetIdx = filtered.findIndex((p) => p.id === targetPaneId);
        if (targetIdx < 0) return prev;

        const insertIdx = side === "left" ? targetIdx : targetIdx + 1;
        filtered.splice(insertIdx, 0, {
          id: newPaneId,
          tabIds: [moveTermId],
          activeId: moveTermId,
        });
        didSplit = true;
        return filtered;
      });
      if (didSplit) setActivePaneId(newPaneId);
    } else {
      // 为新窗格新建当前环境终端
      setPanes((prev) => {
        const idx = prev.findIndex((p) => p.id === targetPaneId);
        const updated = [...prev];
        const insertIdx = idx >= 0 ? (side === "left" ? idx : idx + 1) : updated.length;
        updated.splice(insertIdx, 0, {
          id: newPaneId,
          tabIds: [],
          activeId: null,
        });
        return updated;
      });
      void createTerminalForCurrentDevice(newPaneId);
      setActivePaneId(newPaneId);
    }
  };

  // 切换指定窗格的活动标签
  const selectTabInPane = (paneId: string, termId: string) => {
    setActivePaneId(paneId);
    setPanes((prev) =>
      prev.map((p) => (p.id === paneId ? { ...p, activeId: termId } : p))
    );
    const t = termsMapRef.current.get(termId);
    if (t) {
      requestAnimationFrame(() => {
        try { t.fit.fit(); } catch {}
        t.term.focus();
        void terminalApi.resize(t.channelId, t.term.cols, t.term.rows);
      });
    }
  };

  // 关闭单个终端：如果只剩最后一个终端，关闭终端同时关闭整个终端底栏！
  function closeTerminal(id: string) {
    const item = termsMapRef.current.get(id);
    if (!item) return;

    void terminalApi.close(item.channelId).catch(() => {});
    item.term.dispose();
    item.container.remove();
    termsMapRef.current.delete(id);

    const remaining = [...termsMapRef.current.values()];
    setTerms(remaining);
    onTerminalCountChangeRef.current?.(remaining.length);

    // 剩最后一个终端时点击关闭，关闭终端并关闭整个终端下边栏
    if (remaining.length === 0) {
      setPanes([{ id: "pane-0", tabIds: [], activeId: null }]);
      onClose();
      return;
    }

    setPanes((prev) => {
      let nextPanes = prev.map((p) => {
        if (p.tabIds.includes(id)) {
          const nextTabs = p.tabIds.filter((tid) => tid !== id);
          return {
            ...p,
            tabIds: nextTabs,
            activeId: p.activeId === id ? (nextTabs[nextTabs.length - 1] ?? null) : p.activeId,
          };
        }
        return p;
      });

      // 移除多余的空窗格（至少保留一个）
      if (nextPanes.length > 1) {
        nextPanes = nextPanes.filter((p) => p.tabIds.length > 0);
      }
      return nextPanes;
    });
  }

  // 尺寸自适应（最大化、分屏窗格增减、面板重新显示、窗口尺寸变动）
  useEffect(() => {
    if (!visible || tab !== "terminal") return;
    const container = gridContainerRef.current;
    if (!container) return;

    const fitAll = () => {
      if (!visibleRef.current) return;
      for (const p of panes) {
        if (p.activeId) {
          const item = termsMapRef.current.get(p.activeId);
          if (item) {
            try {
              item.fit.fit();
              void terminalApi.resize(item.channelId, item.term.cols, item.term.rows);
            } catch {}
          }
        }
      }
    };

    const ro = new ResizeObserver(() => {
      requestAnimationFrame(fitAll);
    });
    ro.observe(container);

    const t1 = setTimeout(fitAll, 50);
    const t2 = setTimeout(fitAll, 150);

    return () => {
      ro.disconnect();
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [panes, isMaximized, tab, visible]);

  // 实时同步全部终端字体大小与配色主题
  useEffect(() => {
    const xtermTheme = terminalThemeFor(theme);
    for (const item of termsMapRef.current.values()) {
      item.term.options.fontSize = fontSize;
      item.term.options.theme = xtermTheme;
    }
    if (!visible || tab !== "terminal") return;
    requestAnimationFrame(() => {
      for (const p of panes) {
        if (p.activeId) {
          const item = termsMapRef.current.get(p.activeId);
          if (item) {
            try {
              item.fit.fit();
              void terminalApi.resize(item.channelId, item.term.cols, item.term.rows);
            } catch {}
          }
        }
      }
    });
  }, [fontSize, theme]);

  // 计算拖放目标
  function computeDropTarget(x: number, y: number): TermDragState["target"] {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;

    const bar = el.closest<HTMLElement>("[data-term-tabbar-pane]");
    if (bar) {
      const paneId = bar.dataset.termTabbarPane!;
      const tabEls = Array.from(bar.querySelectorAll<HTMLElement>("[data-term-tab-id]"));
      let index = tabEls.length;
      for (let i = 0; i < tabEls.length; i++) {
        const r = tabEls[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) {
          index = i;
          break;
        }
      }
      return { paneId, zone: "tabbar", index };
    }

    const body = el.closest<HTMLElement>("[data-term-body-pane]");
    if (body) {
      const paneId = body.dataset.termBodyPane!;
      const r = body.getBoundingClientRect();
      const fx = (x - r.left) / r.width;
      if (fx < 0.35) return { paneId, zone: "left" };
      if (fx > 0.65) return { paneId, zone: "right" };
      return { paneId, zone: "center" };
    }
    return null;
  }

  // 标签按下拖拽监听
  const onTabPointerDown = (
    e: React.PointerEvent,
    termId: string,
    fromPaneId: string,
    title: string,
  ) => {
    if (e.button !== 0) return;
    selectTabInPane(fromPaneId, termId);

    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      const nextDrag: TermDragState = {
        termId,
        fromPaneId,
        title,
        x: ev.clientX,
        y: ev.clientY,
        target: computeDropTarget(ev.clientX, ev.clientY),
      };
      dragStateRef.current = nextDrag;
      setDragState(nextDrag);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      dragCleanupRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const finish = () => {
      cleanup();
      const cur = dragStateRef.current;
      dragStateRef.current = null;
      setDragState(null);
      if (!dragging || !cur?.target) return;

      const { paneId, zone, index } = cur.target;
      if (zone === "tabbar" || zone === "center") {
        // 移动到目标窗格的标签栏
        setPanes((prev) => {
          const updated = prev.map((p) => {
            if (p.id === cur.fromPaneId) {
              const nextTabs = p.tabIds.filter((t) => t !== cur.termId);
              return {
                ...p,
                tabIds: nextTabs,
                activeId: p.activeId === cur.termId ? (nextTabs[nextTabs.length - 1] ?? null) : p.activeId,
              };
            }
            return p;
          });

          return updated
            .map((p) => {
              if (p.id === paneId) {
                const list = p.tabIds.filter((t) => t !== cur.termId);
                const ins = index !== undefined ? Math.min(index, list.length) : list.length;
                list.splice(ins, 0, cur.termId);
                return {
                  ...p,
                  tabIds: list,
                  activeId: cur.termId,
                };
              }
              return p;
            })
            .filter((p) => p.tabIds.length > 0 || p.id === paneId);
        });
        setActivePaneId(paneId);
      } else if (zone === "left" || zone === "right") {
        // 边缘放置：按拖放侧向进行分屏
        splitPaneAt(paneId, cur.termId, zone);
      }
    };

    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  // 运行构建任务
  async function runTask() {
    if (!sessions.length || running) return;
    const root = explorerStore.getState().rootPath;
    const remoteMatch = root?.match(/^remote:\/\/([^/]+)/);
    const devId = remoteMatch?.[1];
    const session =
      (devId
        ? sessions.find((s) => s.deviceIdentityId === devId || s.profileId === devId)
        : undefined) ?? sessions[0];
    setRunning(true);
    setTab("tasks");
    setTaskOutput("");
    setLastExit(null);

    let cwd = "";
    try {
      const root = explorerStore.getState().rootPath;
      const prefix = `remote://${session.deviceIdentityId}`;
      if (root?.startsWith(prefix)) {
        cwd = root.slice(prefix.length);
      } else {
        cwd = await terminalApi.remoteHome(session.sessionId);
      }
    } catch {
      cwd = "";
    }

    const chunks: string[] = [];
    try {
      const result = await terminalApi.runTask(session.sessionId, cwd, command, command, (e) => {
        if (e.type === "stdout" || e.type === "stderr" || e.type === "data") {
          const text = new TextDecoder().decode(base64ToBytes(e.bytes));
          chunks.push(text);
          setTaskOutput((prev) => prev + text);
        } else if (e.type === "exit") {
          setLastExit({ code: e.code, ms: 0 });
        }
      });
      setLastExit({ code: result.exitCode, ms: result.durationMs });
      const full = chunks.join("");
      const parsed = parseProblems(full);
      setProblems(parsed);
      setProblemContext({ device: session.deviceIdentityId, cwd });
      if (parsed.length > 0) setTab("problems");
    } catch (err) {
      setTaskOutput((prev) => prev + `\r\n[任务失败] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
      outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
    }
  }

  function openProblem(p: Problem) {
    if (!problemContext) return;
    const abs = resolveProblemPath(p, problemContext.cwd);
    const path = problemContext.device ? `remote://${problemContext.device}${abs}` : abs;
    void tabsStore.getState().openFileAtLine(path, p.line);
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950 select-none">
      {/* 顶部主选项卡与面板控制栏 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-800 px-2 text-xs">
        <PanelTab active={tab === "terminal"} onClick={() => setTab("terminal")}>
          终端
        </PanelTab>
        <PanelTab active={tab === "tasks"} onClick={() => setTab("tasks")}>
          任务
        </PanelTab>
        <PanelTab active={tab === "problems"} onClick={() => setTab("problems")}>
          问题{problems.length > 0 && ` (${problems.length})`}
        </PanelTab>

        <div className="flex-1" />

        {lastExit && (
          <span className={`mr-2 text-xs ${lastExit.code === 0 ? "text-emerald-500" : "text-red-400"}`}>
            退出码 {lastExit.code}
          </span>
        )}

        {/* 顶部功能按钮群：左右分屏、最大化/还原、关闭面板 */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => splitPaneAt(activePaneId)}
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
              panes.length > 1 ? "bg-sky-950/80 text-sky-400" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
            title="拆分终端窗格（支持拖拽标签至边缘分屏）"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="12" y1="3" x2="12" y2="21" />
            </svg>
          </button>

          {onToggleMaximize && (
            <button
              onClick={onToggleMaximize}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              title={isMaximized ? "还原终端面板" : "最大化终端面板"}
            >
              {isMaximized ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
          )}

          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            title="关闭终端面板"
          >
            <IconClose size={13} />
          </button>
        </div>
      </div>

      {/* 终端视图：多窗格分屏，每个窗格拥有类似浏览器的独立标签栏与 [+] 按钮 */}
      {tab === "terminal" && (
        <div ref={gridContainerRef} className="flex min-h-0 flex-1 w-full h-full overflow-hidden">
          {panes.map((pane, pIdx) => {
            const paneTabs = pane.tabIds
              .map((id) => termsMapRef.current.get(id))
              .filter((t): t is TermTabItem => !!t);

            const activeItem = pane.activeId ? termsMapRef.current.get(pane.activeId) : null;
            const isDropTarget = dragState?.target?.paneId === pane.id;

            return (
              <Fragment key={pane.id}>
                {pIdx > 0 && <div className="w-px bg-zinc-800 shrink-0" />}

                <div
                  className={`relative flex min-w-0 flex-1 flex-col h-full overflow-hidden ${
                    activePaneId === pane.id ? "ring-1 ring-inset ring-sky-500/20" : ""
                  }`}
                  onMouseDown={() => setActivePaneId(pane.id)}
                >
                  {/* 窗格独立标签栏（浏览器样式：标签后紧随 [+] 按钮） */}
                  <div
                    data-term-tabbar-pane={pane.id}
                    className={`flex h-7 shrink-0 items-center gap-1 border-b border-zinc-800/80 bg-zinc-900/70 px-2 overflow-x-auto text-[11px] ${
                      isDropTarget && dragState?.target?.zone === "tabbar" ? "bg-sky-500/15" : ""
                    }`}
                  >
                    {paneTabs.map((t) => {
                      const isActive = pane.activeId === t.id;
                      return (
                        <div
                          key={t.id}
                          data-term-tab-id={t.id}
                          onPointerDown={(e) => onTabPointerDown(e, t.id, pane.id, t.title)}
                          className={`group flex items-center gap-1.5 rounded px-2.5 py-1 cursor-pointer transition-colors shrink-0 ${
                            isActive
                              ? "bg-zinc-800 text-sky-300 font-medium shadow-sm"
                              : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                          }`}
                        >
                          <span className="truncate max-w-[140px]">{t.title}</span>
                          <button
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              closeTerminal(t.id);
                            }}
                            className={`rounded p-0.5 hover:bg-zinc-800 hover:text-red-400 ${
                              isActive ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-80"
                            }`}
                            title="关闭终端"
                          >
                            <IconClose size={10} />
                          </button>
                        </div>
                      );
                    })}

                    {/* 类似浏览器的新建终端 [+] 按钮：紧邻标签右侧 */}
                    <button
                      onClick={() => void createTerminalForCurrentDevice(pane.id)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
                      title="新建终端 (+)"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </button>
                  </div>

                  {/* 窗格终端画布区 */}
                  <div
                    data-term-body-pane={pane.id}
                    className="relative min-h-0 flex-1 w-full h-full overflow-hidden bg-[var(--glance-bg-terminal)]"
                  >
                    {paneTabs.length === 0 ? (
                      <div className="flex h-full w-full items-center justify-center p-4 text-xs text-zinc-600">
                        暂无打开的终端，点击 [+] 创建
                      </div>
                    ) : (
                      <div
                        ref={(el) => {
                          if (el && activeItem) {
                            if (activeItem.container.parentElement !== el) {
                              el.appendChild(activeItem.container);
                            }
                            for (const child of Array.from(el.children)) {
                              (child as HTMLElement).style.display =
                                child === activeItem.container ? "block" : "none";
                            }
                            requestAnimationFrame(() => {
                              try { activeItem.fit.fit(); } catch {}
                            });
                          }
                        }}
                        className="absolute inset-0"
                      />
                    )}

                    {/* 拖拽落点预览遮罩 */}
                    {isDropTarget && dragState && dragState.target?.zone !== "tabbar" && (
                      <div
                        className={`pointer-events-none absolute z-50 border border-sky-500/50 bg-sky-500/20 transition-all ${
                          dragState.target?.zone === "left"
                            ? "inset-y-0 left-0 w-1/2"
                            : dragState.target?.zone === "right"
                              ? "inset-y-0 right-0 w-1/2"
                              : "inset-0"
                        }`}
                      />
                    )}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
      )}

      {/* 拖拽中的终端标签幽灵 */}
      {dragState && (
        <div
          className="pointer-events-none fixed z-[200] rounded border border-sky-500/60 bg-zinc-900/95 px-2.5 py-1 text-xs text-zinc-200 shadow-xl"
          style={{ left: dragState.x + 12, top: dragState.y + 10 }}
        >
          {dragState.title}
        </div>
      )}

      {/* 任务视图 */}
      {tab === "tasks" && (
        <TasksView
          command={command}
          onCommandChange={setCommand}
          onRunTask={() => void runTask()}
          running={running}
          hasSessions={sessions.length > 0}
          taskOutput={taskOutput}
          outputRef={outputRef}
        />
      )}

      {/* 问题视图 */}
      {tab === "problems" && (
        <ProblemsView problems={problems} onOpenProblem={openProblem} />
      )}
    </div>
  );
}
