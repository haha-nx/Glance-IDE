import { create } from "zustand";
import {
  updaterApi,
  type DownloadInstallerResultDto,
  type UpdateCheckResultDto,
} from "../services/updater";
import { settingsStore } from "./settings";

export interface UpdaterState {
  checking: boolean;
  downloading: boolean;
  lastCheckedAt: number | null;
  result: UpdateCheckResultDto | null;
  downloadResult: DownloadInstallerResultDto | null;
  error: string | null;
  /** 仅当自动检测发现更新或手动触发后决定是否展示浮层通知 */
  promptVisible: boolean;

  checkForUpdates(options?: { manual?: boolean }): Promise<UpdateCheckResultDto | null>;
  downloadLatestInstaller(): Promise<DownloadInstallerResultDto | null>;
  dismissPrompt(): void;
}

export const updaterStore = create<UpdaterState>()((set, get) => ({
  checking: false,
  downloading: false,
  lastCheckedAt: null,
  result: null,
  downloadResult: null,
  error: null,
  promptVisible: false,

  checkForUpdates: async (options) => {
    const manual = options?.manual ?? false;
    // 防御性校验：除非用户手动检查更新，否则当自动检测开关关闭时绝不发起网络请求或推送通知
    if (!manual && !settingsStore.getState().autoCheckUpdate) {
      return null;
    }
    if (get().checking) return get().result;

    set({ checking: true, error: null });
    try {
      const res = await updaterApi.checkGithubUpdate();
      set({
        checking: false,
        result: res,
        lastCheckedAt: Date.now(),
        error: null,
        downloadResult:
          get().result?.latestVersion === res.latestVersion ? get().downloadResult : null,
        promptVisible: !manual && res.hasUpdate ? true : get().promptVisible,
      });

      // 若发现新版本且开启了自动下载安装包，自动拉取当前系统匹配的安装包
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

    set({ downloading: true, error: null });
    try {
      const dl = await updaterApi.downloadInstaller(res.assetUrl, res.assetName, res.assetSize);
      set({ downloading: false, downloadResult: dl });
      return dl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ downloading: false, error: message });
      return null;
    }
  },

  dismissPrompt: () => set({ promptVisible: false }),
}));
