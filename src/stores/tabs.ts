import { create } from "zustand";
import type { FileEntryDto } from "../types/ipc";
import { filesApi, FsError } from "../services/files";
import { gitApi, type GitFileDiffDto, type GitFileDiffRequest } from "../services/git";
import { getOrCreateModel, setModelValueQuiet, disposeModel, getModel, toModelUri } from "../lib/models";
import { settingsStore } from "./settings";
import { showErrorToast } from "./toast";

/**
 * 编辑器标签页状态（仅界面状态；权威文件状态在 Rust 端）。
 * 保存流程遵循：保存前带 expectedMtimeMs 做冲突检测，冲突不静默覆盖。
 *
 * 分屏模型（参考 VS Code）：
 * - `tabs` 是全局已打开文档（每个 URI 唯一，对应一个 Monaco Model）；
 * - `groups` 是编辑器分组，每组有自己的标签顺序和活动标签，同一文档可同时出现在多个分组；
 * - `layout` 为多列布局，每列可再上下拆分为多行；
 * - `activeId` 始终等于活动分组的活动标签，兼容保存、标题栏、状态栏等既有逻辑。
 */

export interface GitDiffTabSpec {
  title: string;
  uriKey: string;
  request: GitFileDiffRequest;
  data: GitFileDiffDto;
}

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
  /** Git 文件对比标签内容（非普通磁盘编辑文件） */
  diff?: GitDiffTabSpec;
}

export interface SaveConflict {
  uri: string;
  path: string;
  /** 远端当前 mtime */
  remoteMtimeMs: number;
}

/** 编辑器分组（分屏中的一个编辑区） */
export interface EditorGroup {
  id: string;
  tabUris: string[];
  activeUri: string | null;
}

/** 分屏布局中的一列，每列可上下拆分为多行（每行一个分组） */
export interface EditorColumn {
  id: string;
  rows: string[];
}

export type SplitSide = "left" | "right" | "top" | "bottom";

export interface OpenFileOptions {
  /** 仅保留修改文件开关开启时是否保留当前已有标签（用于启动恢复工作区） */
  preserveExisting?: boolean;
}

interface TabsState {
  tabs: EditorTab[];
  activeId: string | null;
  groups: Record<string, EditorGroup>;
  layout: EditorColumn[];
  activeGroupId: string;
  /** 待确认关闭的脏标签 */
  pendingCloseId: string | null;
  /** 保存冲突弹窗状态 */
  pendingConflict: SaveConflict | null;
  saving: boolean;
  /** 待执行的编辑器定位（搜索跳转用） */
  pendingReveal: { uri: string; line: number } | null;

  openFile(entry: FileEntryDto, options?: OpenFileOptions): Promise<void>;
  openFileByPath(path: string, options?: OpenFileOptions): Promise<void>;
  openFileAtLine(path: string, line: number): Promise<void>;
  openGitDiff(params: { title: string; uriKey: string; request: GitFileDiffRequest }): Promise<void>;
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

  /** 聚焦分组 */
  focusGroup(groupId: string): void;
  /** 在指定分组激活标签 */
  activateInGroup(groupId: string, uri: string): void;
  /** 在分组内关闭标签：其他分组仍打开该文件时仅从本组移除，否则走全局关闭流程 */
  closeInGroup(groupId: string, uri: string): void;
  /** 移动标签到目标分组（同组即重排） */
  moveTab(uri: string, fromGroupId: string, toGroupId: string, index?: number): void;
  /** 拖拽/按钮拆分：在目标分组的某一侧新建分组并放入该标签 */
  splitTab(uri: string, fromGroupId: string, targetGroupId: string, side: SplitSide, copy?: boolean): void;
  /** 文件或目录重命名后，同步更新已打开标签及 Monaco Model */
  handlePathRenamed(oldPath: string, newPath: string): void;
  /** 文件或目录删除后，自动关闭受影响的未修改标签 */
  handlePathDeleted(deletedPath: string, isDir: boolean): void;
}

let idSeq = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

const INITIAL_GROUP = "group-main";

