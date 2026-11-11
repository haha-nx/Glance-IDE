import { Fragment, useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as pickDialog } from "@tauri-apps/plugin-dialog";
import { tabsStore } from "../../stores/tabs";
import { tabDragStore, type DropZone } from "../../stores/tabDrag";
import { explorerStore } from "../../stores/explorer";
import { getModel } from "../../lib/models";
import { TabBar } from "./TabBar";
import { MonacoHost } from "./MonacoHost";
import { GitDiffView } from "./GitDiffView";
import { MarkdownWysiwyg } from "../markdown/MarkdownWysiwyg";
import { SettingsModal } from "../common/SettingsModal";
import { IS_MAC } from "../../lib/platform";

/**
 * 编辑器区（VS Code 风格多分组分屏）：
 * - 任意数量的分组，按「列 → 行」网格排列，分隔条可拖动调整大小；
 * - 拖动标签到其他分组标签栏 = 移动；拖到编辑区中央 = 移入该分组；拖到编辑区四边 = 在该侧拆分新分组；
 * - 每个分组独立的活动标签、Markdown 预览/源码模式与 Diff 视图。
 */
export function EditorArea() {
  const layout = tabsStore((s) => s.layout);
  const drag = tabDragStore((s) => s.drag);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 原生菜单事件
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    void listen("menu:open-folder", async () => {
      const picked = await pickDialog({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) {
        await explorerStore.getState().openRoot(picked);
        window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "explorer" }));
      }
    }).then((un) => unlisteners.push(un));
    void listen("menu:open-file", async () => {
      const picked = await pickDialog({ multiple: false });
      if (typeof picked === "string" && picked) {
        await tabsStore.getState().openFileByPath(picked);
      }
    }).then((un) => unlisteners.push(un));
    void listen("menu:settings", () => {
      setSettingsOpen(true);
    }).then((un) => unlisteners.push(un));
    return () => unlisteners.forEach((un) => un());
  }, []);

  /** 拖动分隔条：按相邻两块的像素尺寸换算为 flex 权重 */
  function startResize(e: React.PointerEvent<HTMLDivElement>, aId: string, bId: string, axis: "x" | "y") {
    e.preventDefault();
    const sash = e.currentTarget;
    const prev = sash.previousElementSibling as HTMLElement | null;
    const next = sash.nextElementSibling as HTMLElement | null;
    if (!prev || !next) return;
    const pa = axis === "x" ? prev.getBoundingClientRect().width : prev.getBoundingClientRect().height;
    const pb = axis === "x" ? next.getBoundingClientRect().width : next.getBoundingClientRect().height;
    const wa = weights[aId] ?? 1;
    const wb = weights[bId] ?? 1;
    const start = axis === "x" ? e.clientX : e.clientY;
    const totalPx = pa + pb;
    const totalW = wa + wb;
    const min = 140;

    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const move = (ev: PointerEvent) => {
      const delta = (axis === "x" ? ev.clientX : ev.clientY) - start;
      const na = Math.max(min, Math.min(totalPx - min, pa + delta));
      setWeights((w) => ({ ...w, [aId]: (totalW * na) / totalPx, [bId]: (totalW * (totalPx - na)) / totalPx }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">
        {layout.map((col, ci) => (
          <Fragment key={col.id}>
            {ci > 0 && (
              <div
                onPointerDown={(e) => startResize(e, layout[ci - 1].id, col.id, "x")}
                className="relative z-10 w-px shrink-0 cursor-col-resize bg-zinc-800 before:absolute before:inset-y-0 before:-left-[3px] before:w-[7px] before:content-[''] hover:bg-sky-500"
              />
            )}
            <div className="flex min-h-0 min-w-0 flex-col" style={{ flex: `${weights[col.id] ?? 1} 1 0px` }}>
              {col.rows.map((gid, ri) => (
                <Fragment key={gid}>
                  {ri > 0 && (
                    <div
                      onPointerDown={(e) => startResize(e, col.rows[ri - 1], gid, "y")}
                      className="relative z-10 h-px shrink-0 cursor-row-resize bg-zinc-800 before:absolute before:inset-x-0 before:-top-[3px] before:h-[7px] before:content-[''] hover:bg-sky-500"
                    />
                  )}
                  <div className="flex min-h-0 min-w-0" style={{ flex: `${weights[gid] ?? 1} 1 0px` }}>
                    <EditorGroupView groupId={gid} />
                  </div>
                </Fragment>
              ))}
            </div>
          </Fragment>
        ))}
      </div>

      {/* 拖拽中的标签幽灵 */}
      {drag && (
        <div
          className="pointer-events-none fixed z-[200] rounded border border-sky-500/60 bg-zinc-900/95 px-2.5 py-1 text-xs text-zinc-200 shadow-xl"
          style={{ left: drag.x + 14, top: drag.y + 10 }}
        >
          {drag.label}
        </div>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/** 单个编辑器分组 */
function EditorGroupView({ groupId }: { groupId: string }) {
  const group = tabsStore((s) => s.groups[groupId]);
  const tabs = tabsStore((s) => s.tabs);
  const totalTabs = tabs.length;
  const focusGroup = tabsStore((s) => s.focusGroup);
  const splitTab = tabsStore((s) => s.splitTab);
  const dragging = tabDragStore((s) => !!s.drag);
  const target = tabDragStore((s) => (s.target?.groupId === groupId ? s.target : null));

  const [mdModes, setMdModes] = useState<Record<string, "preview" | "source">>({});

  const active = tabs.find((t) => t.uri === group?.activeUri);
  const isDiff = !!active?.diff;
  const isMarkdown = !!active && !active.error && !isDiff && /\.(md|markdown)$/i.test(active.name);
  const mdMode = active ? (mdModes[active.uri] ?? "preview") : "preview";
  const setMdMode = (m: "preview" | "source") => {
    if (active) setMdModes((s) => ({ ...s, [active.uri]: m }));
  };

  const modeSwitch = isMarkdown ? <MdModeSwitch mode={mdMode} onChange={setMdMode} /> : null;

  const actions: ReactNode = active ? (
    <>
      <button
        onClick={() => splitTab(active.uri, groupId, groupId, "right", true)}
        className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="向右拆分编辑器（也可拖动标签到编辑区四边进行分屏）"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="3" y="4" width="18" height="16" rx="1.5" />
          <line x1="12" y1="4" x2="12" y2="20" />
        </svg>
      </button>
      <button
        onClick={() => splitTab(active.uri, groupId, groupId, "bottom", true)}
        className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="向下拆分编辑器（也可拖动标签到编辑区四边进行分屏）"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="3" y="4" width="18" height="16" rx="1.5" />
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      </button>
    </>
  ) : null;

  let content: ReactNode;
  if (!active) {
    content =
      totalTabs === 0 ? (
        <Welcome />
      ) : (
        <div className="flex h-full w-full flex-1 flex-col items-center justify-center bg-zinc-900 text-xs text-zinc-500 select-none">
          请选择或打开一个文件
        </div>
      );
  } else if (active.diff) {
    content = <GitDiffView key={active.uri} uri={active.uri} diff={active.diff} />;
  } else if (isMarkdown && mdMode === "preview") {
    content = <MarkdownWysiwyg key={active.uri} uri={active.uri} headerRight={modeSwitch} />;
  } else if (isMarkdown) {
    content = (
      <>
        <MdSourceHeader uri={active.uri} right={modeSwitch} />
        <div className="relative min-h-0 flex-1 flex flex-col">
          <MonacoHost uri={active.uri} />
        </div>
      </>
    );
  } else {
    content = <MonacoHost uri={active.uri} />;
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col" onMouseDownCapture={() => focusGroup(groupId)}>
      <TabBar groupId={groupId} actions={actions} />
      <div data-group-body={groupId} className="relative flex min-h-0 flex-1 flex-col">
        {content}
        {dragging && target && target.zone !== "tabbar" && <DropOverlay zone={target.zone} />}
      </div>
    </div>
  );
}

/** VS Code 风格拖放预览遮罩 */
function DropOverlay({ zone }: { zone: DropZone }) {
  const pos: Record<string, string> = {
    center: "inset-0",
    left: "inset-y-0 left-0 w-1/2",
    right: "inset-y-0 right-0 w-1/2",
    top: "inset-x-0 top-0 h-1/2",
    bottom: "inset-x-0 bottom-0 h-1/2",
  };
  return (
    <div
      className={`pointer-events-none absolute z-50 border border-sky-500/50 bg-sky-500/20 transition-all duration-100 ${pos[zone] ?? "inset-0"}`}
    />
  );
}

/** Markdown 预览 / 源码切换（位于字数、段落统计旁） */
export function MdModeSwitch({ mode, onChange }: { mode: "preview" | "source"; onChange: (m: "preview" | "source") => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded bg-zinc-900 p-0.5">
      <ModeButton active={mode === "preview"} onClick={() => onChange("preview")} title="所见即所得预览编辑">
        预览
      </ModeButton>
      <ModeButton active={mode === "source"} onClick={() => onChange("source")} title="Markdown 源码">
        源码
      </ModeButton>
    </div>
  );
}

/** 源码模式下的 Markdown 顶栏：统计 + 模式切换，与预览模式位置保持一致 */
function MdSourceHeader({ uri, right }: { uri: string; right: ReactNode }) {
  const [stats, setStats] = useState({ chars: 0, lines: 0 });
  useEffect(() => {
    const model = getModel(uri);
    if (!model) return;
    const update = () => {
      const text = model.getValue();
      setStats({ chars: text.length, lines: text.split("\n").filter((l) => l.trim().length > 0).length });
    };
    update();
    const sub = model.onDidChangeContent(update);
    return () => sub.dispose();
  }, [uri]);

  return (
    <div className="flex h-9 shrink-0 items-center justify-end gap-3 border-b border-zinc-800 bg-zinc-950 px-3 text-[11px] text-zinc-500">
      <span>{stats.chars} 字</span>
      <span>{stats.lines} 段</span>
      {right}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded px-2 py-0.5 text-xs transition-colors ${
        active ? "bg-sky-600/25 text-sky-300 font-medium" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

function Welcome() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
      <p className="text-4xl font-light tracking-widest text-zinc-700">GLANCE</p>
      <p className="text-sm">{IS_MAC ? "本地 / 远程一体化开发工作台" : "本地 / 远程 / WSL 一体化开发工作台"}</p>
      <p className="mt-4 text-xs text-zinc-700">
        {IS_MAC
          ? "文件菜单可打开本地文件夹 · 左侧活动栏可连接 SSH 远程设备"
          : "文件菜单可打开本地文件夹 · 左侧活动栏可连接 SSH 远程设备或 WSL 子系统"}
      </p>
    </div>
  );
}
