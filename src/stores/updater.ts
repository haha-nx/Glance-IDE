import { create } from "zustand";
import {
  updaterApi,
  type DownloadInstallerResultDto,
  type UpdateCheckResultDto,
  type UpdateDownloadProgressDto,
} from "../services/updater";
import { settingsStore } from "./settings";

export interface UpdaterState {
  checking: boolean;
  downloading: boolean;
  applying: boolean;
  lastCheckedAt: number | null;
  result: UpdateCheckResultDto | null;
  downloadResult: DownloadInstallerResultDto | null;
  downloadProgress: UpdateDownloadProgressDto | null;
  error: string | null;
  /** 仅当自动检测发现更新或手动触发后决定是否展示浮层通知 */
  promptVisible: boolean;

  checkForUpdates(options?: { manual?: boolean }): Promise<UpdateCheckResultDto | null>;
  downloadLatestInstaller(): Promise<DownloadInstallerResultDto | null>;
  cancelDownload(): Promise<void>;
  applyUpdate(path?: string): Promise<boolean>;
  dismissPrompt(): void;
}

export function requestApplyUpdate(savedPath: string) {
  window.dispatchEvent(new CustomEvent("glance:apply-update", { detail: { savedPath } }));
}

export const updaterStore = create<UpdaterState>()((set, get) => ({
  checking: false,
  downloading: false,
  applying: false,
  lastCheckedAt: null,
  result: null,
  downloadResult: null,
  downloadProgress: null,
  error: null,
  promptVisible: false,

  checkForUpdates: async (options) => {
    const manual = options?.manual ?? false;
    if (!manual && !settingsStore.getState().autoCheckUpdate) {
      return null;
    }
    if (get().checking) return get().result;

    set({ checking: true, error: null });
    try {
      const res = await updaterApi.checkGithubUpdate();
      const sameVersion = get().result?.latestVersion === res.latestVersion;
      set({
        checking: false,
        result: res,
        lastCheckedAt: Date.now(),
        error: null,
        downloadResult: sameVersion ? get().downloadResult : null,
        downloadProgress: sameVersion ? get().downloadProgress : null,
        promptVisible: !manual && res.hasUpdate ? true : get().promptVisible,
      });

      if (
        res.hasUpdate &&
        res.assetUrl &&
        res.assetName &&
        settingsStore.getState().autoDownloadUpdate
      ) {
        void get().downloadLatestInstaller();
      }
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        checking: false,
        error: manual ? message : null,
        lastCheckedAt: Date.now(),
      });
      return null;
    }
  },

  downloadLatestInstaller: async () => {
    const res = get().result;
    if (!res?.assetUrl || !res.assetName || get().downloading) return null;

    set({
      downloading: true,
      error: null,
      downloadProgress: {
        downloadedBytes: 0,
        totalBytes: res.assetSize ?? 0,
        speedBytesPerSec: 0,
        status: "downloading",
      },
    });

    try {
      const dl = await updaterApi.downloadInstaller(
        res.assetUrl,
        res.assetName,
        res.assetSize,
        (progress) => set({ downloadProgress: progress }),
        res.assetDigest ?? null,
      );
      set({ downloading: false, downloadResult: dl });
      return dl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isCancelled = message.includes("已取消");
      set({
        downloading: false,
        downloadProgress: isCancelled ? null : get().downloadProgress,
        error: isCancelled ? null : message,
      });
      return null;
    }
  },

  cancelDownload: async () => {
    try {
      await updaterApi.cancelDownload();
    } catch {
      /* 忽略未在下载状态的取消竞态 */
    }
  },

  applyUpdate: async (path) => {
    const targetPath = path ?? get().downloadResult?.savedPath;
    if (!targetPath || get().applying) return false;
    set({ applying: true, error: null });
    try {
      const restarting = await updaterApi.applyUpdateAndRestart(targetPath);
      set({ applying: false });
      return restarting;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ applying: false, error: message });
      return false;
    }
  },

  dismissPrompt: () => set({ promptVisible: false }),
}));