async function readFileIntoTab(path: string, uri: string): Promise<EditorTab> {
  const name = path.split(/[\\/]/).pop() ?? path;
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

/** 从数组中移除元素后挑选相邻元素作为新的活动项 */
function removeWithNeighbor(list: string[], uri: string, currentActive: string | null) {
  const idx = list.indexOf(uri);
  if (idx < 0) return { list, active: currentActive };
  const next = list.filter((u) => u !== uri);
  let active = currentActive;
  if (currentActive === uri) {
    active = next[Math.min(idx, next.length - 1)] ?? null;
  }
  return { list: next, active };
}

function removeGroupFromLayout(layout: EditorColumn[], groupId: string): EditorColumn[] {
  return layout
    .map((c) => ({ ...c, rows: c.rows.filter((r) => r !== groupId) }))
    .filter((c) => c.rows.length > 0);
}

function allGroupIds(layout: EditorColumn[]): string[] {
  return layout.flatMap((c) => c.rows);
}

type GroupSlice = Pick<TabsState, "tabs" | "activeId" | "groups" | "layout" | "activeGroupId">;

/**
 * 分组一致性修正（幂等）：
 * 1. 过滤已关闭的文档；2. 未归属任何分组的文档及 activeId 放入活动分组；
 * 3. 移除空分组（至少保留一个）；4. activeId 与活动分组的活动标签同步。
 */
function reconcile(s: GroupSlice): Partial<GroupSlice> | null {
  const existing = new Set(s.tabs.map((t) => t.uri));
  let layout = s.layout.length > 0 ? s.layout : [{ id: newId("col"), rows: [INITIAL_GROUP] }];
  const groups: Record<string, EditorGroup> = {};
  for (const gid of allGroupIds(layout)) {
    const g = s.groups[gid] ?? { id: gid, tabUris: [], activeUri: null };
    const tabUris = g.tabUris.filter((u) => existing.has(u));
    const activeUri = g.activeUri && tabUris.includes(g.activeUri) ? g.activeUri : (tabUris[tabUris.length - 1] ?? null);
    groups[gid] = { id: gid, tabUris, activeUri };
  }

  let activeGroupId = groups[s.activeGroupId] ? s.activeGroupId : allGroupIds(layout)[0];

  // 未归属任何分组的文档放入活动分组
  const owned = new Set(Object.values(groups).flatMap((g) => g.tabUris));
  const ag = groups[activeGroupId];
  for (const t of s.tabs) {
    if (!owned.has(t.uri)) ag.tabUris = [...ag.tabUris, t.uri];
  }
  // activeId 必须出现在活动分组中
  if (s.activeId && existing.has(s.activeId)) {
    if (!ag.tabUris.includes(s.activeId)) ag.tabUris = [...ag.tabUris, s.activeId];
    ag.activeUri = s.activeId;
  }
  if (!ag.activeUri && ag.tabUris.length > 0) ag.activeUri = ag.tabUris[ag.tabUris.length - 1];

  // 移除空分组（至少保留一个）
  for (const gid of allGroupIds(layout)) {
    if (allGroupIds(layout).length <= 1) break;
    if (groups[gid].tabUris.length === 0) {
      const ids = allGroupIds(layout);
      const pos = ids.indexOf(gid);
      layout = removeGroupFromLayout(layout, gid);
      delete groups[gid];
      if (activeGroupId === gid) {
        const rest = allGroupIds(layout);
        activeGroupId = rest[Math.max(0, Math.min(pos - 1, rest.length - 1))];
      }
    }
  }

  const activeId = groups[activeGroupId]?.activeUri ?? null;

  const changed =
    activeId !== s.activeId ||
    activeGroupId !== s.activeGroupId ||
    JSON.stringify(layout) !== JSON.stringify(s.layout) ||
    JSON.stringify(groups) !== JSON.stringify(s.groups);
  if (!changed) return null;
  return { layout, groups, activeGroupId, activeId };
}

/** 寻找当前活动组内可替换的未修改标签：优先正在查看的未修改标签，否则最早打开的未修改标签 */
function findReplaceableTabUri(
  s: Pick<TabsState, "tabs" | "groups" | "activeGroupId">,
): string | null {
  const activeGroup = s.groups[s.activeGroupId];
  const tabMap = new Map(s.tabs.map((t) => [t.uri, t]));
  const candidates = activeGroup ? activeGroup.tabUris : s.tabs.map((t) => t.uri);

  if (activeGroup?.activeUri) {
    const activeTab = tabMap.get(activeGroup.activeUri);
    if (activeTab && !activeTab.dirty) {
      return activeTab.uri;
    }
  }
  for (const uri of candidates) {
    const tab = tabMap.get(uri);
    if (tab && !tab.dirty) {
      return tab.uri;
    }
  }
  return null;
}

/** 统一提交新开/重载标签，并在「仅保留修改文件」开启时替换同组未修改标签 */
function applyOpenedTab(
  s: TabsState,
  newTab: EditorTab,
  allowReplace: boolean,
): { patch: Partial<TabsState>; disposedUri: string | null } {
  const alreadyOpen = s.tabs.some((t) => t.uri === newTab.uri);
  const activeGroup = s.groups[s.activeGroupId];
  const groups = { ...s.groups };

  if (alreadyOpen) {
    const tabs = s.tabs.map((t) => (t.uri === newTab.uri ? newTab : t));
    if (activeGroup) {
      const tabUris = activeGroup.tabUris.includes(newTab.uri)
        ? activeGroup.tabUris
        : [...activeGroup.tabUris, newTab.uri];
      groups[s.activeGroupId] = { ...activeGroup, tabUris, activeUri: newTab.uri };
    }
    return { patch: { tabs, groups, activeId: newTab.uri }, disposedUri: null };
  }

  const replaceUri =
    allowReplace && settingsStore.getState().keepOnlyModifiedTabs
      ? findReplaceableTabUri(s)
      : null;

  if (replaceUri) {
    const usedElsewhere = Object.entries(s.groups).some(
      ([gid, g]) => gid !== s.activeGroupId && g.tabUris.includes(replaceUri),
    );
    const tabs = usedElsewhere
      ? [...s.tabs, newTab]
      : s.tabs.map((t) => (t.uri === replaceUri ? newTab : t));
    if (activeGroup) {
      const tabUris = activeGroup.tabUris.includes(replaceUri)
        ? activeGroup.tabUris.map((u) => (u === replaceUri ? newTab.uri : u))
        : [...activeGroup.tabUris, newTab.uri];
      groups[s.activeGroupId] = { ...activeGroup, tabUris, activeUri: newTab.uri };
    }
    return {
      patch: { tabs, groups, activeId: newTab.uri },
      disposedUri: usedElsewhere ? null : replaceUri,
    };
  }

  const tabs = [...s.tabs, newTab];
  if (activeGroup) {
    const tabUris = activeGroup.tabUris.includes(newTab.uri)
      ? activeGroup.tabUris
      : [...activeGroup.tabUris, newTab.uri];
    groups[s.activeGroupId] = { ...activeGroup, tabUris, activeUri: newTab.uri };
  }
  return { patch: { tabs, groups, activeId: newTab.uri }, disposedUri: null };
}

function commitOpenedTab(
  setFn: (fn: (s: TabsState) => Partial<TabsState>) => void,
  tab: EditorTab,
  allowReplace: boolean,
): void {
  let disposedUri: string | null = null;
  setFn((s) => {
    const res = applyOpenedTab(s, tab, allowReplace);
    disposedUri = res.disposedUri;
    return res.patch;
  });
  if (disposedUri) {
    disposeModel(disposedUri);
  }
}

export const tabsStore = create<TabsState>()((set, get) => ({
  tabs: [],
  activeId: null,
  groups: { [INITIAL_GROUP]: { id: INITIAL_GROUP, tabUris: [], activeUri: null } },
  layout: [{ id: "col-main", rows: [INITIAL_GROUP] }],
  activeGroupId: INITIAL_GROUP,
  pendingCloseId: null,
  pendingConflict: null,
  saving: false,
  pendingReveal: null,

  openFile: async (entry, options) => {
    if (entry.kind === "dir") return;
    const uri = toModelUri(entry.path);
    const existing = get().tabs.find((t) => t.uri === uri);
    // 只有当标签已存在、且无错误、且 Monaco Model 已经成功建立时，才直接激活；
    // 否则（例如之前未连 SSH 时留下的标签、读取失败的标签、或无 Model 状态）必须重新载入
    if (existing && !existing.error && getModel(uri)) {
      set({ activeId: uri });
      return;
    }
    const allowReplace = !options?.preserveExisting;
    try {
      const tab = await readFileIntoTab(entry.path, uri);
      commitOpenedTab(set, tab, allowReplace);
    } catch (err) {
      const message = err instanceof FsError ? err.shape.message : String(err);
      const errTab: EditorTab = {
        uri,
        path: entry.path,
        name: entry.name,
        dirty: false,
        mtimeMs: 0,
        readonly: true,
        error: message,
      };
      commitOpenedTab(set, errTab, allowReplace);
    }
  },

  openFileByPath: async (path, options) => {
    await get().openFile(
      {
        name: path.split("/").pop() ?? path,
        path,
        kind: "file",
        size: 0,
        modifiedMs: 0,
      },
      options,
    );
  },

  openFileAtLine: async (path, line) => {
    await get().openFileByPath(path);
    const uri = toModelUri(path);
    set({ pendingReveal: { uri, line }, activeId: uri });
  },

  openGitDiff: async ({ title, uriKey, request }) => {
    const uri = `gitdiff://${uriKey}`;
    try {
      const data = await gitApi.fileDiff(request);
      const tab: EditorTab = {
        uri,
        path: data.fileUri,
        name: title,
        dirty: false,
        mtimeMs: 0,
        readonly: true,
        diff: {
          title,
          uriKey,
          request,
          data,
        },
      };
      commitOpenedTab(set, tab, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errTab: EditorTab = {
        uri,
        path: request.path,
        name: title,
        dirty: false,
        mtimeMs: 0,
        readonly: true,
        error: `加载文件对比失败：${message}`,
      };
      commitOpenedTab(set, errTab, true);
    }
  },

  consumeReveal: () => set({ pendingReveal: null }),

  reopenFile: async (path, uri) => {
    // 冲突弹窗中「加载远端版本」或错误页「重新尝试加载」：重新读取并静默替换 Model 内容
    try {
      const content = await filesApi.readFile(path);
      if (!content.binary) {
        const name = path.split("/").pop() ?? path;
        if (getModel(uri)) {
          setModelValueQuiet(uri, content.text ?? "");
        } else {
          getOrCreateModel(uri, content.text ?? "", name);
        }
      }
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.uri === uri
            ? {
                ...t,
                mtimeMs: content.modifiedMs,
                dirty: false,
                error: content.binary ? "二进制文件暂不支持编辑" : undefined,
                readonly: !!content.binary,
              }
            : t,
        ),
        pendingConflict: null,
      }));
    } catch (err) {
      const message = err instanceof FsError ? err.shape.message : String(err);
      set({ pendingConflict: null });
      showErrorToast(`加载远端版本失败：${message}`);
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
      const groups: Record<string, EditorGroup> = {};
      for (const [gid, g] of Object.entries(s.groups)) {
        const r = removeWithNeighbor(g.tabUris, uri, g.activeUri);
        groups[gid] = { ...g, tabUris: r.list, activeUri: r.active };
      }
      return {
        tabs,
        groups,
        activeId: groups[s.activeGroupId]?.activeUri ?? null,
        pendingCloseId: null,
      };
    });
    return true;
  },

  cancelClose: () => set({ pendingCloseId: null }),

  saveTab: async (uri, overwrite = false) => {
    if (get().saving) return false; // 防止快捷键双通道并发保存
    const tab = get().tabs.find((t) => t.uri === uri);
    if (!tab || tab.error || tab.diff) return true;
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
      showErrorToast(`保存失败：${message}`);
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

  // ───────────── 分组 / 分屏 ─────────────

  focusGroup: (groupId) => {
    const g = get().groups[groupId];
    if (!g || get().activeGroupId === groupId) return;
    set({ activeGroupId: groupId, activeId: g.activeUri });
  },

  activateInGroup: (groupId, uri) => {
    set((s) => {
      const g = s.groups[groupId];
      if (!g) return {};
      return {
        activeGroupId: groupId,
        activeId: uri,
        groups: { ...s.groups, [groupId]: { ...g, activeUri: uri } },
      };
    });
  },

  closeInGroup: (groupId, uri) => {
    const s = get();
    const holders = Object.values(s.groups).filter((g) => g.tabUris.includes(uri));
    if (holders.length > 1) {
      const g = s.groups[groupId];
      if (!g) return;
      const r = removeWithNeighbor(g.tabUris, uri, g.activeUri);
      const groups = { ...s.groups, [groupId]: { ...g, tabUris: r.list, activeUri: r.active } };
      set({
        groups,
        activeId: s.activeGroupId === groupId ? r.active : s.activeId,
      });
      return;
    }
    get().requestClose(uri);
  },

  moveTab: (uri, fromGroupId, toGroupId, index) => {
    set((s) => {
      const from = s.groups[fromGroupId];
      const to = s.groups[toGroupId];
      if (!from || !to) return {};
      const groups = { ...s.groups };
      if (fromGroupId === toGroupId) {
        const list = from.tabUris.filter((u) => u !== uri);
        const oldIdx = from.tabUris.indexOf(uri);
        let target = index ?? list.length;
        if (index !== undefined && oldIdx >= 0 && oldIdx < index) target -= 1;
        list.splice(Math.max(0, Math.min(target, list.length)), 0, uri);
        groups[toGroupId] = { ...from, tabUris: list, activeUri: uri };
      } else {
        const r = removeWithNeighbor(from.tabUris, uri, from.activeUri);
        groups[fromGroupId] = { ...from, tabUris: r.list, activeUri: r.active };
        const list = to.tabUris.filter((u) => u !== uri);
        list.splice(Math.max(0, Math.min(index ?? list.length, list.length)), 0, uri);
        groups[toGroupId] = { ...to, tabUris: list, activeUri: uri };
      }
      return { groups, activeGroupId: toGroupId, activeId: uri };
    });
  },

  splitTab: (uri, fromGroupId, targetGroupId, side, copy = false) => {
    set((s) => {
      const target = s.groups[targetGroupId];
      const from = s.groups[fromGroupId];
      if (!target || !from) return {};
      // 拖动目标组唯一标签到自身边缘：无意义，忽略
      if (!copy && fromGroupId === targetGroupId && from.tabUris.length <= 1) return {};

      const gid = newId("group");
      const groups = { ...s.groups, [gid]: { id: gid, tabUris: [uri], activeUri: uri } };
      if (!copy) {
        const r = removeWithNeighbor(from.tabUris, uri, from.activeUri);
        groups[fromGroupId] = { ...from, tabUris: r.list, activeUri: r.active };
      }

      const layout = s.layout.map((c) => ({ ...c, rows: [...c.rows] }));
      const colIdx = layout.findIndex((c) => c.rows.includes(targetGroupId));
      if (colIdx < 0) return {};
      if (side === "left" || side === "right") {
        layout.splice(side === "left" ? colIdx : colIdx + 1, 0, { id: newId("col"), rows: [gid] });
      } else {
        const rows = layout[colIdx].rows;
        const rowIdx = rows.indexOf(targetGroupId);
        rows.splice(side === "top" ? rowIdx : rowIdx + 1, 0, gid);
      }
      return { groups, layout, activeGroupId: gid, activeId: uri };
    });
  },

  handlePathRenamed: (oldPath, newPath) => {
    const cleanOld = oldPath.replace(/[\\/]+$/, "");
    const cleanNew = newPath.replace(/[\\/]+$/, "");
    const normOld = cleanOld.replace(/\\/g, "/");
    const matchesTarget = (p: string): string | null => {
      const normP = p.replace(/\\/g, "/");
      if (normP === normOld) return newPath;
      if (normP.startsWith(`${normOld}/`)) {
        const suffix = p.slice(cleanOld.length);
        return `${cleanNew}${suffix}`;
      }
      return null;
    };

    const uriRenameMap = new Map<string, string>();
    const modelsToDispose: string[] = [];

    set((s) => {
      let anyChanged = false;
      const nextTabs = s.tabs.map((t) => {
        if (t.diff) return t;
        const nextPath = matchesTarget(t.path);
        if (!nextPath) return t;
        anyChanged = true;
        const nextUri = toModelUri(nextPath);
        const nextName = nextPath.split(/[\\/]/).pop() ?? nextPath;
        if (nextUri !== t.uri) {
          uriRenameMap.set(t.uri, nextUri);
          const oldModel = getModel(t.uri);
          if (oldModel) {
            getOrCreateModel(nextUri, oldModel.getValue(), nextName);
            modelsToDispose.push(t.uri);
          }
        }
        return { ...t, uri: nextUri, path: nextPath, name: nextName };
      });
      if (!anyChanged) return {};

      const mapUri = (u: string) => uriRenameMap.get(u) ?? u;
      const groups: Record<string, EditorGroup> = {};
      for (const [gid, g] of Object.entries(s.groups)) {
        groups[gid] = {
          ...g,
          tabUris: g.tabUris.map(mapUri),
          activeUri: g.activeUri ? mapUri(g.activeUri) : null,
        };
      }
      return {
        tabs: nextTabs,
        groups,
        activeId: s.activeId ? mapUri(s.activeId) : null,
        pendingCloseId: s.pendingCloseId ? mapUri(s.pendingCloseId) : null,
        pendingReveal: s.pendingReveal
          ? { ...s.pendingReveal, uri: mapUri(s.pendingReveal.uri) }
          : null,
        pendingConflict: s.pendingConflict
          ? {
              ...s.pendingConflict,
              uri: mapUri(s.pendingConflict.uri),
              path: matchesTarget(s.pendingConflict.path) ?? s.pendingConflict.path,
            }
          : null,
      };
    });

    for (const oldUri of modelsToDispose) {
      disposeModel(oldUri);
    }
  },

  handlePathDeleted: (deletedPath, isDir) => {
    const cleanTarget = deletedPath.replace(/[\\/]+$/, "");
    const normTarget = cleanTarget.replace(/\\/g, "/");
    const isAffected = (p: string): boolean => {
      const normP = p.replace(/\\/g, "/");
      if (normP === normTarget) return true;
      return isDir && normP.startsWith(`${normTarget}/`);
    };

    const staleUris: string[] = [];
    for (const t of get().tabs) {
      if (!t.diff && !t.dirty && isAffected(t.path)) {
        staleUris.push(t.uri);
      }
    }
    if (staleUris.length === 0) return;

    for (const uri of staleUris) {
      disposeModel(uri);
    }
    const staleSet = new Set(staleUris);
    set((s) => {
      const tabs = s.tabs.filter((t) => !staleSet.has(t.uri));
      const groups: Record<string, EditorGroup> = {};
      for (const [gid, g] of Object.entries(s.groups)) {
        let nextList = g.tabUris;
        let nextActive = g.activeUri;
        for (const u of staleUris) {
          const r = removeWithNeighbor(nextList, u, nextActive);
          nextList = r.list;
          nextActive = r.active;
        }
        groups[gid] = { ...g, tabUris: nextList, activeUri: nextActive };
      }
      return {
        tabs,
        groups,
        activeId: groups[s.activeGroupId]?.activeUri ?? null,
      };
    });
  },
}));

// 任何状态变化后保证分组一致（幂等，修正后不会再次触发修改）
tabsStore.subscribe((s) => {
  const patch = reconcile(s);
  if (patch) tabsStore.setState(patch);
});
