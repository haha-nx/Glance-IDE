import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { sshApi } from "../../services/ssh";
import {
  base64ToBytes,
  terminalApi,
  type TerminalEvent,
  type TerminalInfo,
} from "../../services/terminal";
import { tabsStore } from "../../stores/tabs";
import { explorerStore } from "../../stores/explorer";
import { parseProblems, resolveProblemPath, stripAnsi, type Problem } from "../../lib/problems";
import type { SessionDto } from "../../types/ssh";
import { IconClose, IconWarning } from "../common/icons";

interface TermEntry {
  info: TerminalInfo;
  term: XTerm;
  fit: FitAddon;
  title: string;
}

/**
 * 底部面板（M4）：终端（PTY）+ 构建任务 + 问题列表。
 * 数据流：Rust wait 循环 → Tauri Channel → xterm/输出区（块传输）。
 */
export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"terminal" | "tasks" | "problems">("terminal");
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [terms, setTerms] = useState<TermEntry[]>([]);
  const [activeTermId, setActiveTermId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [taskOutput, setTaskOutput] = useState("");
  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemContext, setProblemContext] = useState<{ device: string | null; cwd: string } | null>(null);
  const [lastExit, setLastExit] = useState<{ code: number; ms: number } | null>(null);
  const [command, setCommand] = useState("colcon build --symlink-install");
  const outputRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termsRef = useRef<Map<string, TermEntry>>(new Map());

  useEffect(() => {
    sshApi
      .listSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
    return () => {
      // 组件卸载：关闭全部终端通道
      for (const entry of termsRef.current.values()) {
        void terminalApi.close(entry.info.channelId).catch(() => {});
        entry.term.dispose();
      }
      termsRef.current.clear();
    };
  }, []);

  const createTerminal = useCallback(
    async (session: SessionDto) => {
      const container = containerRef.current;
      if (!container || termsRef.current.has(session.sessionId)) return;
      const { Terminal } = await import("@xterm/xterm");
      const term = new Terminal({
        fontFamily: '"SF Mono", Menlo, Consolas, monospace',
        fontSize: 12,
        theme: {
          background: "#131316",
          foreground: "#d4d4d8",
          cursor: "#38bdf8",
          selectionBackground: "#38bdf855",
        },
        cursorBlink: true,
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      try {
        fit.fit();
      } catch {
        /* 容器尚未布局 */
      }

      const info = await terminalApi.open(session.sessionId, term.cols, term.rows, (e) =>
        handleEvent(session.sessionId, e),
      );
      term.onData((data) => void terminalApi.write(info.channelId, data));

      const entry: TermEntry = { info, term, fit, title: session.deviceName || "终端" };
      termsRef.current.set(session.sessionId, entry);
      setTerms([...termsRef.current.values()]);
      setActiveTermId(session.sessionId);

      // resize 同步
      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
          void terminalApi.resize(info.channelId, term.cols, term.rows);
        } catch {
          /* 忽略布局期错误 */
        }
      });
      ro.observe(container);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function handleEvent(sessionId: string, e: TerminalEvent) {
    const entry = termsRef.current.get(sessionId);
    if (entry && e.type === "data") {
      entry.term.write(base64ToBytes(e.bytes));
    }
  }

  async function runTask() {
    if (!sessions.length || running) return;
    const session = sessions[0];
    setRunning(true);
    setTab("tasks");
    setTaskOutput("");
    setLastExit(null);

    // cwd：当前远程工作区根（若是该设备的），否则远端主目录
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

  const activeEntry = activeTermId ? termsRef.current.get(activeTermId) : undefined;

  return (
    <div className="flex h-full flex-col border-t border-zinc-800 bg-zinc-950">
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
          <span className={lastExit.code === 0 ? "text-emerald-500" : "text-red-400"}>
            退出码 {lastExit.code}
          </span>
        )}
        <button onClick={onClose} className="px-1 text-zinc-500 hover:text-zinc-300" title="关闭面板">
          <IconClose size={13} />
        </button>
      </div>

      {tab === "terminal" && (
        <div className="flex min-h-0 flex-1">
          <div className="w-40 shrink-0 overflow-y-auto border-r border-zinc-800 p-1.5">
            <p className="px-1 pb-1 text-[11px] text-zinc-600">活动会话</p>
            {sessions.length === 0 && (
              <p className="px-1 py-1 text-xs text-zinc-600">无 SSH 会话，请先在「远程设备」连接</p>
            )}
            {sessions.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => void createTerminal(s)}
                disabled={termsRef.current.has(s.sessionId)}
                className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${
                  activeTermId === s.sessionId
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-900"
                } ${termsRef.current.has(s.sessionId) ? "opacity-60" : ""}`}
                title={`${s.deviceName || "未命名设备"} · ${s.endpoint}`}
              >
                {termsRef.current.has(s.sessionId) ? "● " : "+ "}
                {s.deviceName || "未命名设备"}
              </button>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            {terms.length === 0 ? (
              <p className="p-3 text-xs text-zinc-600">点击左侧会话创建终端（远程 PTY shell）</p>
            ) : (
              <div ref={containerRef} className="absolute inset-0 p-1" />
            )}
          </div>
        </div>
      )}

      {tab === "tasks" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5 border-b border-zinc-800 px-2 py-1.5">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !running) void runTask();
              }}
              placeholder="远程构建命令（如 colcon build --symlink-install）"
              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-200 outline-none focus:border-sky-600"
            />
            <button
              onClick={() => void runTask()}
              disabled={running || sessions.length === 0}
              className="rounded bg-sky-600 px-2.5 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {running ? "运行中…" : "运行"}
            </button>
          </div>
          <div
            ref={outputRef}
            className="flex-1 overflow-y-auto p-2 font-mono text-xs leading-relaxed"
          >
            <pre className="select-text whitespace-pre-wrap text-zinc-300">
              {taskOutput || "输出将显示在此处（stderr 以红色标注于问题列表）"}
            </pre>
          </div>
        </div>
      )}

      {tab === "problems" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {problems.length === 0 ? (
            <p className="px-1 py-1 text-xs text-zinc-600">暂无问题（运行任务后自动解析 GCC/Clang/Python 错误）</p>
          ) : (
            problems.map((p, i) => (
              <button
                key={i}
                onClick={() => openProblem(p)}
                className="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-zinc-900"
                title={p.raw}
              >
                <span className={p.severity === "error" ? "text-red-400" : p.severity === "warning" ? "text-amber-400" : "text-zinc-500"}>
                  {p.severity === "error" ? "✖" : p.severity === "warning" ? <IconWarning size={11} className="inline" /> : "ℹ"}
                </span>{" "}
                <span className="text-zinc-400">{p.file}:{p.line}:{p.col}</span>{" "}
                <span className="text-zinc-300">{p.message}</span>
              </button>
            ))
          )}
        </div>
      )}
      {/* activeEntry 用于保持 xterm 挂载状态 */}
      <span className="hidden">{activeEntry?.info.channelId}</span>
    </div>
  );
}

function PanelTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-0.5 ${active ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      {children}
    </button>
  );
}

export { stripAnsi };
