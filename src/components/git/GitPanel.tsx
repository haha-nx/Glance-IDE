import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as pickDialog } from "@tauri-apps/plugin-dialog";
import { appApi } from "../../services/files";
import {
  gitApi,
  type GitFileEntryDto,
  type GitWorktreeDto,
} from "../../services/git";
import { explorerStore } from "../../stores/explorer";
import { gitStore } from "../../stores/git";
import { tabsStore } from "../../stores/tabs";
import { Button, DangerButton, Modal, PrimaryButton } from "../common/Modal";
import {
  IconChevronDown,
  IconChevronRight,
  IconGitBranch,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "../common/icons";
import { CommitGraph } from "./CommitGraph";

const SCM_SPLIT_STORAGE_KEY = "glance:scm-split-ratio";
const DEFAULT_SPLIT_RATIO = 0.52;

function loadSavedSplitRatio(): number {
  try {
    const raw = localStorage.getItem(SCM_SPLIT_STORAGE_KEY);
    if (!raw) return DEFAULT_SPLIT_RATIO;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0.2 && n <= 0.85) return n;
  } catch {
    // 忽略本地存储读取异常
  }
  return DEFAULT_SPLIT_RATIO;
}

function statusColorClass(status: string): string {
  switch (status) {
    case "M":
      return "text-amber-400";
    case "A":
      return "text-emerald-400";
    case "D":
      return "text-red-400";
    case "U":
      return "text-sky-400";
    case "C":
      return "text-red-300";
    default:
      return "text-zinc-400";
  }
}

function splitPathParts(relPath: string): { name: string; dir: string } {
  const norm = relPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx < 0) return { name: norm, dir: "" };
  return { name: norm.slice(idx + 1), dir: norm.slice(0, idx) };
}

function suggestWorktreePath(repoRoot: string, branchName: string): string {
  const norm = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = norm.lastIndexOf("/");
  const parent = slash > 0 ? norm.slice(0, slash) : "";
  const repoName = slash >= 0 ? norm.slice(slash + 1) : norm;
  const safeBranch = (branchName.trim() || "feature")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return parent ? `${parent}/${repoName}-worktrees/${safeBranch || "wt"}` : `${repoName}-${safeBranch || "wt"}`;
}

