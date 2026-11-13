import { create } from "zustand";
import {
  transferApi,
  type ConflictPolicy,
  type TransferConflictDto,
  type TransferDirection,
  type TransferProgressDto,
  type TransferResultDto,
  type TransferStatus,
} from "../services/files";
import { explorerStore } from "./explorer";
import type { FileEntryDto } from "../types/ipc";

export interface TransferTaskItem {
  taskId: string;
  direction: TransferDirection;
  title: string;
  targetDirUri: string | null;
  destPaths: string[];
  status: TransferStatus;
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  transferredBytes: number;
  currentFile: string;
  speedBytesPerSec: number;
  error: string | null;
  createdAt: number;
}

export interface PendingTransferConflict {
  direction: TransferDirection;
  conflicts: TransferConflictDto[];
  sourcePaths: string[];
  targetDirUri: string;
  displayLabel: string;
}

export interface TransferState {
  tasks: TransferTaskItem[];
  queueExpanded: boolean;
  pendingConflict: PendingTransferConflict | null;

  setQueueExpanded(expanded: boolean): void;
  uploadLocalPaths(sourceLocalPaths: string[], targetDirUri: string): Promise<void>;
  downloadEntry(entry: FileEntryDto): Promise<void>;
  resolveConflict(choice: ConflictPolicy | "cancel"): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  removeTask(taskId: string): void;
  clearFinished(): void;
}

