import { create } from "zustand";
import type { FileEntryDto } from "../types/ipc";
import { filesApi } from "../services/files";
import { workspaceApi } from "../services/workspace";
import { isBlankWindow } from "../lib/windowState";

/**
 * 文件树状态：childrenMap 缓存目录列表，按需懒加载。
 * rootPath 持久化到 localStorage（非敏感 ui_state）。
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
  /** 清空全部远程目录缓存（会话重连后旧数据不可信，展开态保留、按需重载） */
  invalidateRemote(): void;
  select(path: string | null): void;
  parentOf(path: string): string | null;
}

export const explorerStore = create<ExplorerState>()((set, get) => ({
  // 空白窗口不继承主窗口的工作区根目录
  rootPath: isBlankWindow() ? null : localStorage.getItem(ROOT_KEY),
  rootError: null,
  childrenMap: {},
  expanded: {},
  selectedPath: null,
  loadingDirs: {},

  openRoot: async (path) => {
    localStorage.setItem(ROOT_KEY, path);
    if (!path.startsWith("remote://")) {
      void workspaceApi.setUiState("workspace.lastSshProfileId", "").catch(() => {});
      localStorage.removeItem("glance.lastSshProfileId");
    }
    set({ rootPath: path, rootError: null, childrenMap: {}, expanded: { [path]: true } });
    await get().ensureLoaded(path);
  },

  closeRoot: () => {
    localStorage.removeItem(ROOT_KEY);
    void workspaceApi.setUiState("workspace.root", "").catch(() => {});
    void workspaceApi.setUiState("workspace.lastSshProfileId", "").catch(() => {});
    localStorage.removeItem("glance.lastSshProfileId");
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

  invalidateRemote: () => {
    set((s) => {
      const childrenMap: Record<string, FileEntryDto[]> = {};
      for (const [k, v] of Object.entries(s.childrenMap)) {
        if (!k.startsWith("remote://")) childrenMap[k] = v;
      }
      return { childrenMap };
    });
    // 已展开的远程目录由 TreeNode 的 useEffect 检测到 children 缺失后自动重载
  },

  select: (path) => set({ selectedPath: path }),

  parentOf: (path) => {
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return null;
    return path.slice(0, idx);
  },
}));
