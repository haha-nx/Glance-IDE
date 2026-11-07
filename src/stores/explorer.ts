import { create } from "zustand";
import type { FileEntryDto } from "../types/ipc";
import { filesApi } from "../services/files";

/**
 * 文件树状态：childrenMap 缓存目录列表，按需懒加载。
 * rootPath 持久化到 localStorage（非敏感，路线图 §9.1 ui_state）。
 */

const ROOT_KEY = "glance.recentRoot";

function sortEntries(entries: FileEntryDto[]): FileEntryDto[] {
  return [...entries].sort((a, b) => {
    const dirDiff =
      (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1);
    if (dirDiff !== 0) return dirDiff;
    return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
  });
}

interface ExplorerState {
  rootPath: string | null;
  rootError: string | null;
  /** 目录路径 → 已排序列表 */
  childrenMap: Record<string, FileEntryDto[]>;
  expanded: Record<string, boolean>;
  selectedPath: string | null;
  loadingDirs: Record<string, boolean>;

  openRoot(path: string): Promise<void>;
  closeRoot(): void;
  ensureLoaded(path: string): Promise<void>;
  toggleDir(path: string): Promise<void>;
  refresh(path: string): Promise<void>;
  refreshParentOf(path: string): Promise<void>;
  select(path: string | null): void;
  parentOf(path: string): string | null;
}

export const explorerStore = create<ExplorerState>()((set, get) => ({
  rootPath: localStorage.getItem(ROOT_KEY),
  rootError: null,
  childrenMap: {},
  expanded: {},
  selectedPath: null,
  loadingDirs: {},

  openRoot: async (path) => {
    localStorage.setItem(ROOT_KEY, path);
    set({ rootPath: path, rootError: null, childrenMap: {}, expanded: { [path]: true } });
    await get().ensureLoaded(path);
  },

  closeRoot: () => {
    localStorage.removeItem(ROOT_KEY);
    set({ rootPath: null, childrenMap: {}, expanded: {}, selectedPath: null, rootError: null });
  },

  ensureLoaded: async (path) => {
    const state = get();
    if (state.childrenMap[path] || state.loadingDirs[path]) return;
    set((s) => ({ loadingDirs: { ...s.loadingDirs, [path]: true } }));
    try {
      const entries = await filesApi.listDir(path);
      set((s) => ({
        childrenMap: { ...s.childrenMap, [path]: sortEntries(entries) },
        loadingDirs: { ...s.loadingDirs, [path]: false },
      }));
    } catch (err) {
      set((s) => ({
        loadingDirs: { ...s.loadingDirs, [path]: false },
        rootError: path === s.rootPath ? String(err) : s.rootError,
        childrenMap: { ...s.childrenMap, [path]: [] },
      }));
    }
  },

  toggleDir: async (path) => {
    const isExpanded = get().expanded[path];
    if (isExpanded) {
      set((s) => ({ expanded: { ...s.expanded, [path]: false } }));
    } else {
      set((s) => ({ expanded: { ...s.expanded, [path]: true } }));
      await get().ensureLoaded(path);
    }
  },

  refresh: async (path) => {
    set((s) => {
      const next = { ...s.childrenMap };
      delete next[path];
      return { childrenMap: next };
    });
    await get().ensureLoaded(path);
  },

  refreshParentOf: async (path) => {
    const parent = get().parentOf(path);
    if (parent && get().childrenMap[parent]) {
      await get().refresh(parent);
    }
  },

  select: (path) => set({ selectedPath: path }),

  parentOf: (path) => {
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return null;
    return path.slice(0, idx);
  },
}));
