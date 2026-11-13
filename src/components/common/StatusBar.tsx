import { useEffect, useMemo, useState, type ReactNode } from "react";
import { calcPercent, formatSpeed } from "../../lib/format";
import { tabsStore } from "../../stores/tabs";
import { transferStore } from "../../stores/transfer";
import { uiStore } from "../../stores/ui";
import { requestApplyUpdate, updaterStore } from "../../stores/updater";
import { appApi } from "../../services/files";
import { lspStatusStore, type LspStatus } from "../../lib/lsp/remoteLsp";

interface StatusBarProps {
  onToggleTerminal?: () => void;
}

export function StatusBar({ onToggleTerminal }: StatusBarProps) {
  const activeId = tabsStore((s) => s.activeId);
  const tabs = tabsStore((s) => s.tabs);
  const line = uiStore((s) => s.line);
  const column = uiStore((s) => s.column);
  const [version, setVersion] = useState<string>("");
  const statuses = lspStatusStore((s) => s.statuses);

  const tasks = transferStore((s) => s.tasks);
  const updateResult = updaterStore((s) => s.result);
  const updateDownloading = updaterStore((s) => s.downloading);
  const updateProgress = updaterStore((s) => s.downloadProgress);
  const updateDownloadResult = updaterStore((s) => s.downloadResult);
  const updateApplying = updaterStore((s) => s.applying);

  // 安全计算远程 LSP 状态（纯数据计算，严禁在条件分支或嵌套函数中调用 Hook）
  const lsp = useMemo(() => {
    if (!activeId || !activeId.startsWith("remote://")) return null;
    const rest = activeId.slice("remote://".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    const deviceId = rest.slice(0, slash);
    const status = statuses[deviceId] ?? { state: "closed" };
    return { deviceId, status };
  }, [activeId, statuses]);

  const activeTransfer = useMemo(() => {
    const running = tasks.filter(
      (t) => t.status === "scanning" || t.status === "transferring",
    );
    if (running.length === 0) return null;
    const totalBytes = running.reduce((acc, t) => acc + t.totalBytes, 0);
    const transferredBytes = running.reduce((acc, t) => acc + t.transferredBytes, 0);
    const speed = running.reduce((acc, t) => acc + t.speedBytesPerSec, 0);
    const hasUpload = running.some((t) => t.direction === "upload");
    const hasDownload = running.some((t) => t.direction === "download");
    const dirLabel = hasUpload && hasDownload ? "传输" : hasUpload ? "上传" : "下载";
    const pct = calcPercent(transferredBytes, totalBytes);
    const spd = formatSpeed(speed);
    return {
      count: running.length,
      text: `${dirLabel} ${pct}%${spd ? ` (${spd})` : ""}`,
    };
  }, [tasks]);

  useEffect(() => {
    appApi
      .getInfo()
      .then((info) => setVersion(`${info.name} ${info.version}`))
      .catch(() => setVersion("Glance IDE"));
  }, []);

  const active = tabs.find((t) => t.uri === activeId);
  const dirtyCount = tabs.filter((t) => t.dirty).length;

  let lspLabel: ReactNode | null = null;
  if (lsp) {
    const { status } = lsp;
    const map: Record<LspStatus["state"], { text: string; cls: string; title: string }> = {
      starting: { text: `LSP ${status.server ?? "…"} 启动中`, cls: "text-amber-400", title: status.message ?? "远程语言服务器启动中" },
      ready: { text: `LSP ${status.server ?? "✓"}`, cls: "text-emerald-400", title: `远程语言服务器 ${status.server} 已就绪` },
      failed: { text: "LSP 降级", cls: "text-red-400", title: status.message ?? "远程语言服务器不可用（缺失或启动失败）；编辑/保存/终端不受影响" },
      closed: { text: "LSP 离线", cls: "text-zinc-600", title: status.message ?? "无活跃语言服务器会话" },
    };
    const m = map[status.state];
    lspLabel = (
      <span className={m.cls} title={m.title}>
        {m.text}
      </span>
    );
  }

  return (
    <div className="flex h-6 items-center justify-between border-t border-zinc-800 bg-zinc-950 px-3 text-xs text-zinc-500">
      <div className="flex items-center gap-3 min-w-0">
        <span className="shrink-0 text-sky-500">{version || "Glance IDE"}</span>
        {active && (
          <span className="truncate" title={active.path}>
            {active.path}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {activeTransfer && (
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("glance:activate-panel", { detail: "explorer" }),
              )
            }
            className="rounded px-1.5 font-mono text-sky-400 transition-colors hover:bg-zinc-800 hover:text-sky-300"
            title={`共有 ${activeTransfer.count} 项文件传输进行中，点击查看队列详情`}
          >
            ⇅ {activeTransfer.text}
          </button>
        )}

        {updateDownloading && updateProgress ? (
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("glance:open-settings", { detail: { section: "updates" } }),
              )
            }
            className="rounded px-1.5 font-mono text-sky-400 transition-colors hover:bg-zinc-800 hover:text-sky-300"
            title="正在下载新版本更新包，点击查看详情"
          >
            ↓ 更新 {calcPercent(updateProgress.downloadedBytes, updateProgress.totalBytes)}%
          </button>
        ) : (
          updateDownloadResult &&
          updateResult?.hasUpdate &&
          updateDownloadResult.installMode !== "manual" && (
            <button
              type="button"
              disabled={updateApplying}
              onClick={() => requestApplyUpdate(updateDownloadResult.savedPath)}
              className="rounded px-1.5 font-medium text-emerald-400 transition-colors hover:bg-zinc-800 hover:text-emerald-300 disabled:opacity-50"
              title={`v${updateResult.latestVersion} 已就绪，点击立即应用更新并重启`}
            >
              {updateApplying
                ? "↻ 正在准备更新…"
                : `↻ 重启更新到 v${updateResult.latestVersion}`}
            </button>
          )
        )}

        {lspLabel}
        {dirtyCount > 0 && (
          <span className="text-amber-500">{dirtyCount} 个未保存</span>
        )}
        {active && !active.error && (
          <>
            <span>
              行 {line}, 列 {column}
            </span>
            <span>UTF-8</span>
          </>
        )}
        {active?.readonly && <span className="text-amber-500">只读</span>}
        <button
          onClick={onToggleTerminal}
          className="rounded px-1 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          title="终端 / 任务（Ctrl+`）"
        >
          ▮ 终端
        </button>
      </div>
    </div>
  );
}
