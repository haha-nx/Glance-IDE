import { create } from "zustand";
import type { FileEntryDto } from "../types/ipc";
import { filesApi, FsError } from "../services/files";
import { getOrCreateModel, setModelValueQuiet, disposeModel, getModel, toModelUri } from "../lib/models";

/**
 * 编辑器标签页状态（仅界面状态；权威文件状态在 Rust 端）。
 * 保存流程遵循路线图 §5.4：保存前带 expectedMtimeMs 做冲突检测，冲突不静默覆盖。
 */

export interface EditorTab {
  /** 资源 URI，同时作为标签唯一 ID */
  uri: string;
  /** 本地文件系统路径（M1 全部为本地；M3 扩展为远程 URI） */
  path: string;
  name: string;
  dirty: boolean;
  /** 打开/最近一次保存后的远端 mtime（毫秒），用于保存冲突检测 */
  mtimeMs: number;
  readonly: boolean;
  /** 读取失败或二进制等占位标签 */
  error?: string;
}

export interface SaveConflict {
  uri: string;
  path: string;
  /** 远端当前 mtime */
  remoteMtimeMs: number;
}

interface TabsState {
  tabs: EditorTab[];
  activeId: string | null;
  /** 待确认关闭的脏标签 */
  pendingCloseId: string | null;
  /** 保存冲突弹窗状态 */
  pendingConflict: SaveConflict | null;
  saving: boolean;
  /** 待执行的编辑器定位（搜索跳转用） */
  pendingReveal: { uri: string; line: number } | null;

  openFile(entry: FileEntryDto): Promise<void>;
  openFileByPath(path: string): Promise<void>;
  openFileAtLine(path: string, line: number): Promise<void>;
  consumeReveal(): void;
  reopenFile(path: string, uri: string): Promise<void>;
  setActive(uri: string): void;
  markDirty(uri: string, dirty: boolean): void;
  requestClose(uri: string): void;
  /** 关闭流程：force=true 丢弃更改；返回是否已关闭 */
  confirmClose(uri: string, force: boolean): Promise<boolean>;
  cancelClose(): void;
  saveTab(uri: string, overwrite?: boolean): Promise<boolean>;
  saveAll(): Promise<boolean>;
  resolveConflictLoadRemote(): Promise<void>;
  resolveConflictOverwrite(): Promise<void>;
  dismissConflict(): void;
  hasDirty(): boolean;
}

async function readFileIntoTab(path: string, uri: string): Promise<EditorTab> {
  const name = path.split("/").pop() ?? path;
  const content = await filesApi.readFile(path);
  if (content.binary) {
    return {
      uri,
      path,
      name,
      dirty: false,
      mtimeMs: content.modifiedMs,
      readonly: true,
      error: "二进制文件暂不支持编辑",
    };
  }
  getOrCreateModel(uri, content.text ?? "", name);
  return {
    uri,
    path,
    name,
    dirty: false,
    mtimeMs: content.modifiedMs,
    readonly: false,
  };
}

