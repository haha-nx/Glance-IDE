import { create } from "zustand";
import { workspaceApi } from "../services/workspace";

export type AppTheme = "dark" | "midnight" | "nord" | "light";

export interface ThemeMeta {
  id: AppTheme;
  name: string;
  desc: string;
  swatchBg: string;
  swatchPanel: string;
  swatchAccent: string;
  swatchText: string;
}

export const APP_THEMES: ThemeMeta[] = [
  {
    id: "dark",
    name: "Glance Dark",
    desc: "默认深色护眼工作台",
    swatchBg: "#18181b",
    swatchPanel: "#232327",
    swatchAccent: "#38bdf8",
    swatchText: "#d4d4d8",
  },
  {
    id: "midnight",
    name: "Midnight Blue",
    desc: "沉稳午夜深蓝配色",
    swatchBg: "#111827",
    swatchPanel: "#1e293b",
    swatchAccent: "#38bdf8",
    swatchText: "#cbd5e1",
  },
  {
    id: "nord",
    name: "Nord Polar",
    desc: "北欧冷灰柔和色调",
    swatchBg: "#2e3440",
    swatchPanel: "#3b4252",
    swatchAccent: "#88c0d0",
    swatchText: "#d8dee9",
  },
  {
    id: "light",
    name: "Glance Light",
    desc: "明亮清爽浅色主题",
    swatchBg: "#ffffff",
    swatchPanel: "#f1f5f9",
    swatchAccent: "#0284c7",
    swatchText: "#1e293b",
  },
];

export interface AppSettings {
  fontSize: number;
  theme: AppTheme;
  /** 是否在启动时自动检测更新（默认关闭） */
  autoCheckUpdate: boolean;
  /** 检测到新版本时是否自动下载安装包（默认关闭） */
  autoDownloadUpdate: boolean;
  sidebarWidth: number;
  bottomPanelHeight: number;
}

export const SETTINGS_STORAGE_KEY = "glance.settings.v1";
const DB_SETTINGS_KEY = "settings.preferences.v1";

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  theme: "dark",
  autoCheckUpdate: false,
  autoDownloadUpdate: false,
  sidebarWidth: 288,
  bottomPanelHeight: 256,
};

export function clampFontSize(val: number): number {
  if (!Number.isFinite(val)) return DEFAULT_SETTINGS.fontSize;
  return Math.max(10, Math.min(24, Math.round(val)));
}

export function clampSidebarWidth(val: number): number {
  if (!Number.isFinite(val)) return DEFAULT_SETTINGS.sidebarWidth;
  return Math.max(180, Math.min(600, Math.round(val)));
}

export function clampBottomPanelHeight(val: number): number {
  if (!Number.isFinite(val)) return DEFAULT_SETTINGS.bottomPanelHeight;
  return Math.max(120, Math.min(640, Math.round(val)));
}

function normalizeSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const validThemes: AppTheme[] = ["dark", "midnight", "nord", "light"];
  const theme = raw?.theme && validThemes.includes(raw.theme) ? raw.theme : DEFAULT_SETTINGS.theme;
  return {
    fontSize: clampFontSize(raw?.fontSize ?? DEFAULT_SETTINGS.fontSize),
    theme,
    autoCheckUpdate: Boolean(raw?.autoCheckUpdate ?? DEFAULT_SETTINGS.autoCheckUpdate),
    autoDownloadUpdate: Boolean(raw?.autoDownloadUpdate ?? DEFAULT_SETTINGS.autoDownloadUpdate),
    sidebarWidth: clampSidebarWidth(raw?.sidebarWidth ?? DEFAULT_SETTINGS.sidebarWidth),
    bottomPanelHeight: clampBottomPanelHeight(
      raw?.bottomPanelHeight ?? DEFAULT_SETTINGS.bottomPanelHeight,
    ),
  };
}

function readLocalSettings(): AppSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return null;
  }
}

export function applyDomSettings(settings: AppSettings): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", settings.theme);
  document.documentElement.style.setProperty("--glance-font-size", `${settings.fontSize}px`);
  // 同步 macOS 原生标题栏外观：红绿灯按钮底色跟随窗口 theme，
  // 否则深色界面里会留下浅色底块，浅色主题下又反过来。
  if (typeof navigator !== "undefined" && /Mac OS X|Macintosh/.test(navigator.userAgent)) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().setTheme(settings.theme === "light" ? "light" : "dark"),
      )
      .catch(() => {
        /* 非 Tauri 环境或权限缺失时忽略 */
      });
  }
}

