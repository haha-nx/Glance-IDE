import { useEffect, useState, type ReactNode } from "react";
import { tabsStore } from "../../stores/tabs";
import { uiStore } from "../../stores/ui";
import { appApi } from "../../services/files";
import { lspStatusStore, type LspStatus } from "../../lib/lsp/remoteLsp";

interface StatusBarProps {
  onToggleTerminal?: () => void;
}

/** 活动标签对应设备的远程 LSP 状态（M6，§6.6 降级可见） */
function lspStatusFor(uri: string | null): { deviceId: string; status: LspStatus } | null {
  if (!uri || !uri.startsWith("remote://")) return null;
  const rest = uri.slice("remote://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const deviceId = rest.slice(0, slash);
  const status = lspStatusStore((s) => s.statuses[deviceId]);
  if (!status) return { deviceId, status: { state: "closed" } };
  return { deviceId, status };
}

export function StatusBar({ onToggleTerminal }: StatusBarProps) {
  const activeId = tabsStore((s) => s.activeId);
  const tabs = tabsStore((s) => s.tabs);
  const line = uiStore((s) => s.line);
  const column = uiStore((s) => s.column);
  const [version, setVersion] = useState<string>("");
  const lsp = lspStatusFor(activeId);

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
      <div className="flex items-center gap-3">
        <span className="text-sky-500">{version || "Glance IDE"}</span>
        {active && <span title={active.path}>{active.path}</span>}
      </div>
      <div className="flex items-center gap-4">
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
          className="rounded px-1 hover:bg-zinc-800 hover:text-zinc-300"
          title="终端 / 任务（Ctrl+`）"
        >
          ▮ 终端
        </button>
      </div>
    </div>
  );
}
