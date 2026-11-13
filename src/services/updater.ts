import { Channel } from "@tauri-apps/api/core";
import { invokeIpc } from "../lib/ipc";

export type InstallMode = "in_place_app" | "silent_installer" | "manual";

export interface UpdateCheckResultDto {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseName: string;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string;
  assetName: string | null;
  assetUrl: string | null;
  assetSize: number | null;
  assetDigest?: string | null;
  platform: string;
  installMode: InstallMode;
}

export interface DownloadInstallerResultDto {
  savedPath: string;
  size: number;
  alreadyExisted: boolean;
  installMode: InstallMode;
}

export interface UpdateDownloadProgressDto {
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  status: "downloading" | "completed" | "cancelled" | "failed";
}

export const updaterApi = {
  async checkGithubUpdate(): Promise<UpdateCheckResultDto> {
    return invokeIpc<UpdateCheckResultDto>("check_github_update");
  },

  async downloadInstaller(
    url: string,
    fileName: string,
    expectedSize?: number | null,
    onProgress?: (ev: UpdateDownloadProgressDto) => void,
    expectedDigest?: string | null,
  ): Promise<DownloadInstallerResultDto> {
    const channel = new Channel<UpdateDownloadProgressDto>();
    if (onProgress) {
      channel.onmessage = onProgress;
    }
    return invokeIpc<DownloadInstallerResultDto>("download_update_installer", {
      url,
      fileName,
      expectedSize: expectedSize ?? null,
      expectedDigest: expectedDigest ?? null,
      onEvent: channel,
    });
  },

  async cancelDownload(): Promise<boolean> {
    return invokeIpc<boolean>("cancel_update_download");
  },

  async applyUpdateAndRestart(path: string): Promise<boolean> {
    return invokeIpc<boolean>("apply_update_and_restart", { path });
  },

  async openDownloadedInstaller(path: string, revealOnly = false): Promise<void> {
    return invokeIpc("open_downloaded_installer", { path, revealOnly });
  },

  async openExternalUrl(url: string): Promise<void> {
    return invokeIpc("open_external_url", { url });
  },
};
