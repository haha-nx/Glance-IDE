import { Channel, invoke } from "@tauri-apps/api/core";
import { wrapCmdError } from "../types/ssh";

/** Rust 端 terminal.rs 推送的消息 */
export type TerminalEvent =
  | { type: "data"; bytes: string }
  | { type: "stderr"; bytes: string }
  | { type: "stdout"; bytes: string }
  | { type: "closed"; error?: string }
  | { type: "exit"; code: number };

export interface TerminalInfo {
  channelId: string;
  sessionId: string;
}

export interface TaskResult {
  exitCode: number;
  durationMs: number;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const terminalApi = {
  /** 打开 SSH PTY 终端；onEvent 在 invoke 返回前后都会收到推送 */
  async open(
    sessionId: string,
    cols: number,
    rows: number,
    onEvent: (e: TerminalEvent) => void,
  ): Promise<TerminalInfo> {
    const channel = new Channel<TerminalEvent>(onEvent);
    try {
      return await invoke<TerminalInfo>("terminal_open", {
        sessionId,
        cols,
        rows,
        onData: channel,
      });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  /** 打开本机系统终端（PowerShell / Bash） */
  async openLocal(
    cwd: string | null,
    onEvent: (e: TerminalEvent) => void,
  ): Promise<TerminalInfo> {
    const channel = new Channel<TerminalEvent>(onEvent);
    try {
      return await invoke<TerminalInfo>("terminal_open_local", {
        cwd: cwd || null,
        onData: channel,
      });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  /** 打开 WSL 终端 */
  async openWsl(
    distro: string,
    cwd: string | null,
    onEvent: (e: TerminalEvent) => void,
  ): Promise<TerminalInfo> {
    const channel = new Channel<TerminalEvent>(onEvent);
    try {
      return await invoke<TerminalInfo>("terminal_open_wsl", {
        distro,
        cwd: cwd || null,
        onData: channel,
      });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async write(channelId: string, data: string): Promise<boolean> {
    try {
      return await invoke<boolean>("terminal_write", { channelId, data });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async resize(channelId: string, cols: number, rows: number): Promise<boolean> {
    try {
      return await invoke<boolean>("terminal_resize", { channelId, cols, rows });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async close(channelId: string): Promise<void> {
    try {
      await invoke("terminal_close", { channelId });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  /** 运行远程构建任务（无 PTY），输出经 Channel 推送 */
  async runTask(
    sessionId: string,
    cwd: string,
    command: string,
    label: string,
    onEvent: (e: TerminalEvent) => void,
  ): Promise<TaskResult> {
    const channel = new Channel<TerminalEvent>(onEvent);
    try {
      return await invoke<TaskResult>("run_remote_task", {
        sessionId,
        cwd,
        command,
        label,
        onOutput: channel,
      });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async remoteHome(sessionId: string): Promise<string> {
    try {
      return await invoke<string>("remote_home", { sessionId });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },
};

export { base64ToBytes };
