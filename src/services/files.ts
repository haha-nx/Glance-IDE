import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AppInfoDto,
  FileContentDto,
  FileEntryDto,
  FsErrorShape,
  WriteResultDto,
} from "../types/ipc";

/** 将 Rust 端错误还原为结构化 FsErrorShape */
export class FsError extends Error {
  readonly shape: FsErrorShape;
  constructor(shape: FsErrorShape) {
    super(shape.message);
    this.name = "FsError";
    this.shape = shape;
  }
}

function wrapError(err: unknown): FsError {
  if (err && typeof err === "object" && "code" in err) {
    return new FsError(err as FsErrorShape);
  }
  return new FsError({ code: "io", message: String(err) });
}

/** 文件系统 IPC 封装 */
export const filesApi = {
  async listDir(path: string): Promise<FileEntryDto[]> {
    try {
      return await invoke<FileEntryDto[]>("list_dir", { path });
    } catch (err) {
      throw wrapError(err);
    }
  },

  async readFile(path: string): Promise<FileContentDto> {
    try {
      return await invoke<FileContentDto>("read_file", { path });
    } catch (err) {
      throw wrapError(err);
    }
  },

  async writeFile(
    path: string,
    content: string,
    expectedMtimeMs: number | null,
  ): Promise<WriteResultDto> {
    try {
      return await invoke<WriteResultDto>("write_file", {
        path,
        content,
        expectedMtimeMs,
      });
    } catch (err) {
      throw wrapError(err);
    }
  },

  async createDir(path: string): Promise<void> {
    try {
      await invoke("create_dir", { path });
    } catch (err) {
      throw wrapError(err);
    }
  },

  async createFile(path: string): Promise<void> {
    try {
      await invoke("create_file", { path });
    } catch (err) {
      throw wrapError(err);
    }
  },

  async renameEntry(from: string, to: string): Promise<void> {
    try {
      await invoke("rename_entry", { from, to });
    } catch (err) {
      throw wrapError(err);
    }
  },

  async deleteEntry(path: string, recursive = false): Promise<void> {
    try {
      await invoke("delete_entry", { path, recursive });
    } catch (err) {
      throw wrapError(err);
    }
  },
};

export const appApi = {
  async getInfo(): Promise<AppInfoDto> {
    return invoke<AppInfoDto>("get_app_info");
  },

  async exitApp(): Promise<void> {
    try {
      await invoke("exit_app");
    } catch {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().destroy();
    }
  },

  async closeWindow(): Promise<void> {
    try {
      await invoke("close_window");
    } catch {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().destroy();
    }
  },

  async openNewWindow(profileId?: string, wslDistro?: string, folderPath?: string): Promise<void> {
    try {
      await invoke("open_new_window", {
        profileId: profileId || null,
        wslDistro: wslDistro || null,
        folderPath: folderPath || null,
      });
    } catch (err) {
      console.error("新建窗口失败:", err);
    }
  },
};

export type TransferDirection = "upload" | "download";
export type TransferStatus =
  | "scanning"
  | "transferring"
  | "completed"
  | "failed"
  | "cancelled";
export type ConflictPolicy = "overwrite" | "skip";

export interface TransferConflictDto {
  name: string;
  destPath: string;
  isDir: boolean;
}

export interface TransferProgressDto {
  taskId: string;
  direction: TransferDirection;
  status: TransferStatus;
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  transferredBytes: number;
  currentFile: string;
  speedBytesPerSec: number;
  error?: string | null;
}

export interface TransferResultDto {
  taskId: string;
  direction: TransferDirection;
  status: TransferStatus;
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  transferredBytes: number;
  destPaths: string[];
  error?: string | null;
}

export const transferApi = {
  async checkConflicts(
    items: string[],
    targetDirUri: string,
  ): Promise<TransferConflictDto[]> {
    return invoke<TransferConflictDto[]>("check_transfer_conflicts", {
      items,
      targetDirUri,
    });
  },

  async upload(
    taskId: string,
    sourceLocalPaths: string[],
    targetDirUri: string,
    conflictPolicy: ConflictPolicy,
    onProgress: (ev: TransferProgressDto) => void,
  ): Promise<TransferResultDto> {
    const channel = new Channel<TransferProgressDto>();
    channel.onmessage = onProgress;
    return invoke<TransferResultDto>("upload_to_workspace", {
      taskId,
      sourceLocalPaths,
      targetDirUri,
      conflictPolicy,
      onEvent: channel,
    });
  },

  async download(
    taskId: string,
    sourceUris: string[],
    destDirPath: string | null,
    destFilePath: string | null,
    conflictPolicy: ConflictPolicy,
    onProgress: (ev: TransferProgressDto) => void,
  ): Promise<TransferResultDto> {
    const channel = new Channel<TransferProgressDto>();
    channel.onmessage = onProgress;
    return invoke<TransferResultDto>("download_from_workspace", {
      taskId,
      sourceUris,
      destDirPath,
      destFilePath,
      conflictPolicy,
      onEvent: channel,
    });
  },

  async cancel(taskId: string): Promise<boolean> {
    return invoke<boolean>("cancel_transfer", { taskId });
  },

  async revealLocalPath(path: string): Promise<void> {
    return invoke("reveal_local_path", { path });
  },
};