function IconCheck({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

function IconMore({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.2" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.8" cy="8" r="1.2" />
    </svg>
  );
}

function IconWorktree({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.2" width="4.5" height="4.5" rx="1" />
      <rect x="9.5" y="2.2" width="4.5" height="4.5" rx="1" />
      <rect x="9.5" y="9.3" width="4.5" height="4.5" rx="1" />
      <path d="M4.25 6.7v4.8H9.5M6.5 4.45h3" />
    </svg>
  );
}

/** 源代码管理侧边栏：上下两栏（「更改」+「图形」），支持拖拽调整比例 */
export function GitPanel() {
  const rootPath = explorerStore((s) => s.rootPath);
  const overview = gitStore((s) => s.overview);
  const loading = gitStore((s) => s.loading);
  const storeError = gitStore((s) => s.error);
  const graphAllBranches = gitStore((s) => s.graphAllBranches);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 上下两栏展开与分隔比例
  const [changesPaneOpen, setChangesPaneOpen] = useState(true);
  const [graphPaneOpen, setGraphPaneOpen] = useState(true);
  const [splitRatio, setSplitRatio] = useState<number>(loadSavedSplitRatio);
  const [draggingSplit, setDraggingSplit] = useState(false);

  // 上栏内子区折叠状态
  const [stagedOpen, setStagedOpen] = useState(true);
  const [unstagedOpen, setUnstagedOpen] = useState(true);

  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [commitMsg, setCommitMsg] = useState("");

  // 工作树管理与新建弹窗状态
  const [wtManagerOpen, setWtManagerOpen] = useState(false);
  const [wtModalOpen, setWtModalOpen] = useState(false);
  const [wtCreateBranch, setWtCreateBranch] = useState(true);
  const [wtBranch, setWtBranch] = useState("");
  const [wtBaseRef, setWtBaseRef] = useState("");
  const [wtTargetPath, setWtTargetPath] = useState("");
  const [wtTargetEdited, setWtTargetEdited] = useState(false);
  const [wtOpenAfter, setWtOpenAfter] = useState<"none" | "current" | "newWindow">("current");

  // 确认弹窗状态
  const [confirmRemoveWt, setConfirmRemoveWt] = useState<GitWorktreeDto | null>(null);
  const [forceRemoveWt, setForceRemoveWt] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<GitFileEntryDto | null>(null);
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const commitMenuRef = useRef<HTMLDivElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);

  const activeRepoRoot = overview?.repoRootUri || rootPath;
  const displayError = actionError ?? storeError;
  const totalPendingCount = (overview?.staged.length ?? 0) + (overview?.changes.length ?? 0);

  const refresh = useCallback(
    async (silent = false) => {
      await gitStore.getState().refresh(rootPath, silent);
    },
    [rootPath],
  );

  // 打开源代码管理视图时立即静默刷新一次
  useEffect(() => {
    if (!rootPath) return;
    const hasOverview = gitStore.getState().overview !== null && gitStore.getState().lastRoot === rootPath;
    void refresh(hasOverview);
  }, [rootPath, refresh]);

  // 点击外部收起下拉菜单
  useEffect(() => {
    if (!branchMenuOpen && !moreMenuOpen && !commitMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (branchMenuOpen && !branchMenuRef.current?.contains(target)) {
        setBranchMenuOpen(false);
      }
      if (moreMenuOpen && !moreMenuRef.current?.contains(target)) {
        setMoreMenuOpen(false);
      }
      if (commitMenuOpen && !commitMenuRef.current?.contains(target)) {
        setCommitMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [branchMenuOpen, moreMenuOpen, commitMenuOpen]);

  // 上下两栏（「更改」与「图形」）拖拽调整比例
  const handleStartSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingSplit(true);
    let latestRatio = splitRatio;

    const onMove = (ev: MouseEvent) => {
      const box = splitContainerRef.current?.getBoundingClientRect();
      if (!box || box.height <= 0) return;
      const raw = (ev.clientY - box.top) / box.height;
      latestRatio = Math.max(0.22, Math.min(0.8, raw));
      setSplitRatio(latestRatio);
    };

    const onUp = () => {
      setDraggingSplit(false);
      try {
        localStorage.setItem(SCM_SPLIT_STORAGE_KEY, String(latestRatio));
      } catch {
        // 忽略本地存储写入异常
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [splitRatio]);

  const handleResetSplitRatio = useCallback(() => {
    setSplitRatio(DEFAULT_SPLIT_RATIO);
    try {
      localStorage.setItem(SCM_SPLIT_STORAGE_KEY, String(DEFAULT_SPLIT_RATIO));
    } catch {
      // 忽略本地存储写入异常
    }
  }, []);

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setBusyAction(label);
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      await refresh(true);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  };

  const openFile = (entry: GitFileEntryDto) => {
    void tabsStore.getState().openFileByPath(entry.uri);
  };

  const openDiff = (entry: GitFileEntryDto, mode: "working" | "staged") => {
    if (!activeRepoRoot) return;
    const { name } = splitPathParts(entry.path);
    const label = mode === "staged" ? "已暂存" : "工作区";
    void tabsStore.getState().openGitDiff({
      title: `${name} (${label})`,
      uriKey: `${mode}/${activeRepoRoot}/${entry.path}`,
      request: {
        root: activeRepoRoot,
        mode,
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
      },
    });
  };

  const handleOpenAddWorktree = () => {
    setMoreMenuOpen(false);
    const defaultBranch =
      overview?.branch && !overview.branch.startsWith("HEAD")
        ? overview.branch
        : (overview?.branches[0]?.name ?? "main");
    setWtCreateBranch(true);
    setWtBranch("");
    setWtBaseRef(defaultBranch);
    setWtTargetPath("");
    setWtTargetEdited(false);
    setWtOpenAfter("current");
    setWtModalOpen(true);
  };

  const handleWorktreeBranchChange = (val: string) => {
    setWtBranch(val);
    if (!wtTargetEdited && overview?.repoRoot) {
      setWtTargetPath(suggestWorktreePath(overview.repoRoot, val));
    }
  };

  const handlePickWorktreeDir = async () => {
    const picked = await pickDialog({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) {
      setWtTargetEdited(true);
      setWtTargetPath(picked);
    }
  };

  const handleCreateWorktree = async () => {
    if (!activeRepoRoot) return;
    if (!wtBranch.trim() || !wtTargetPath.trim()) {
      setActionError("请填写工作树分支与目标目录路径");
      return;
    }
    await runAction("创建工作树", async () => {
      const createdUri = await gitApi.worktreeAdd({
        root: activeRepoRoot,
        targetPath: wtTargetPath.trim(),
        branch: wtBranch.trim(),
        createBranch: wtCreateBranch,
        baseRef: wtCreateBranch ? wtBaseRef.trim() : undefined,
      });
      setWtModalOpen(false);
      if (wtOpenAfter === "current") {
        await explorerStore.getState().openRoot(createdUri);
      } else if (wtOpenAfter === "newWindow") {
        await appApi.openNewWindow(undefined, undefined, createdUri);
      }
      setNotice(`已创建工作树: ${wtTargetPath.trim()}`);
    });
  };

  const handleCheckout = async (branch: string, create = false) => {
    if (!activeRepoRoot || !branch.trim()) return;
    setBranchMenuOpen(false);
    await runAction("切换分支", async () => {
      await gitApi.checkout(activeRepoRoot, branch.trim(), create);
      if (create) setNewBranchName("");
      if (rootPath) void explorerStore.getState().refresh(rootPath);
      setNotice(`已切换至分支 ${branch.trim()}`);
    });
  };

  const handleCommit = async (andPush = false) => {
    if (!activeRepoRoot || !overview) return;
    if (!commitMsg.trim()) {
      setActionError("请输入提交说明");
      return;
    }
    const stageAllFirst = overview.staged.length === 0 && overview.changes.length > 0;
    if (overview.staged.length === 0 && overview.changes.length === 0) {
      setActionError("当前没有可提交的更改");
      return;
    }
    setCommitMenuOpen(false);
    await runAction(andPush ? "提交并推送" : "提交更改", async () => {
      if (stageAllFirst) {
        await gitApi.stage(activeRepoRoot, []);
      }
      await gitApi.commit(activeRepoRoot, commitMsg.trim());
      setCommitMsg("");
      if (andPush) {
        await gitApi.push(activeRepoRoot);
        setNotice("已提交并推送到远程仓库");
      } else {
        setNotice("已提交到本地仓库");
      }
    });
  };

  const handleSyncOrPullPush = async () => {
    if (!activeRepoRoot || !overview) return;
    if (overview.behind > 0 && overview.ahead > 0) {
      await runAction("同步更改", async () => {
        await gitApi.pull(activeRepoRoot);
        await gitApi.push(activeRepoRoot);
        if (rootPath) void explorerStore.getState().refresh(rootPath);
        setNotice("拉取并推送同步完成");
      });
    } else if (overview.behind > 0) {
      await runAction("拉取", async () => {
        await gitApi.pull(activeRepoRoot);
        if (rootPath) void explorerStore.getState().refresh(rootPath);
        setNotice("拉取完成");
      });
    } else if (overview.ahead > 0) {
      await runAction("推送", async () => {
        await gitApi.push(activeRepoRoot);
        setNotice("推送完成");
      });
    } else {
      await runAction("获取远程更新", async () => {
        await gitApi.fetch(activeRepoRoot);
        setNotice("已获取远程最新状态");
      });
    }
  };

  const prunableCount = useMemo(
    () => (overview?.worktrees ?? []).filter((w) => w.isPrunable).length,
    [overview?.worktrees],
  );

  const canCommit =
    Boolean(overview?.isRepo && activeRepoRoot && commitMsg.trim()) &&
    totalPendingCount > 0;

  // 未打开任何文件夹
  if (!rootPath) {
    return (
      <div className="flex h-full flex-col bg-zinc-900 select-none">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 px-3">
          <span className="text-xs font-medium tracking-wide text-zinc-400">源代码管理</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <IconGitBranch size={28} className="text-zinc-600" />
          <p className="text-xs text-zinc-500">请先打开一个本地、WSL 或远程文件夹，以使用源代码管理。</p>
          <button
            onClick={async () => {
              const picked = await pickDialog({ directory: true, multiple: false });
              if (typeof picked === "string" && picked) {
                await explorerStore.getState().openRoot(picked);
              }
            }}
            className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 transition-colors"
          >
            打开文件夹
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-zinc-900 select-none overflow-hidden">
      {/* 顶部主标题栏 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 px-3">
        <span className="text-xs font-medium tracking-wide text-zinc-400">源代码管理</span>
        <div className="flex items-center gap-0.5">
          {overview?.isRepo && activeRepoRoot && (
            <button
              onClick={() => void handleCommit(false)}
              disabled={!canCommit || !!busyAction}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-35"
              title="提交更改 (Ctrl+Enter)"
            >
              <IconCheck size={13} />
            </button>
          )}
          <button
            onClick={() => void refresh(false)}
            disabled={loading || !!busyAction}
            className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            title="刷新源代码管理"
          >
            <IconRefresh size={13} className={loading ? "animate-spin" : ""} />
          </button>
          {overview?.isRepo && activeRepoRoot && (
            <div ref={moreMenuRef} className="relative">
              <button
                onClick={() => setMoreMenuOpen((v) => !v)}
                disabled={!!busyAction}
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
                title="更多 Git 操作…"
              >
                <IconMore size={13} />
              </button>

              {moreMenuOpen && (
                <div className="absolute right-0 top-full z-40 mt-1 w-48 rounded-md border border-zinc-700 bg-zinc-950 py-1 text-xs shadow-2xl">
                  <button
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void runAction("获取远程更新", async () => {
                        await gitApi.fetch(activeRepoRoot);
                        setNotice("获取远程更新完成");
                      });
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                  >
                    <span>获取 (Fetch)</span>
                  </button>
                  <button
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void runAction("拉取", async () => {
                        await gitApi.pull(activeRepoRoot);
                        if (rootPath) void explorerStore.getState().refresh(rootPath);
                        setNotice("拉取完成");
                      });
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                  >
                    <span>拉取 (Pull)</span>
                    {overview.behind > 0 && <span className="text-[10px] text-amber-400">↓{overview.behind}</span>}
                  </button>
                  <button
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void runAction("推送", async () => {
                        await gitApi.push(activeRepoRoot);
                        setNotice("推送完成");
                      });
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                  >
                    <span>推送 (Push)</span>
                    {overview.ahead > 0 && <span className="text-[10px] text-emerald-400">↑{overview.ahead}</span>}
                  </button>

                  <div className="my-1 border-t border-zinc-800" />

                  <button
                    disabled={overview.changes.length === 0}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void runAction("暂存全部更改", () => gitApi.stage(activeRepoRoot, []));
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    <span>暂存所有更改</span>
                  </button>
                  <button
                    disabled={overview.staged.length === 0}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void runAction("取消全部暂存", () => gitApi.unstage(activeRepoRoot, []));
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    <span>取消暂存所有更改</span>
                  </button>
                  <button
                    disabled={overview.changes.length === 0}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      setConfirmDiscardAll(true);
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-red-300 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    <span>放弃所有更改…</span>
                  </button>

                  <div className="my-1 border-t border-zinc-800" />

                  <button
                    onClick={() => {
                      setMoreMenuOpen(false);
                      setChangesPaneOpen(true);
                      setBranchMenuOpen(true);
                      setTimeout(() => branchInputRef.current?.focus(), 0);
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                  >
                    <span>切换 / 新建分支…</span>
                  </button>
                  <button
                    onClick={() => {
                      setMoreMenuOpen(false);
                      setWtManagerOpen(true);
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                  >
                    <span>管理工作树 (Worktrees)…</span>
                    <span className="text-[10px] text-zinc-400">{overview.worktrees.length}</span>
                  </button>
                  <button
                    onClick={handleOpenAddWorktree}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                  >
                    <span>新建工作树 (Worktree)…</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 状态提示 / 错误提示 */}
      {displayError && (
        <div className="mx-2 mt-2 flex shrink-0 items-start justify-between gap-2 rounded border border-red-800/60 bg-red-950/30 px-2.5 py-1.5 text-[11px] text-red-300 select-text">
          <span className="break-all">{displayError}</span>
          <button onClick={() => setActionError(null)} className="shrink-0 text-red-400 hover:text-red-200">
            ✕
          </button>
        </div>
      )}
      {notice && !displayError && (
        <div className="mx-2 mt-2 flex shrink-0 items-center justify-between gap-2 rounded border border-emerald-700/50 bg-emerald-950/25 px-2.5 py-1 text-[11px] text-emerald-300">
          <span className="truncate">{notice}</span>
          <button onClick={() => setNotice(null)} className="shrink-0 hover:text-emerald-100">
            ✕
          </button>
        </div>
      )}

      {/* 非 Git 仓库提示 */}
      {overview && !overview.isRepo && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <IconGitBranch size={28} className="text-zinc-600" />
          <p className="text-xs text-zinc-400">{overview.message || "当前文件夹不是 Git 仓库"}</p>
          {overview.gitAvailable && (
            <button
              onClick={() =>
                void runAction("初始化仓库", async () => {
                  await gitApi.init(rootPath);
                  setNotice("已初始化 Git 仓库");
                })
              }
              disabled={!!busyAction}
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {busyAction ? "处理中…" : "初始化 Git 仓库 (git init)"}
            </button>
          )}
        </div>
      )}

      {/* 上下两部分主体：「更改」+「图形」 */}
      {overview?.isRepo && activeRepoRoot && (
        <div ref={splitContainerRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* ==================== 上部分：更改 ==================== */}
          <section
            style={
              changesPaneOpen && graphPaneOpen
                ? { flexGrow: splitRatio, flexShrink: 1, flexBasis: 0, minHeight: 110 }
                : undefined
            }
            className={`flex flex-col overflow-hidden ${
              changesPaneOpen ? (graphPaneOpen ? "min-h-0" : "min-h-0 flex-1") : "shrink-0"
            }`}
          >
            {/* 「更改」区折叠标题栏 */}
            <div className="flex h-7 shrink-0 items-center justify-between border-b border-zinc-800/80 px-2 hover:bg-zinc-800/40">
              <button
                onClick={() => setChangesPaneOpen((v) => !v)}
                className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-zinc-200"
              >
                {changesPaneOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                <span>更改</span>
                {totalPendingCount > 0 && (
                  <span className="rounded bg-zinc-800 px-1.5 text-[10px] font-medium text-sky-400">
                    {totalPendingCount}
                  </span>
                )}
              </button>

              {changesPaneOpen && (
                <div className="flex items-center gap-0.5">
                  {overview.changes.length > 0 && (
                    <>
                      <button
                        onClick={() => setConfirmDiscardAll(true)}
                        className="flex h-5 w-5 items-center justify-center rounded text-xs text-zinc-400 hover:bg-zinc-800 hover:text-amber-300"
                        title="放弃所有未暂存更改"
                      >
                        ↺
                      </button>
                      <button
                        onClick={() =>
                          void runAction("暂存全部更改", () => gitApi.stage(activeRepoRoot, []))
                        }
                        className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                        title="暂存全部更改"
                      >
                        <IconPlus size={12} />
                      </button>
                    </>
                  )}
                  {overview.staged.length > 0 && (
                    <button
                      onClick={() =>
                        void runAction("取消全部暂存", () => gitApi.unstage(activeRepoRoot, []))
                      }
                      className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                      title="取消暂存全部更改"
                    >
                      −
                    </button>
                  )}
                </div>
              )}
            </div>

            {changesPaneOpen && (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {/* 分支切换、同步与工作树入口栏 */}
                <div
                  ref={branchMenuRef}
                  className="relative flex shrink-0 items-center gap-1 border-b border-zinc-800/80 px-2.5 py-1.5"
                >
                  <button
                    onClick={() => setBranchMenuOpen((v) => !v)}
                    className="flex min-w-0 flex-1 items-center justify-between rounded border border-zinc-700/80 bg-zinc-950/80 px-2 py-1 text-xs hover:border-zinc-600"
                    title="切换或新建分支"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-zinc-200">
                      <IconGitBranch size={12} className="shrink-0 text-sky-400" />
                      <span className="truncate font-mono">{overview.branch || "HEAD"}</span>
                    </span>
                    <IconChevronDown size={11} className="ml-1 shrink-0 text-zinc-400" />
                  </button>

                  <button
                    onClick={() => void handleSyncOrPullPush()}
                    disabled={!!busyAction}
                    className="flex shrink-0 items-center gap-1 rounded border border-zinc-700/80 bg-zinc-950/80 px-2 py-1 text-[11px] text-zinc-300 hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-40"
                    title={
                      overview.behind > 0 && overview.ahead > 0
                        ? `同步：拉取 ${overview.behind} 个，推送 ${overview.ahead} 个`
                        : overview.behind > 0
                          ? `拉取 ${overview.behind} 个远程提交 (git pull)`
                          : overview.ahead > 0
                            ? `推送 ${overview.ahead} 个本地提交 (git push)`
                            : "获取远程更新 (git fetch --all --prune)"
                    }
                  >
                    {overview.behind > 0 && <span className="text-amber-400">↓{overview.behind}</span>}
                    {overview.ahead > 0 && <span className="text-emerald-400">↑{overview.ahead}</span>}
                    <span>
                      {overview.behind > 0 && overview.ahead > 0
                        ? "同步"
                        : overview.behind > 0
                          ? "拉取"
                          : overview.ahead > 0
                            ? "推送"
                            : "同步"}
                    </span>
                  </button>

                  <button
                    onClick={() => setWtManagerOpen(true)}
                    className="flex shrink-0 items-center gap-1 rounded border border-zinc-700/80 bg-zinc-950/80 px-1.5 py-1 text-[11px] text-zinc-300 hover:border-sky-500/50 hover:text-sky-300"
                    title={`管理 Git 工作树 (Worktrees，共 ${overview.worktrees.length} 个)`}
                  >
                    <IconWorktree size={12} />
                    <span>{overview.worktrees.length}</span>
                  </button>

                  {branchMenuOpen && (
                    <div className="absolute left-2.5 right-2.5 top-full z-30 mt-1 rounded-md border border-zinc-700 bg-zinc-950 p-2 shadow-2xl">
                      <div className="mb-2 flex items-center gap-1">
                        <input
                          ref={branchInputRef}
                          value={newBranchName}
                          onChange={(e) => setNewBranchName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && newBranchName.trim()) {
                              void handleCheckout(newBranchName, true);
                            }
                          }}
                          placeholder="新建分支名…"
                          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-sky-500"
                        />
                        <button
                          onClick={() => void handleCheckout(newBranchName, true)}
                          disabled={!newBranchName.trim() || !!busyAction}
                          className="rounded bg-sky-600 px-2 py-1 text-[11px] text-white hover:bg-sky-500 disabled:opacity-40"
                        >
                          创建
                        </button>
                      </div>
                      <div className="max-h-44 overflow-y-auto space-y-0.5">
                        {overview.branches.length === 0 ? (
                          <p className="py-2 text-center text-[11px] text-zinc-500">暂无本地分支（待首次提交）</p>
                        ) : (
                          overview.branches.map((b) => (
                            <button
                              key={b.name}
                              onClick={() => {
                                if (!b.current) void handleCheckout(b.name, false);
                                else setBranchMenuOpen(false);
                              }}
                              className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs ${
                                b.current
                                  ? "bg-sky-600/20 text-sky-400 font-medium"
                                  : "text-zinc-300 hover:bg-zinc-800"
                              }`}
                            >
                              <span className="truncate font-mono">{b.name}</span>
                              {b.current && <span className="text-[10px] shrink-0">当前</span>}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* 提交输入区与提交分裂按钮 */}
                <div className="shrink-0 border-b border-zinc-800/80 px-2.5 py-2 space-y-1.5">
                  <textarea
                    rows={2}
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault();
                        void handleCommit(false);
                      }
                    }}
                    placeholder="消息（Ctrl+Enter 提交）"
                    className="w-full resize-none rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-sky-500 select-text"
                  />
                  <div ref={commitMenuRef} className="relative flex items-stretch">
                    <button
                      onClick={() => void handleCommit(false)}
                      disabled={!canCommit || !!busyAction}
                      className="flex-1 rounded-l bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40 transition-colors"
                    >
                      {busyAction === "提交更改" || busyAction === "提交并推送"
                        ? "提交中…"
                        : overview.staged.length > 0
                          ? `提交 (${overview.staged.length})`
                          : overview.changes.length > 0
                            ? `暂存并提交 (${overview.changes.length})`
                            : "提交"}
                    </button>
                    <button
                      onClick={() => setCommitMenuOpen((v) => !v)}
                      disabled={!canCommit || !!busyAction}
                      className="flex items-center justify-center rounded-r border-l border-sky-500/40 bg-sky-600 px-1.5 text-white hover:bg-sky-500 disabled:opacity-40 transition-colors"
                      title="更多提交操作"
                    >
                      <IconChevronDown size={11} />
                    </button>

                    {commitMenuOpen && (
                      <div className="absolute right-0 top-full z-30 mt-1 w-36 rounded-md border border-zinc-700 bg-zinc-950 py-1 text-xs shadow-2xl">
                        <button
                          onClick={() => void handleCommit(false)}
                          className="flex w-full items-center px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                        >
                          提交
                        </button>
                        <button
                          onClick={() => void handleCommit(true)}
                          className="flex w-full items-center px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                        >
                          提交并推送
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 更改文件列表可滚动区域 */}
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {overview.staged.length > 0 && (
                    <div className="border-b border-zinc-800/60">
                      <div className="flex items-center justify-between px-2.5 py-1 hover:bg-zinc-800/40">
                        <button
                          onClick={() => setStagedOpen((v) => !v)}
                          className="flex items-center gap-1.5 text-xs font-medium text-zinc-200"
                        >
                          {stagedOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                          <span>已暂存的更改</span>
                          <span className="rounded bg-zinc-800 px-1.5 text-[10px] text-emerald-400">
                            {overview.staged.length}
                          </span>
                        </button>
                        <button
                          onClick={() =>
                            void runAction("取消全部暂存", () => gitApi.unstage(activeRepoRoot, []))
                          }
                          className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                          title="全部取消暂存"
                        >
                          −
                        </button>
                      </div>
                      {stagedOpen && (
                        <div className="pb-1">
                          {overview.staged.map((item) => (
                            <ChangeRow
                              key={`s:${item.path}`}
                              item={item}
                              onOpen={() => void openDiff(item, "staged")}
                              actions={
                                <>
                                  {item.status !== "D" && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openFile(item);
                                      }}
                                      className="rounded px-1 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                                      title="打开工作区文件"
                                    >
                                      打开
                                    </button>
                                  )}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void runAction("取消暂存", () => gitApi.unstage(activeRepoRoot, [item.path]));
                                    }}
                                    className="rounded px-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                                    title="取消暂存"
                                  >
                                    −
                                  </button>
                                </>
                              }
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between px-2.5 py-1 hover:bg-zinc-800/40">
                      <button
                        onClick={() => setUnstagedOpen((v) => !v)}
                        className="flex items-center gap-1.5 text-xs font-medium text-zinc-200"
                      >
                        {unstagedOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                        <span>更改</span>
                        <span className="rounded bg-zinc-800 px-1.5 text-[10px] text-amber-400">
                          {overview.changes.length}
                        </span>
                      </button>
                      {overview.changes.length > 0 && (
                        <div className="flex items-center gap-0.5">
                          <button
                            onClick={() => setConfirmDiscardAll(true)}
                            className="flex h-5 w-5 items-center justify-center rounded text-xs text-zinc-400 hover:bg-zinc-800 hover:text-amber-300"
                            title="放弃所有更改"
                          >
                            ↺
                          </button>
                          <button
                            onClick={() =>
                              void runAction("暂存全部更改", () => gitApi.stage(activeRepoRoot, []))
                            }
                            className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                            title="暂存全部更改"
                          >
                            <IconPlus size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                    {unstagedOpen && (
                      <div className="pb-1.5">
                        {overview.changes.length === 0 ? (
                          <p className="px-3 py-3 text-center text-[11px] text-zinc-500">
                            {overview.staged.length > 0 ? "无未暂存更改" : "工作区干净，暂无未提交更改"}
                          </p>
                        ) : (
                          overview.changes.map((item) => (
                            <ChangeRow
                              key={`c:${item.path}`}
                              item={item}
                              onOpen={() => void openDiff(item, "working")}
                              actions={
                                <>
                                  {item.status !== "D" && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openFile(item);
                                      }}
                                      className="rounded px-1 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                                      title="打开工作区文件"
                                    >
                                      打开
                                    </button>
                                  )}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConfirmDiscard(item);
                                    }}
                                    className="rounded px-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-amber-300"
                                    title="放弃更改"
                                  >
                                    ↺
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void runAction("暂存文件", () =>
                                        gitApi.stage(activeRepoRoot, [item.path]),
                                      );
                                    }}
                                    className="rounded px-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                                    title="暂存更改"
                                  >
                                    +
                                  </button>
                                </>
                              }
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* ==================== 上下栏可拖拽分隔条 ==================== */}
          {changesPaneOpen && graphPaneOpen && (
            <div
              role="separator"
              aria-orientation="horizontal"
              onMouseDown={handleStartSplitDrag}
              onDoubleClick={handleResetSplitRatio}
              title="上下拖拽调整「更改」与「图形」高度比例（双击重置）"
              className={`h-1 shrink-0 cursor-row-resize border-y transition-colors ${
                draggingSplit
                  ? "border-sky-500 bg-sky-500/40"
                  : "border-zinc-800 bg-zinc-900 hover:bg-sky-500/25"
              }`}
            />
          )}

          {/* ==================== 下部分：图形 ==================== */}
          <section
            style={
              changesPaneOpen && graphPaneOpen
                ? { flexGrow: 1 - splitRatio, flexShrink: 1, flexBasis: 0, minHeight: 110 }
                : undefined
            }
            className={`flex flex-col overflow-hidden ${
              !changesPaneOpen && graphPaneOpen ? "border-t border-zinc-800/80 " : ""
            }${graphPaneOpen ? (changesPaneOpen ? "min-h-0" : "min-h-0 flex-1") : "shrink-0 border-t border-zinc-800/80"}`}
          >
            {/* 「图形」区折叠标题栏 */}
            <div className="flex h-7 shrink-0 items-center justify-between border-b border-zinc-800/80 px-2 hover:bg-zinc-800/40">
              <button
                onClick={() => setGraphPaneOpen((v) => !v)}
                className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-zinc-200"
              >
                {graphPaneOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                <span>图形</span>
                <span className="rounded bg-zinc-800 px-1.5 text-[10px] font-medium text-zinc-400">
                  {overview.commits.length}
                </span>
              </button>

              {graphPaneOpen && (
                <button
                  onClick={() => gitStore.getState().setGraphAllBranches(!graphAllBranches)}
                  className="rounded border border-zinc-700/80 bg-zinc-950/70 px-1.5 py-0 text-[10px] leading-4 text-zinc-300 hover:border-sky-500/50 hover:text-sky-300"
                  title={
                    graphAllBranches
                      ? "当前显示全部分支提交图谱，点击切换为仅当前分支"
                      : "当前显示当前分支提交历史，点击切换为全部分支图谱"
                  }
                >
                  {graphAllBranches ? "全部分支" : "当前分支"}
                </button>
              )}
            </div>

            {graphPaneOpen && (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <CommitGraph
                  repoRoot={activeRepoRoot}
                  commits={overview.commits}
                  pendingCount={totalPendingCount}
                  graphError={overview.graphError}
                  onRetryGraph={() => void refresh(false)}
                  onCopyHash={(shortHash) => setNotice(`已复制提交哈希 ${shortHash}`)}
                />
              </div>
            )}
          </section>
        </div>
      )}

      {/* 工作树 (Worktrees) 管理弹窗 */}
      {wtManagerOpen && overview && activeRepoRoot && (
        <Modal
          title={`Git 工作树管理 (${overview.worktrees.length})`}
          onClose={() => setWtManagerOpen(false)}
          width={520}
          footer={
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {prunableCount > 0 && (
                  <Button
                    onClick={() =>
                      void runAction("清理失效工作树", async () => {
                        await gitApi.worktreePrune(activeRepoRoot);
                        setNotice("已清理失效工作树记录");
                      })
                    }
                  >
                    清理失效记录 ({prunableCount})
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={() => setWtManagerOpen(false)}>关闭</Button>
                <PrimaryButton
                  onClick={() => {
                    setWtManagerOpen(false);
                    handleOpenAddWorktree();
                  }}
                >
                  新建工作树
                </PrimaryButton>
              </div>
            </div>
          }
        >
          <div className="max-h-80 overflow-y-auto space-y-2 text-xs">
            {overview.worktrees.map((wt) => (
              <div
                key={wt.path}
                className={`rounded border px-3 py-2 ${
                  wt.isCurrent
                    ? "border-sky-500/40 bg-sky-500/10"
                    : "border-zinc-800 bg-zinc-950/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 font-mono text-zinc-100">
                    <IconGitBranch
                      size={13}
                      className={wt.isCurrent ? "shrink-0 text-sky-400" : "shrink-0 text-zinc-500"}
                    />
                    <span className="truncate font-medium">
                      {wt.branch || (wt.isBare ? "(bare)" : `detached @ ${wt.head}`)}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {wt.isCurrent && (
                      <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-400">
                        当前
                      </span>
                    )}
                    {wt.isMain && !wt.isCurrent && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        主树
                      </span>
                    )}
                    {wt.isPrunable && (
                      <span className="rounded bg-red-950/60 px-1.5 py-0.5 text-[10px] text-red-400">
                        目录缺失
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-1 truncate font-mono text-[11px] text-zinc-500" title={wt.path}>
                  {wt.path}
                </div>

                {!wt.isCurrent && !wt.isBare && (
                  <div className="mt-2 flex items-center justify-end gap-1.5">
                    {!wt.isPrunable && (
                      <>
                        <button
                          onClick={() => {
                            setWtManagerOpen(false);
                            void explorerStore.getState().openRoot(wt.uri);
                          }}
                          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-sky-500/50 hover:text-sky-400"
                        >
                          当前窗口切换
                        </button>
                        <button
                          onClick={() => void appApi.openNewWindow(undefined, undefined, wt.uri)}
                          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-sky-500/50 hover:text-sky-400"
                        >
                          新窗口打开
                        </button>
                      </>
                    )}
                    {!wt.isMain && (
                      <button
                        onClick={() => {
                          setForceRemoveWt(wt.isPrunable);
                          setConfirmRemoveWt(wt);
                        }}
                        className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                        title="移除工作树"
                      >
                        <IconTrash size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* 新建工作树弹窗 */}
      {wtModalOpen && overview && (
        <Modal
          title="新建 Git 工作树 (Worktree)"
          onClose={() => setWtModalOpen(false)}
          width={460}
          footer={
            <>
              <Button onClick={() => setWtModalOpen(false)}>取消</Button>
              <PrimaryButton
                disabled={!wtBranch.trim() || !wtTargetPath.trim() || !!busyAction}
                onClick={() => void handleCreateWorktree()}
              >
                {busyAction === "创建工作树" ? "创建中…" : "创建工作树"}
              </PrimaryButton>
            </>
          }
        >
          <div className="space-y-3 text-xs">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setWtCreateBranch(true)}
                className={`flex-1 rounded border py-1.5 font-medium ${
                  wtCreateBranch
                    ? "border-sky-500 bg-sky-600/20 text-sky-400"
                    : "border-zinc-700 bg-zinc-900 text-zinc-400"
                }`}
              >
                新建分支并创建工作树
              </button>
              <button
                type="button"
                onClick={() => setWtCreateBranch(false)}
                className={`flex-1 rounded border py-1.5 font-medium ${
                  !wtCreateBranch
                    ? "border-sky-500 bg-sky-600/20 text-sky-400"
                    : "border-zinc-700 bg-zinc-900 text-zinc-400"
                }`}
              >
                基于已有分支创建
              </button>
            </div>

            {wtCreateBranch ? (
              <>
                <div>
                  <label className="mb-1 block text-zinc-400">新分支名称</label>
                  <input
                    value={wtBranch}
                    onChange={(e) => handleWorktreeBranchChange(e.target.value)}
                    placeholder="例如 feat/login-ui"
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-zinc-100 outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-zinc-400">基准分支 / Commit（可选）</label>
                  <input
                    value={wtBaseRef}
                    onChange={(e) => setWtBaseRef(e.target.value)}
                    placeholder="留空则基于当前 HEAD"
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-zinc-100 outline-none focus:border-sky-500"
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="mb-1 block text-zinc-400">选择已有分支</label>
                <select
                  value={wtBranch}
                  onChange={(e) => handleWorktreeBranchChange(e.target.value)}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-zinc-100 outline-none focus:border-sky-500"
                >
                  <option value="">-- 请选择分支 --</option>
                  {overview.branches
                    .filter((b) => !overview.worktrees.some((w) => w.branch === b.name))
                    .map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div>
              <label className="mb-1 block text-zinc-400">工作树保存目录</label>
              <div className="flex gap-1.5">
                <input
                  value={wtTargetPath}
                  onChange={(e) => {
                    setWtTargetEdited(true);
                    setWtTargetPath(e.target.value);
                  }}
                  placeholder="输入目标路径，例如 ../repo-wt/feat"
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-zinc-100 outline-none focus:border-sky-500"
                />
                {!rootPath.startsWith("remote://") && !rootPath.startsWith("wsl://") && (
                  <Button
                    onClick={() => void handlePickWorktreeDir()}
                    className="border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-300 hover:bg-zinc-700"
                  >
                    浏览…
                  </Button>
                )}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-zinc-400">创建后操作</label>
              <select
                value={wtOpenAfter}
                onChange={(e) => setWtOpenAfter(e.target.value as "none" | "current" | "newWindow")}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-zinc-100 outline-none focus:border-sky-500"
              >
                <option value="current">在当前窗口切换到新工作树</option>
                <option value="newWindow">在新窗口中打开新工作树</option>
                <option value="none">仅创建，保持当前工作区不变</option>
              </select>
            </div>
          </div>
        </Modal>
      )}

      {/* 移除工作树确认弹窗 */}
      {confirmRemoveWt && activeRepoRoot && (
        <Modal
          title="移除 Git 工作树"
          onClose={() => setConfirmRemoveWt(null)}
          footer={
            <>
              <Button onClick={() => setConfirmRemoveWt(null)}>取消</Button>
              <DangerButton
                disabled={!!busyAction}
                onClick={() => {
                  const targetWt = confirmRemoveWt;
                  setConfirmRemoveWt(null);
                  void runAction("移除工作树", async () => {
                    await gitApi.worktreeRemove(activeRepoRoot, targetWt.path, forceRemoveWt);
                    setNotice("已移除工作树");
                  });
                }}
              >
                确认移除
              </DangerButton>
            </>
          }
        >
          <div className="space-y-3 text-xs">
            <p className="text-zinc-300">
              确定要移除工作树目录{" "}
              <span className="font-mono text-zinc-100 break-all">{confirmRemoveWt.path}</span> 吗？
            </p>
            <label className="flex items-center gap-2 text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={forceRemoveWt}
                onChange={(e) => setForceRemoveWt(e.target.checked)}
                className="accent-sky-500"
              />
              <span>强制移除（包含未提交更改或目录缺失时勾选 --force）</span>
            </label>
          </div>
        </Modal>
      )}

      {/* 放弃单个文件更改确认弹窗 */}
      {confirmDiscard && activeRepoRoot && (
        <Modal
          title="放弃更改"
          onClose={() => setConfirmDiscard(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDiscard(null)}>取消</Button>
              <DangerButton
                disabled={!!busyAction}
                onClick={() => {
                  const target = confirmDiscard;
                  setConfirmDiscard(null);
                  void runAction("放弃更改", async () => {
                    await gitApi.discard(activeRepoRoot, target.path, target.status === "U");
                    if (rootPath) void explorerStore.getState().refresh(rootPath);
                  });
                }}
              >
                确认放弃
              </DangerButton>
            </>
          }
        >
          <p className="text-xs text-zinc-300">
            {confirmDiscard.status === "U" ? "确定永久删除未跟踪文件 " : "确定还原对文件 "}
            <span className="font-mono text-zinc-100 break-all">{confirmDiscard.path}</span>
            {confirmDiscard.status === "U" ? " 吗？此操作不可恢复。" : " 的未暂存修改吗？"}
          </p>
        </Modal>
      )}

      {/* 放弃所有未暂存更改确认弹窗 */}
      {confirmDiscardAll && activeRepoRoot && overview && (
        <Modal
          title="放弃所有更改"
          onClose={() => setConfirmDiscardAll(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDiscardAll(false)}>取消</Button>
              <DangerButton
                disabled={!!busyAction}
                onClick={() => {
                  setConfirmDiscardAll(false);
                  void runAction("放弃所有更改", async () => {
                    await gitApi.discardAll(activeRepoRoot);
                    if (rootPath) void explorerStore.getState().refresh(rootPath);
                    setNotice("已放弃所有未暂存更改");
                  });
                }}
              >
                全部放弃
              </DangerButton>
            </>
          }
        >
          <p className="text-xs text-zinc-300">
            确定要还原工作区所有已修改文件并删除未跟踪文件（共{" "}
            <span className="font-semibold text-amber-300">{overview.changes.length}</span>{" "}
            项）吗？此操作不可恢复。
          </p>
        </Modal>
      )}
    </div>
  );
}

function ChangeRow({
  item,
  onOpen,
  actions,
}: {
  item: GitFileEntryDto;
  onOpen: () => void;
  actions: React.ReactNode;
}) {
  const { name, dir } = splitPathParts(item.path);
  return (
    <div
      onClick={onOpen}
      title={`${item.path}（点击查看文件对比）`}
      className="group flex cursor-pointer items-center justify-between gap-2 px-3 py-1 text-xs hover:bg-zinc-800/70"
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-zinc-200">{name}</span>
        {dir && <span className="truncate text-[10px] text-zinc-500">{dir}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <div className="hidden items-center gap-0.5 group-hover:flex">{actions}</div>
        <span className={`w-3.5 text-center font-mono text-[11px] font-semibold ${statusColorClass(item.status)}`}>
          {item.status}
        </span>
      </div>
    </div>
  );
}
