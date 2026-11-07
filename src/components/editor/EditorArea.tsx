import { useEffect, useMemo, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as pickDialog } from "@tauri-apps/plugin-dialog";
import { tabsStore } from "../../stores/tabs";
import { explorerStore } from "../../stores/explorer";
import { TabBar } from "./TabBar";
import { MonacoHost } from "./MonacoHost";
import { MarkdownPreview } from "../markdown/MarkdownPreview";
import { DiffView } from "./DiffView";
import { SettingsModal } from "../common/SettingsModal";

/**
 * 编辑器区（M1/M6）：
 * - 标签栏 + Monaco + Markdown 源码/预览双模式 + Diff 视图
 * - 原生菜单事件（打开文件夹/文件/设置）
 */
export function EditorArea() {
  const tabs = tabsStore((s) => s.tabs);
  const activeId = tabsStore((s) => s.activeId);
  const [mdMode, setMdMode] = useState<"source" | "preview">("source");
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const active = useMemo(() => tabs.find((t) => t.uri === activeId), [tabs, activeId]);
  const isMarkdown = !!active && !active.error && /\.md$/i.test(active.name);

  // 非markdown文件回到源码模式
  useEffect(() => {
    if (!isMarkdown) setMdMode("source");
  }, [isMarkdown]);

  // 切换标签时收起 Diff 与源码抽屉
  useEffect(() => {
    setDiffOpen(false);
    setEditDrawerOpen(false);
  }, [activeId]);

  // 布局加固：有标签但无活动标签时自动选中（防止退出全屏等操作后编辑器空置）
  useEffect(() => {
    const s = tabsStore.getState();
    if (s.tabs.length > 0 && !s.activeId) {
      s.setActive(s.tabs[0].uri);
    }
  }, [tabs, activeId]);

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

  const actions: ReactNode = (
    <>
      {isMarkdown && (
        <div className="flex items-center gap-0.5 rounded bg-zinc-900 p-0.5">
          <ModeButton active={mdMode === "source"} onClick={() => setMdMode("source")}>
            源码
          </ModeButton>
          <ModeButton active={mdMode === "preview"} onClick={() => setMdMode("preview")}>
            预览
          </ModeButton>
        </div>
      )}
      {active && !active.error && (
        <ModeButton active={diffOpen} onClick={() => setDiffOpen((v) => !v)}>
          Diff
        </ModeButton>
      )}
    </>
  );

  // Diff 视图（左：当前编辑缓冲区，右：磁盘原版）
  if (diffOpen && active && !active.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TabBar actions={actions} />
        <div className="flex min-h-0 flex-1 flex-col">
          <DiffView uri={active.uri} onClose={() => setDiffOpen(false)} />
        </div>
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </div>
    );
  }

  // Markdown 预览模式：全屏预览；需要修改时从右下角唤出源码编辑抽屉（实时刷新预览）
  if (mdMode === "preview" && active && isMarkdown) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TabBar actions={actions} />
        <div className="relative flex min-h-0 flex-1 flex-col">
          <MarkdownPreview uri={active.uri} fullscreen />
          {editDrawerOpen ? (
            <div className="absolute inset-x-0 bottom-0 z-10 flex h-[45%] flex-col border-t border-zinc-700 bg-zinc-950 shadow-2xl">
              <div className="flex h-7 shrink-0 items-center justify-between bg-zinc-900 px-3 text-[11px] text-zinc-500">
                <span>源码编辑（预览实时刷新）</span>
                <button
                  onClick={() => setEditDrawerOpen(false)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-sky-400 hover:bg-sky-950"
                  title="收起源码编辑，回到全屏预览"
                >
                  收起 ✕
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <MonacoHost />
              </div>
            </div>
          ) : (
            <button
              onClick={() => setEditDrawerOpen(true)}
              className="absolute bottom-5 right-8 z-10 rounded-full border border-sky-700 bg-sky-600/90 px-4 py-1.5 text-xs text-white shadow-lg transition-colors hover:bg-sky-500"
              title="唤出源码编辑（预览继续可见）"
            >
              ✎ 编辑源码
            </button>
          )}
        </div>
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </div>
    );
  }

  // 常规 / 源码模式
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabBar actions={actions} />
      <div className="min-h-0 flex-1">
        {tabs.length === 0 ? <Welcome /> : <MonacoHost />}
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-xs transition-colors ${
        active
          ? "bg-sky-600/25 text-sky-300"
          : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
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
      <p className="text-sm">本地 / 远程一体化开发工作台</p>
      <p className="mt-4 text-xs text-zinc-700">
        文件菜单可打开文件夹 / 文件 · SSH 设备池见「远程设备」面板
      </p>
    </div>
  );
}