export const tabsStore = create<TabsState>()((set, get) => ({
  tabs: [],
  activeId: null,
  pendingCloseId: null,
  pendingConflict: null,
  saving: false,
  pendingReveal: null,

  openFile: async (entry) => {
    if (entry.kind === "dir") return;
    const uri = toModelUri(entry.path);
    const existing = get().tabs.find((t) => t.uri === uri);
    if (existing) {
      set((s) => ({ activeId: uri, tabs: s.tabs }));
      return;
    }
    try {
      const tab = await readFileIntoTab(entry.path, uri);
      set((s) => ({ tabs: [...s.tabs, tab], activeId: uri }));
    } catch (err) {
      const message = err instanceof FsError ? err.shape.message : String(err);
      set((s) => ({
        tabs: [
          ...s.tabs,
          {
            uri,
            path: entry.path,
            name: entry.name,
            dirty: false,
            mtimeMs: 0,
            readonly: true,
            error: message,
          },
        ],
        activeId: uri,
      }));
    }
  },

  openFileByPath: async (path) => {
    await get().openFile({
      name: path.split("/").pop() ?? path,
      path,
      kind: "file",
      size: 0,
      modifiedMs: 0,
    });
  },

  openFileAtLine: async (path, line) => {
    await get().openFileByPath(path);
    const uri = toModelUri(path);
    set({ pendingReveal: { uri, line }, activeId: uri });
  },

  consumeReveal: () => set({ pendingReveal: null }),

  reopenFile: async (path, uri) => {
    // 冲突弹窗中「加载远端版本」：重新读取并静默替换 Model 内容
    try {
      const content = await filesApi.readFile(path);
      if (!content.binary) {
        setModelValueQuiet(uri, content.text ?? "");
      }
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.uri === uri
            ? { ...t, mtimeMs: content.modifiedMs, dirty: false }
            : t,
        ),
        pendingConflict: null,
      }));
    } catch (err) {
      const message = err instanceof FsError ? err.shape.message : String(err);
      set({ pendingConflict: null });
      alert(`加载远端版本失败：${message}`);
    }
  },

  setActive: (uri) => set({ activeId: uri }),

  markDirty: (uri, dirty) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.uri === uri ? { ...t, dirty } : t)),
    })),

  requestClose: (uri) => {
    const tab = get().tabs.find((t) => t.uri === uri);
    if (tab?.dirty) {
      set({ pendingCloseId: uri });
    } else {
      void get().confirmClose(uri, true);
    }
  },

  confirmClose: async (uri, force) => {
    const tab = get().tabs.find((t) => t.uri === uri);
    if (!tab) return true;

    if (!force && tab.dirty) {
      const saved = await get().saveTab(uri);
      if (!saved) return false;
    }
    disposeModel(uri);
    set((s) => {
      const tabs = s.tabs.filter((t) => t.uri !== uri);
      const activeId =
        s.activeId === uri ? (tabs[tabs.length - 1]?.uri ?? null) : s.activeId;
      return { tabs, activeId, pendingCloseId: null };
    });
    return true;
  },

  cancelClose: () => set({ pendingCloseId: null }),

  saveTab: async (uri, overwrite = false) => {
    if (get().saving) return false; // 防止快捷键双通道并发保存
    const tab = get().tabs.find((t) => t.uri === uri);
    if (!tab || tab.error) return true;
    const model = getModel(uri);
    if (!model) return true;

    set({ saving: true });
    try {
      const result = await filesApi.writeFile(
        tab.path,
        model.getValue(),
        overwrite ? null : tab.mtimeMs,
      );
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.uri === uri ? { ...t, dirty: false, mtimeMs: result.modifiedMs } : t,
        ),
        saving: false,
      }));
      return true;
    } catch (err) {
      set({ saving: false });
      if (err instanceof FsError && err.shape.code === "conflict") {
        set({
          pendingConflict: {
            uri,
            path: tab.path,
            remoteMtimeMs: err.shape.currentMtimeMs ?? 0,
          },
        });
        return false;
      }
      const message = err instanceof FsError ? err.shape.message : String(err);
      alert(`保存失败：${message}`);
      return false;
    }
  },

  saveAll: async () => {
    const dirtyTabs = get().tabs.filter((t) => t.dirty && !t.error);
    for (const tab of dirtyTabs) {
      const ok = await get().saveTab(tab.uri);
      if (!ok) return false;
    }
    return true;
  },

  resolveConflictLoadRemote: async () => {
    const conflict = get().pendingConflict;
    if (conflict) await get().reopenFile(conflict.path, conflict.uri);
  },

  resolveConflictOverwrite: async () => {
    const conflict = get().pendingConflict;
    if (!conflict) return;
    const ok = await get().saveTab(conflict.uri, true);
    if (ok) set({ pendingConflict: null });
  },

  dismissConflict: () => set({ pendingConflict: null }),

  hasDirty: () => get().tabs.some((t) => t.dirty),
}));
