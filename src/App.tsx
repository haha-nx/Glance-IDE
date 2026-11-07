import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ActivityBar } from "./components/common/ActivityBar";
import { StatusBar } from "./components/common/StatusBar";
import { ExplorerPanel } from "./components/explorer/ExplorerPanel";
import { SearchPanel } from "./components/search/SearchPanel";
import { SshPanel } from "./components/ssh/SshPanel";
import { DiscoveryPanel } from "./components/discovery/DiscoveryPanel";
import { EditorArea } from "./components/editor/EditorArea";
import { useGlobalSave } from "./components/editor/MonacoHost";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { SaveConflictModal, UnsavedCloseModal } from "./components/editor/Dialogs";
import { tabsStore } from "./stores/tabs";
import { explorerStore } from "./stores/explorer";
import { workspaceApi } from "./services/workspace";
import { Button, Modal, PrimaryButton } from "./components/common/Modal";

/** 窗口关闭时若有未保存更改，先确认（路线图 §12.4「未保存提示」） */
function useCloseGuard(onBlocked: () => void): void {
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    const promise = win.onCloseRequested((event) => {
      if (tabsStore.getState().hasDirty()) {
        event.preventDefault();
        onBlocked();
      }
    });
    void promise.then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [onBlocked]);
}

const ROOT_KEY = "glance.recentRoot";

/** 启动恢复 + 变更持久化（M1 任务 1.7，§9.1 ui_state 表；localStorage 兜底） */
function useWorkspacePersistence() {
  // 恢复
  useEffect(() => {
    void (async () => {
      try {
        let root: string | null = null;
        try {
          root = await workspaceApi.getUiState("workspace.root");
        } catch {
          /* 数据库不可用时退回 localStorage */
        }
        root = root ?? localStorage.getItem(ROOT_KEY);
        if (root) {
          await explorerStore.getState().openRoot(root);
        }
        let tabsJson: string | null = null;
        try {
          tabsJson = await workspaceApi.getUiState("workspace.tabs");
        } catch {
          /* 同上 */
        }
        if (tabsJson) {
          const parsed = JSON.parse(tabsJson) as { paths?: string[]; active?: string };
          for (const p of parsed.paths ?? []) {
            await tabsStore.getState().openFileByPath(p);
          }
          if (parsed.active) {
            const { toModelUri } = await import("./lib/models");
            tabsStore.getState().setActive(toModelUri(parsed.active));
          }
        }
      } catch (err) {
        console.warn("工作区恢复失败", err);
      }
    })();
  }, []);

  // 持久化（防抖 800ms）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = tabsStore.subscribe((s) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = s.tabs.filter((t) => !t.error).map((t) => t.path);
        const active = s.tabs.find((t) => t.uri === s.activeId);
        const payload = JSON.stringify({ paths, active: active?.path ?? null });
        void workspaceApi.setUiState("workspace.tabs", payload).catch(() => {});
      }, 800);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 根目录持久化
  useEffect(() => {
    const unsub = explorerStore.subscribe((s) => {
      if (s.rootPath) {
        localStorage.setItem(ROOT_KEY, s.rootPath);
        void workspaceApi.setUiState("workspace.root", s.rootPath).catch(() => {});
      }
    });
    return unsub;
  }, []);
}

export default function App() {
  const [activePanel, setActivePanel] = useState("explorer");
  const [pendingWindowClose, setPendingWindowClose] = useState(false);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);

  useCloseGuard(() => setPendingWindowClose(true));
  useWorkspacePersistence();
  useGlobalSave();

  // SSH 面板「打开文件」→ 切换到资源管理器
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) setActivePanel(detail);
    };
    window.addEventListener("glance:activate-panel", handler);
    return () => window.removeEventListener("glance:activate-panel", handler);
  }, []);

  async function closeAnyway() {
    await getCurrentWindow().destroy();
  }

  async function saveAllAndClose() {
    const ok = await tabsStore.getState().saveAll();
    if (ok) await closeAnyway();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <ActivityBar active={activePanel} onActivate={setActivePanel} />
        {activePanel === "explorer" && (
          <div className="w-64 shrink-0 border-r border-zinc-800">
            <ExplorerPanel />
          </div>
        )}
        {activePanel === "search" && (
          <div className="w-80 shrink-0 border-r border-zinc-800">
            <SearchPanel />
          </div>
        )}
        {activePanel === "ssh" && (
          <div className="w-80 shrink-0 border-r border-zinc-800">
            <SshPanel />
          </div>
        )}
        {activePanel === "discovery" && (
          <div className="w-80 shrink-0 border-r border-zinc-800">
            <DiscoveryPanel />
          </div>
        )}
        <EditorArea />
      </div>
      {bottomPanelOpen && (
        <div className="h-64 shrink-0">
          <TerminalPanel onClose={() => setBottomPanelOpen(false)} />
        </div>
      )}
      <StatusBar onToggleTerminal={() => setBottomPanelOpen((v) => !v)} />

      <UnsavedCloseModal />
      <SaveConflictModal />

      {pendingWindowClose && (
        <Modal
          title="未保存的更改"
          onClose={() => setPendingWindowClose(false)}
          footer={
            <>
              <Button onClick={() => setPendingWindowClose(false)}>取消</Button>
              <Button onClick={() => void closeAnyway()}>不保存</Button>
              <PrimaryButton onClick={() => void saveAllAndClose()}>
                保存全部并关闭
              </PrimaryButton>
            </>
          }
        >
          <p>有未保存的更改，关闭窗口前是否保存？</p>
        </Modal>
      )}
    </div>
  );
}
