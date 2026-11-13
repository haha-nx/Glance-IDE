import { calcPercent, formatBytes, formatSpeed } from "../../lib/format";
import { transferApi } from "../../services/files";
import { transferStore, type TransferTaskItem } from "../../stores/transfer";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconDownload,
  IconFolder,
  IconTrash,
  IconUpload,
} from "../common/icons";

function statusLabel(task: TransferTaskItem): { text: string; cls: string } {
  switch (task.status) {
    case "scanning":
      return { text: "扫描中", cls: "text-sky-400" };
    case "transferring":
      return { text: "传输中", cls: "text-sky-400" };
    case "completed":
      return { text: "已完成", cls: "text-emerald-400" };
    case "cancelled":
      return { text: "已取消", cls: "text-amber-400" };
    case "failed":
      return { text: "失败", cls: "text-red-400" };
  }
}

function barColor(status: TransferTaskItem["status"]): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500";
    case "cancelled":
      return "bg-amber-500";
    case "failed":
      return "bg-red-500";
    default:
      return "bg-sky-500";
  }
}

export function TransferQueuePanel() {
  const tasks = transferStore((s) => s.tasks);
  const queueExpanded = transferStore((s) => s.queueExpanded);
  const setQueueExpanded = transferStore((s) => s.setQueueExpanded);
  const cancelTask = transferStore((s) => s.cancelTask);
  const removeTask = transferStore((s) => s.removeTask);
  const clearFinished = transferStore((s) => s.clearFinished);

  if (tasks.length === 0) return null;

  const activeCount = tasks.filter(
    (t) => t.status === "scanning" || t.status === "transferring",
  ).length;
  const hasFinished = tasks.some(
    (t) => t.status !== "scanning" && t.status !== "transferring",
  );

  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/90">
      <div
        onClick={() => setQueueExpanded(!queueExpanded)}
        className="flex h-7 cursor-pointer items-center justify-between px-2.5 text-[11px] font-medium text-zinc-400 select-none hover:bg-zinc-900/80"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {queueExpanded ? (
            <IconChevronDown size={12} strokeWidth={1.6} />
          ) : (
            <IconChevronRight size={12} strokeWidth={1.6} />
          )}
          <span className="truncate">文件传输</span>
          {activeCount > 0 && (
            <span className="rounded bg-sky-500/20 px-1.5 py-0 text-[10px] font-mono text-sky-400">
              {activeCount} 进行中
            </span>
          )}
        </div>

        {hasFinished && (
          <button
            type="button"
            title="清理已完成或已终止的传输记录"
            onClick={(e) => {
              e.stopPropagation();
              clearFinished();
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <IconTrash size={12} />
          </button>
        )}
      </div>

      {queueExpanded && (
        <div className="max-h-48 space-y-1.5 overflow-y-auto px-2.5 pb-2">
          {tasks.map((task) => {
            const isActive = task.status === "scanning" || task.status === "transferring";
            const pct = calcPercent(
              task.transferredBytes,
              task.totalBytes,
              task.status === "completed",
            );
            const speed = formatSpeed(task.speedBytesPerSec);
            const st = statusLabel(task);

            return (
              <div
                key={task.taskId}
                className="rounded border border-zinc-800/90 bg-zinc-900/90 px-2 py-1.5 text-[11px]"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 text-sky-400">
                      {task.direction === "upload" ? (
                        <IconUpload size={12} />
                      ) : (
                        <IconDownload size={12} />
                      )}
                    </span>
                    <span className="truncate font-medium text-zinc-200" title={task.title}>
                      {task.title}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    {isActive ? (
                      <button
                        type="button"
                        title="取消传输"
                        onClick={() => void cancelTask(task.taskId)}
                        className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-red-400"
                      >
                        <IconClose size={12} />
                      </button>
                    ) : (
                      <>
                        {task.direction === "download" &&
                          task.status === "completed" &&
                          task.destPaths[0] && (
                            <button
                              type="button"
                              title="在文件管理器中显示"
                              onClick={() => void transferApi.revealLocalPath(task.destPaths[0])}
                              className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                            >
                              <IconFolder size={12} />
                            </button>
                          )}
                        <button
                          type="button"
                          title="移除此记录"
                          onClick={() => removeTask(task.taskId)}
                          className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                        >
                          <IconClose size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* 进度条 */}
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={`h-full transition-all duration-150 ${barColor(task.status)} ${
                      task.status === "scanning" && task.totalBytes === 0 ? "animate-pulse" : ""
                    }`}
                    style={{
                      width: `${task.status === "scanning" && task.totalBytes === 0 ? 35 : pct}%`,
                    }}
                  />
                </div>

                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-zinc-400">
                  <span className="truncate font-mono">
                    {task.status === "scanning"
                      ? `正在扫描 (${task.totalFiles} 项)${task.currentFile ? ` · ${task.currentFile}` : ""}`
                      : task.currentFile ||
                        (task.totalFiles > 0
                          ? `${task.completedFiles}/${task.totalFiles} 个文件`
                          : "目录同步")}
                  </span>
                  <span className={`shrink-0 font-mono ${st.cls}`}>
                    {isActive
                      ? `${pct}%${speed ? ` · ${speed}` : ""}`
                      : `${st.text}${task.totalBytes > 0 ? ` · ${formatBytes(task.totalBytes)}` : ""}`}
                  </span>
                </div>

                {task.error && (
                  <p className="mt-1 truncate text-[10px] text-red-400" title={task.error}>
                    {task.error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
