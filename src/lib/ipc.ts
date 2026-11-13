import { invoke } from "@tauri-apps/api/core";
import { wrapCmdError } from "../types/ssh";

/** 统一调用 Tauri IPC 并将底层结构化或字符串错误包装为 CmdError（Error 子类）。 */
export async function invokeIpc<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw wrapCmdError(err);
  }
}
