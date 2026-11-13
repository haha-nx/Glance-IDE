import { Channel } from "@tauri-apps/api/core";
import { invokeIpc } from "../lib/ipc";
import type { WslDistroDto } from "../types/wsl";
import type { TerminalEvent, TaskResult } from "./terminal";

export const wslApi = {
  async isAvailable(): Promise<boolean> {
    try {
      return await invokeIpc<boolean>("wsl_is_available");
    } catch {
      return false;
    }
  },

  async listDistros(): Promise<WslDistroDto[]> {
    return await invokeIpc<WslDistroDto[]>("wsl_list_distros");
  },

  async getHome(distro: string): Promise<string> {
    return await invokeIpc<string>("wsl_distro_home", { distro });
  },

  async runTask(
    distro: string,
    cwd: string,
    command: string,
    label: string,
    onOutput: (event: TerminalEvent) => void,
  ): Promise<TaskResult> {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onOutput;
    return await invokeIpc<TaskResult>("wsl_run_task", {
      distro,
      cwd,
      command,
      label,
      onOutput: channel,
    });
  },
};
