import { invoke } from "@tauri-apps/api/core";

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
  platform: string;
}

export interface DownloadInstallerResultDto {
  savedPath: string;
  size: number;
  alreadyExisted: boolean;
}

export const updaterApi = {
  async checkGithubUpdate(): Promise<UpdateCheckResultDto> {
    return invoke<UpdateCheckResultDto>("check_github_update");
  },

  async downloadInstaller(
    url: string,
    fileName: string,
    expectedSize?: number | null,
  ): Promise<DownloadInstallerResultDto> {
    return invoke<DownloadInstallerResultDto>("download_update_installer", {
      url,
      fileName,
      expectedSize: expectedSize ?? null,
    });
  },

  async openDownloadedInstaller(path: string, revealOnly = false): Promise<void> {
    return invoke("open_downloaded_installer", { path, revealOnly });
  },

  async openExternalUrl(url: string): Promise<void> {
    return invoke("open_external_url", { url });
  },
};
