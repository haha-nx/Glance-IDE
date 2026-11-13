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

function normalizeComparePath(raw: string): string {
  const schemeMatch = raw.match(/^((?:remote|wsl):\/\/[^/]+)(.*)$/);
  if (schemeMatch) {
    const auth = schemeMatch[1];
    let sub = schemeMatch[2].replace(/\\/g, "/");
    if (!sub || sub === "/") return `${auth}/`;
    if (!sub.startsWith("/")) sub = `/${sub}`;
    if (sub.length > 1 && sub.endsWith("/")) sub = sub.slice(0, -1);
    return `${auth}${sub}`;
  }
  let p = raw.replace(/\\/g, "/");
  if (p.length > 1 && p.endsWith("/") && !/^[A-Za-z]:\/$/.test(p)) {
    p = p.slice(0, -1);
  }
  return p;
}

function isSelfOrDescendant(parent: string, candidate: string): boolean {
  const p = normalizeComparePath(parent);
  const c = normalizeComparePath(candidate);
  if (c === p) return true;
  if (p.endsWith("/")) return c.startsWith(p);
  return c.startsWith(`${p}/`);
}

let workspaceGen = 0;
let activeRefreshCount = 0;

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
  refresh(path: string, opts?: { silent?: boolean }): Promise<void>;
  refreshParentOf(path: string): Promise<void>;
  /** 清空指定远程设备（缺省时为全部远程设备）的目录缓存 */
  invalidateRemote(deviceIdentityId?: string): void;
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
    workspaceGen += 1;
    localStorage.setItem(ROOT_KEY, path);
    if (!path.startsWith("remote://")) {
      void workspaceApi.setUiState("workspace.lastSshProfileId", "").catch(() => {});
      localStorage.removeItem("glance.lastSshProfileId");
    }
    set({
      rootPath: path,
      rootError: null,
      childrenMap: {},
      expanded: { [path]: true },
      loadingDirs: {},
    });
    await get().ensureLoaded(path);
  },

  closeRoot: () => {
    workspaceGen += 1;
    localStorage.removeItem(ROOT_KEY);
    void workspaceApi.setUiState("workspace.root", "").catch(() => {});
    void workspaceApi.setUiState("workspace.lastSshProfileId", "").catch(() => {});
    localStorage.removeItem("glance.lastSshProfileId");
    set({
      rootPath: null,
      childrenMap: {},
      expanded: {},
      selectedPath: null,
      rootError: null,
      loadingDirs: {},
    });
  },

  ensureLoaded: async (path) => {
    const gen = workspaceGen;
    const state = get();
    if (state.childrenMap[path] || state.loadingDirs[path]) return;
    set((s) => ({ loadingDirs: { ...s.loadingDirs, [path]: true } }));
    try {
      const entries = await filesApi.listDir(path);
      if (gen !== workspaceGen) return;
      set((s) => ({
        childrenMap: { ...s.childrenMap, [path]: sortEntries(entries) },
        loadingDirs: { ...s.loadingDirs, [path]: false },
      }));
    } catch (err) {
      if (gen !== workspaceGen) return;
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

  refresh: async (path, opts) => {
    const silent = opts?.silent ?? false;
    if (!path) return;
    const gen = workspaceGen;
    const { rootPath, loadingDirs, childrenMap, expanded } = get();
    if (silent && (loadingDirs[path] || activeRefreshCount > 0)) return;

    // 尚未加载过的目录在非静默刷新时走首次加载；静默刷新不强行拉取未加载分支
    if (!childrenMap[path]) {
      if (!silent) {
        await get().ensureLoaded(path);
      }
      return;
    }

    activeRefreshCount += 1;
    if (!silent) {
      set((s) => ({
        loadingDirs: { ...s.loadingDirs, [path]: true },
        rootError: path === s.rootPath ? null : s.rootError,
      }));
    }

    try {
      const updatedChildren: Record<string, FileEntryDto[]> = {};
      const refreshedParents = new Set<string>();
      const seenDirs = new Set<string>();
      let currentLayer = [path];
      let rootFailed: string | null = null;

      // 按层级并行刷新目标目录及所有可见展开的子目录，保证外部（终端/SSH/WSL）删改能递归同步
      while (currentLayer.length > 0) {
        const nextLayer: string[] = [];
        const results = await Promise.allSettled(
          currentLayer.map(async (dir) => {
            const entries = await filesApi.listDir(dir);
            return { dir, entries: sortEntries(entries) };
          }),
        );

        if (gen !== workspaceGen || get().rootPath !== rootPath) return;

        for (let i = 0; i < currentLayer.length; i += 1) {
          const dir = currentLayer[i];
          const res = results[i];
          if (res.status === "fulfilled") {
            const sorted = res.value.entries;
            updatedChildren[dir] = sorted;
            refreshedParents.add(normalizeComparePath(dir));
            for (const entry of sorted) {
              if (entry.kind === "dir") {
                seenDirs.add(normalizeComparePath(entry.path));
                if (expanded[entry.path]) {
                  nextLayer.push(entry.path);
                }
              }
            }
          } else if (dir === path) {
            rootFailed = String(res.reason);
          }
        }

        if (rootFailed !== null) break;
        currentLayer = nextLayer;
      }

      if (gen !== workspaceGen || get().rootPath !== rootPath) return;

      if (rootFailed !== null) {
        if (!silent) {
          set((s) => ({
            loadingDirs: { ...s.loadingDirs, [path]: false },
            rootError: path === s.rootPath ? rootFailed : s.rootError,
          }));
        }
        return;
      }

      const pathNorm = normalizeComparePath(path);
      const isDeletedUnderRefresh = (candidate: string): boolean => {
        const candNorm = normalizeComparePath(candidate);
        if (candNorm === pathNorm || !isSelfOrDescendant(path, candidate)) return false;
        let cur: string | null = candidate;
        while (cur && normalizeComparePath(cur) !== pathNorm) {
          const parent = get().parentOf(cur);
          if (!parent) break;
          const parentNorm = normalizeComparePath(parent);
          if (refreshedParents.has(parentNorm) && !seenDirs.has(normalizeComparePath(cur))) {
            return true;
          }
          if (parentNorm === pathNorm) break;
          cur = parent;
        }
        return false;
      };

      set((s) => {
        // 清理目标子树下：已折叠（不再属于可见层）和已被删除的旧目录缓存，只保留本次重拉的最新列表
        const nextChildren: Record<string, FileEntryDto[]> = {};
        for (const [k, v] of Object.entries(s.childrenMap)) {
          if (!isSelfOrDescendant(path, k)) {
            nextChildren[k] = v;
          }
        }
        for (const [k, v] of Object.entries(updatedChildren)) {
          nextChildren[k] = v;
        }

        // 清理已被远端/终端删除的目录展开态，避免幽灵加载节点
        const nextExpanded: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(s.expanded)) {
          if (!isDeletedUnderRefresh(k)) {
            nextExpanded[k] = v;
          }
        }

        return {
          childrenMap: nextChildren,
          expanded: nextExpanded,
          loadingDirs: silent ? s.loadingDirs : { ...s.loadingDirs, [path]: false },
        };
      });
    } finally {
      activeRefreshCount = Math.max(0, activeRefreshCount - 1);
      if (!silent && gen === workspaceGen) {
        set((s) =>
          s.loadingDirs[path]
            ? { loadingDirs: { ...s.loadingDirs, [path]: false } }
            : s,
        );
      }
    }
  },

  refreshParentOf: async (path) => {
    const parent = get().parentOf(path);
    if (!parent) return;
    const parentNorm = normalizeComparePath(parent);
    const cachedKey = Object.keys(get().childrenMap).find(
      (k) => normalizeComparePath(k) === parentNorm,
    );
    if (cachedKey) {
      await get().refresh(cachedKey);
    }
  },

  invalidateRemote: (deviceIdentityId) => {
    const prefix = deviceIdentityId ? `remote://${deviceIdentityId}` : "remote://";
    set((s) => {
      const childrenMap: Record<string, FileEntryDto[]> = {};
      for (const [k, v] of Object.entries(s.childrenMap)) {
        const matches = deviceIdentityId
          ? k === prefix || k.startsWith(`${prefix}/`)
          : k.startsWith(prefix);
        if (!matches) childrenMap[k] = v;
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
