import type { ReactNode, RefObject } from "react";
import type { Problem } from "../../lib/problems";

export function PanelTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-xs transition-colors ${
        active ? "bg-zinc-800 text-zinc-100 font-medium" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
      }`}
    >
      {children}
    </button>
  );
}

export function TasksView({
  command,
  onCommandChange,
  onRunTask,
  running,
  hasSessions,
  taskOutput,
  outputRef,
}: {
  command: string;
  onCommandChange: (val: string) => void;
  onRunTask: () => void;
  running: boolean;
  hasSessions: boolean;
  taskOutput: string;
  outputRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2 text-xs">
      <div className="flex items-center gap-2 pb-2">
        <input
          value={command}
          onChange={(e) => onCommandChange(e.target.value)}
          placeholder="构建命令（如 cargo build 或 make）"
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-zinc-200 outline-none focus:border-sky-500"
        />
        <button
          onClick={onRunTask}
          disabled={running || !hasSessions}
          className="rounded bg-sky-600 px-3 py-1 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {running ? "运行中…" : "执行"}
        </button>
      </div>
      <div
        ref={outputRef}
        className="min-h-0 flex-1 overflow-auto rounded bg-[var(--glance-bg-terminal)] p-2 font-mono text-[11px] text-zinc-300"
      >
        <pre className="whitespace-pre-wrap">{taskOutput || "（暂无任务输出）"}</pre>
      </div>
    </div>
  );
}

export function ProblemsView({
  problems,
  onOpenProblem,
}: {
  problems: Problem[];
  onOpenProblem: (p: Problem) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
      {problems.length === 0 ? (
        <p className="text-zinc-500">未检测到编译问题。</p>
      ) : (
        <div className="space-y-1">
          {problems.map((p, i) => (
            <div
              key={i}
              onClick={() => onOpenProblem(p)}
              className="flex cursor-pointer items-center justify-between rounded px-2 py-1 text-zinc-300 hover:bg-zinc-800"
            >
              <span className="truncate">
                <span className={p.severity === "error" ? "text-red-400" : "text-amber-400"}>
                  [{p.severity.toUpperCase()}]
                </span>{" "}
                {p.message}
              </span>
              <span className="ml-2 shrink-0 font-mono text-[11px] text-zinc-500">
                {p.file}:{p.line}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