function persistSettings(settings: AppSettings, syncDb = true): void {
  const serialized = JSON.stringify(settings);
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, serialized);
  } catch {
    /* ignore */
  }
  if (syncDb) {
    void workspaceApi.setUiState(DB_SETTINGS_KEY, serialized).catch(() => {});
  }
}

interface SettingsState extends AppSettings {
  hydrated: boolean;
  updateSettings(patch: Partial<AppSettings>, persistDb?: boolean): void;
  setSidebarWidth(width: number, commitDb?: boolean): void;
  setBottomPanelHeight(height: number, commitDb?: boolean): void;
  hydrate(): Promise<AppSettings>;
  resetAppearance(): void;
}

const initial = readLocalSettings() ?? DEFAULT_SETTINGS;
applyDomSettings(initial);

let hydratePromise: Promise<AppSettings> | null = null;

export const settingsStore = create<SettingsState>()((set, get) => ({
  ...initial,
  hydrated: false,

  updateSettings: (patch, persistDb = true) => {
    const cur = get();
    const next = normalizeSettings({
      fontSize: patch.fontSize ?? cur.fontSize,
      theme: patch.theme ?? cur.theme,
      autoCheckUpdate: patch.autoCheckUpdate ?? cur.autoCheckUpdate,
      autoDownloadUpdate: patch.autoDownloadUpdate ?? cur.autoDownloadUpdate,
      sidebarWidth: patch.sidebarWidth ?? cur.sidebarWidth,
      bottomPanelHeight: patch.bottomPanelHeight ?? cur.bottomPanelHeight,
    });
    applyDomSettings(next);
    set(next);
    // 拖拽调节期间仅更新内存态与 DOM，松手提交后再持久化（避免高频触发多窗口 storage 事件）
    if (persistDb) {
      persistSettings(next, true);
    }
  },

  setSidebarWidth: (width, commitDb = false) => {
    get().updateSettings({ sidebarWidth: clampSidebarWidth(width) }, commitDb);
  },

  setBottomPanelHeight: (height, commitDb = false) => {
    get().updateSettings({ bottomPanelHeight: clampBottomPanelHeight(height) }, commitDb);
  },

  resetAppearance: () => {
    get().updateSettings({
      fontSize: DEFAULT_SETTINGS.fontSize,
      theme: DEFAULT_SETTINGS.theme,
      sidebarWidth: DEFAULT_SETTINGS.sidebarWidth,
      bottomPanelHeight: DEFAULT_SETTINGS.bottomPanelHeight,
    });
  },

  hydrate: async () => {
    if (get().hydrated) {
      const s = get();
      return {
        fontSize: s.fontSize,
        theme: s.theme,
        autoCheckUpdate: s.autoCheckUpdate,
        autoDownloadUpdate: s.autoDownloadUpdate,
        sidebarWidth: s.sidebarWidth,
        bottomPanelHeight: s.bottomPanelHeight,
      };
    }
    if (hydratePromise) return hydratePromise;

    hydratePromise = (async () => {
      const local = readLocalSettings();
      let resolved = local ?? DEFAULT_SETTINGS;
      try {
        const dbRaw = await workspaceApi.getUiState(DB_SETTINGS_KEY);
        if (dbRaw) {
          const parsedDb = normalizeSettings(JSON.parse(dbRaw) as Partial<AppSettings>);
          if (!local) {
            resolved = parsedDb;
            persistSettings(resolved, false);
          }
        } else if (local) {
          persistSettings(local, true);
        }
      } catch {
        /* 数据库不可用时保留 localStorage */
      }
      applyDomSettings(resolved);
      set({ ...resolved, hydrated: true });
      return resolved;
    })();

    return hydratePromise;
  },
}));

// 多窗口之间同步全局偏好（主题、字号、更新策略），侧栏/下栏尺寸保持各窗口独立
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === SETTINGS_STORAGE_KEY && e.newValue) {
      try {
        const incoming = normalizeSettings(JSON.parse(e.newValue) as Partial<AppSettings>);
        const cur = settingsStore.getState();
        const synced: AppSettings = {
          fontSize: incoming.fontSize,
          theme: incoming.theme,
          autoCheckUpdate: incoming.autoCheckUpdate,
          autoDownloadUpdate: incoming.autoDownloadUpdate,
          sidebarWidth: cur.sidebarWidth,
          bottomPanelHeight: cur.bottomPanelHeight,
        };
        applyDomSettings(synced);
        settingsStore.setState(synced);
      } catch {
        /* ignore */
      }
    }
  });
}
