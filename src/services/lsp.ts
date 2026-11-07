import { Channel, invoke } from "@tauri-apps/api/core";
import { wrapCmdError } from "../types/ssh";

/** Rust 端 lsp.rs 推送的事件（§6.4 传输桥） */
export type LspEvent =
  | { type: "message"; message: unknown }
  | { type: "stderr"; text: string }
  | { type: "closed"; reason: string | null };

export interface LspOpenInfo {
  lspId: string;
  deviceIdentityId: string;
}

export const lspApi = {
  /**
   * 打开远程语言服务器通道（exec 无 PTY，Rust 侧组帧）。
   * onEvent 在 invoke 返回前后都会收到推送。
   */
  async open(
    sessionId: string,
    workspaceRoot: string,
    language: string,
    server: string,
    args: string[],
    onEvent: (e: LspEvent) => void,
  ): Promise<LspOpenInfo> {
    const channel = new Channel<LspEvent>(onEvent);
    try {
      return await invoke<LspOpenInfo>("lsp_open", {
        sessionId,
        workspaceRoot,
        language,
        server,
        args,
        onEvent: channel,
      });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  /** 发送一条 JSON-RPC 消息（Rust 组帧后写入远程 stdin） */
  async send(lspId: string, message: unknown): Promise<boolean> {
    try {
      return await invoke<boolean>("lsp_send", { lspId, message });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async close(lspId: string): Promise<void> {
    try {
      await invoke("lsp_close", { lspId });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },
};
