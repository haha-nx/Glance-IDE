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
    // 处理 remote://<uuid><subpath> 与 wsl://<distro><subpath>
    const schemeMatch = path.match(/^((?:remote|wsl):\/\/[^/]+)(.*)$/);
    if (schemeMatch) {
      const prefix = schemeMatch[1];
      let sub = schemeMatch[2].replace(/\\/g, "/");
      if (sub.length > 1 && sub.endsWith("/")) sub = sub.slice(0, -1);
      if (!sub || sub === "/") return null;
      const idx = sub.lastIndexOf("/");
      if (idx <= 0) return `${prefix}/`;
      return `${prefix}${sub.slice(0, idx)}`;
    }
    // 处理 Windows 驱动器/UNC 或 POSIX 本地路径
    const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
    let trimmed = path;
    if (trimmed.length > 1 && (trimmed.endsWith("/") || trimmed.endsWith("\\"))) {
      trimmed = trimmed.slice(0, -1);
    }
    if (/^[A-Za-z]:$/.test(trimmed)) return null;
    const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    if (idx < 0) return null;
    if (idx === 0) return "/";
    const parent = trimmed.slice(0, idx);
    if (/^[A-Za-z]:$/.test(parent)) return `${parent}${sep}`;
    return parent;
  },
}));

/** 安全拼接目录路径与子项名，避免根路径下出现双斜杠 `remote://uuid//foo` */
export function joinChildPath(dir: string, name: string): string {
  const cleanName = name.replace(/^[/\\]+/, "");
  if (dir.startsWith("remote://") || dir.startsWith("wsl://") || dir.startsWith("local://")) {
    const cleanDir = dir.endsWith("/") ? dir.slice(0, -1) : dir;
    return `${cleanDir}/${cleanName}`;
  }
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const cleanDir =
    dir.length > 1 && (dir.endsWith("/") || dir.endsWith("\\")) ? dir.slice(0, -1) : dir;
  if (cleanDir === "/" || cleanDir === "\\") return `${cleanDir}${cleanName}`;
  return `${cleanDir}${sep}${cleanName}`;
}