function baseNameOf(rawPath: string): string {
  const clean = rawPath.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function summarizeSources(paths: string[]): string {
  if (paths.length === 0) return "";
  const first = baseNameOf(paths[0]);
  return paths.length === 1 ? first : `${first} 等 ${paths.length} 项`;
}

function genTaskId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tr-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

/** 上传 / 下载完成或取消后保留展示的时长（5 秒后自动移除，队列清空则隐藏面板）。 */
const AUTO_DISMISS_DELAY_MS = 5000;
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearDismissTimer(taskId: string) {
  const timer = dismissTimers.get(taskId);
  if (timer !== undefined) {
    clearTimeout(timer);
    dismissTimers.delete(taskId);
  }
}

function scheduleAutoDismiss(taskId: string) {
  clearDismissTimer(taskId);
  const timer = setTimeout(() => {
    dismissTimers.delete(taskId);
    transferStore.getState().removeTask(taskId);
  }, AUTO_DISMISS_DELAY_MS);
  dismissTimers.set(taskId, timer);
}

function applyProgressEvent(ev: TransferProgressDto) {
  transferStore.setState((s) => ({
    tasks: s.tasks.map((t) =>
      t.taskId === ev.taskId
        ? {
            ...t,
            status: ev.status,
            totalFiles: ev.totalFiles,
            completedFiles: ev.completedFiles,
            totalBytes: ev.totalBytes,
            transferredBytes: ev.transferredBytes,
            currentFile: ev.currentFile,
            speedBytesPerSec: ev.speedBytesPerSec,
            error: ev.error ?? t.error,
          }
        : t,
    ),
  }));
}

function applyFinalResult(taskId: string, res: TransferResultDto) {
  transferStore.setState((s) => ({
    tasks: s.tasks.map((t) =>
      t.taskId === taskId
        ? {
            ...t,
            status: res.status,
            totalFiles: res.totalFiles,
            completedFiles: res.completedFiles,
            totalBytes: res.totalBytes,
            transferredBytes: res.transferredBytes,
            destPaths: res.destPaths,
            speedBytesPerSec: 0,
            error: res.error ?? null,
          }
        : t,
    ),
  }));
  if (res.status === "completed" || res.status === "cancelled") {
    scheduleAutoDismiss(taskId);
  }
}

function applyFailedResult(taskId: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  transferStore.setState((s) => ({
    tasks: s.tasks.map((t) =>
      t.taskId === taskId
        ? { ...t, status: "failed", speedBytesPerSec: 0, error: msg }
        : t,
    ),
  }));
}

async function runUploadTask(
  sourceLocalPaths: string[],
  targetDirUri: string,
  policy: ConflictPolicy,
) {
  const taskId = genTaskId();
  const targetLabel = baseNameOf(targetDirUri) || "/";
  const initial: TransferTaskItem = {
    taskId,
    direction: "upload",
    title: `上传 ${summarizeSources(sourceLocalPaths)} → ${targetLabel}`,
    targetDirUri,
    destPaths: [],
    status: "scanning",
    totalFiles: 0,
    completedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    currentFile: "",
    speedBytesPerSec: 0,
    error: null,
    createdAt: Date.now(),
  };

  transferStore.setState((s) => ({
    queueExpanded: true,
    tasks: [initial, ...s.tasks].slice(0, 30),
  }));

  try {
    const res = await transferApi.upload(
      taskId,
      sourceLocalPaths,
      targetDirUri,
      policy,
      applyProgressEvent,
    );
    applyFinalResult(taskId, res);
    // 刷新目标目录树，使新上传文件立即可见
    const explorer = explorerStore.getState();
    if (explorer.rootPath) {
      explorerStore.setState((s) => ({
        expanded: { ...s.expanded, [targetDirUri]: true },
      }));
      void explorer.refresh(targetDirUri);
    }
  } catch (err) {
    applyFailedResult(taskId, err);
  }
}

async function runDownloadTask(
  sourceUris: string[],
  destDirPath: string | null,
  destFilePath: string | null,
  policy: ConflictPolicy,
  displayLabel: string,
) {
  const taskId = genTaskId();
  const destLabel = baseNameOf(destFilePath ?? destDirPath ?? "");
  const initial: TransferTaskItem = {
    taskId,
    direction: "download",
    title: `下载 ${displayLabel} → ${destLabel || "本地"}`,
    targetDirUri: null,
    destPaths: destFilePath ? [destFilePath] : [],
    status: "scanning",
    totalFiles: 0,
    completedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    currentFile: "",
    speedBytesPerSec: 0,
    error: null,
    createdAt: Date.now(),
  };

  transferStore.setState((s) => ({
    queueExpanded: true,
    tasks: [initial, ...s.tasks].slice(0, 30),
  }));

  try {
    const res = await transferApi.download(
      taskId,
      sourceUris,
      destDirPath,
      destFilePath,
      policy,
      applyProgressEvent,
    );
    applyFinalResult(taskId, res);
  } catch (err) {
    applyFailedResult(taskId, err);
  }
}

export const transferStore = create<TransferState>()((set, get) => ({
  tasks: [],
  queueExpanded: true,
  pendingConflict: null,

  setQueueExpanded: (expanded) => set({ queueExpanded: expanded }),

  uploadLocalPaths: async (sourceLocalPaths, targetDirUri) => {
    if (sourceLocalPaths.length === 0 || !targetDirUri) return;
    try {
      const conflicts = await transferApi.checkConflicts(sourceLocalPaths, targetDirUri);
      if (conflicts.length > 0) {
        set({
          pendingConflict: {
            direction: "upload",
            conflicts,
            sourcePaths: sourceLocalPaths,
            targetDirUri,
            displayLabel: summarizeSources(sourceLocalPaths),
          },
        });
        return;
      }
    } catch {
      // 冲突预检非致命，转入正式传输流程报告明确错误
    }
    await runUploadTask(sourceLocalPaths, targetDirUri, "overwrite");
  },

  downloadEntry: async (entry) => {
    const dialog = await import("@tauri-apps/plugin-dialog");
    if (entry.kind === "dir") {
      const selectedDir = await dialog.open({
        directory: true,
        multiple: false,
        title: `选择“${entry.name}”保存位置`,
      });
      if (typeof selectedDir !== "string" || selectedDir.length === 0) return;

      try {
        const conflicts = await transferApi.checkConflicts([entry.path], selectedDir);
        if (conflicts.length > 0) {
          set({
            pendingConflict: {
              direction: "download",
              conflicts,
              sourcePaths: [entry.path],
              targetDirUri: selectedDir,
              displayLabel: entry.name,
            },
          });
          return;
        }
      } catch {
        // 交由执行层反馈具体错误
      }
      await runDownloadTask([entry.path], selectedDir, null, "overwrite", entry.name);
    } else {
      const selectedFile = await dialog.save({
        defaultPath: entry.name,
        title: "保存下载文件",
      });
      if (typeof selectedFile !== "string" || selectedFile.length === 0) return;
      await runDownloadTask([entry.path], null, selectedFile, "overwrite", entry.name);
    }
  },

  resolveConflict: async (choice) => {
    const pending = get().pendingConflict;
    set({ pendingConflict: null });
    if (!pending || choice === "cancel") return;
    if (pending.direction === "upload") {
      await runUploadTask(pending.sourcePaths, pending.targetDirUri, choice);
    } else {
      await runDownloadTask(
        pending.sourcePaths,
        pending.targetDirUri,
        null,
        choice,
        pending.displayLabel,
      );
    }
  },

  cancelTask: async (taskId) => {
    try {
      await transferApi.cancel(taskId);
    } catch {
      /* 忽略已完成任务的取消竞态 */
    }
  },

  removeTask: (taskId) => {
    clearDismissTimer(taskId);
    set((s) => ({ tasks: s.tasks.filter((t) => t.taskId !== taskId) }));
  },

  clearFinished: () =>
    set((s) => {
      const remaining: TransferTaskItem[] = [];
      for (const t of s.tasks) {
        if (t.status === "scanning" || t.status === "transferring") {
          remaining.push(t);
        } else {
          clearDismissTimer(t.taskId);
        }
      }
      return { tasks: remaining };
    }),
}));
