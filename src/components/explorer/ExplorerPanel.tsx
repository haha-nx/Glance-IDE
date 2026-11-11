import { useEffect, useRef, useState } from "react";
import { explorerStore } from "../../stores/explorer";
import { tabsStore } from "../../stores/tabs";
import { filesApi } from "../../services/files";
import type { FileEntryDto } from "../../types/ipc";
import { Button, Modal, PrimaryButton } from "../common/Modal";
import { IconClose, IconFolder, IconPlus, IconRefresh } from "../common/icons";
import { TreeNode } from "./TreeNode";

type Dialog =
  | { kind: "newFile"; parent: string }
  | { kind: "newFolder"; parent: string }
  | { kind: "rename"; path: string; name: string }
  | { kind: "delete"; path: string; name: string; isDir: boolean }
  | null;

interface ContextMenuState {
  entry: FileEntryDto;
  x: number;
  y: number;
}

export function ExplorerPanel() {
  const rootPath = explorerStore((s) => s.rootPath);
  const rootError = explorerStore((s) => s.rootError);
  const openRoot = explorerStore((s) => s.openRoot);
  const closeRoot = explorerStore((s) => s.closeRoot);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击其他位置关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const rootName = rootPath?.split("/").filter(Boolean).pop() ?? "";

  async function pickFolder() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string" && selected.length > 0) {
      await openRoot(selected);
    }
  }

  function openDialog(d: Exclude<Dialog, null>) {
    setMenu(null);
    setInput(d.kind === "rename" ? d.name : "");
    setDialog(d);
  }

  function menuAction(action: string) {
    if (!menu) return;
    const { entry } = menu;
    setMenu(null);
    switch (action) {
      case "newFile":
        openDialog({ kind: "newFile", parent: entry.kind === "dir" ? entry.path : rootPath! });
        break;
      case "newFolder":
        openDialog({ kind: "newFolder", parent: entry.kind === "dir" ? entry.path : rootPath! });
        break;
      case "rename":
        openDialog({ kind: "rename", path: entry.path, name: entry.name });
        break;
      case "delete":
        openDialog({
          kind: "delete",
          path: entry.path,
          name: entry.name,
          isDir: entry.kind === "dir",
        });
        break;
      case "refresh":
        void explorerStore
          .getState()
          .refresh(entry.kind === "dir" ? entry.path : rootPath!);
        break;
    }
  }

  async function submitDialog() {
    if (!dialog) return;
    setBusy(true);
    try {
      if (dialog.kind === "newFile") {
        const path = `${dialog.parent}/${input}`;
        await filesApi.createFile(path);
        await explorerStore.getState().refresh(dialog.parent);
        await tabsStore.getState().openFile({
          name: input,
          path,
          kind: "file",
          size: 0,
          modifiedMs: Date.now(),
        });
      } else if (dialog.kind === "newFolder") {
        await filesApi.createDir(`${dialog.parent}/${input}`);
        await explorerStore.getState().refresh(dialog.parent);
      } else if (dialog.kind === "rename") {
        const parent = explorerStore.getState().parentOf(dialog.path);
        if (parent) {
          await filesApi.renameEntry(dialog.path, `${parent}/${input}`);
          await explorerStore.getState().refresh(parent);
        }
      } else if (dialog.kind === "delete") {
        await filesApi.deleteEntry(dialog.path, dialog.isDir);
        const parent = explorerStore.getState().parentOf(dialog.path);
        if (parent) await explorerStore.getState().refresh(parent);
      }
      setDialog(null);
    } catch (err) {
      alert(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const menuItemClass =
    "block w-full px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-700";

  return (
    <div className="flex h-full flex-col bg-zinc-900">
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <span>资源管理器</span>
        {rootPath && (
          <button
            title="关闭文件夹"
            onClick={closeRoot}
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <IconClose size={14} />
          </button>
        )}
      </div>

      {!rootPath ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-sm text-zinc-500">打开一个文件夹以开始工作</p>
          <PrimaryButton onClick={pickFolder}>打开文件夹</PrimaryButton>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between px-3 py-1">
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-zinc-300" title={rootPath || "文件"}>
              {rootName || "文件"}
            </span>
            <div className="flex gap-1">
              <button
                title="打开其他文件夹"
                onClick={pickFolder}
                className="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <IconFolder size={14} />
              </button>
              <button
                title="新建文件"
                onClick={() => openDialog({ kind: "newFile", parent: rootPath })}
                className="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <IconPlus size={14} />
              </button>
              <button
                title="刷新"
                onClick={() => explorerStore.getState().refresh(rootPath)}
                className="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <IconRefresh size={14} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto pb-2">
            {rootError ? (
              <p className="px-3 py-2 text-xs text-red-400">{rootError}</p>
            ) : (
              <TreeNode
                dirPath={rootPath}
                depth={0}
                onContextMenu={(entry, x, y) => setMenu({ entry, x, y })}
              />
            )}
          </div>
        </>
      )}

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-40 rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 180),
            top: Math.min(menu.y, window.innerHeight - 200),
          }}
        >
          {menu.entry.kind === "dir" && (
            <>
              <button className={menuItemClass} onClick={() => menuAction("newFile")}>
                新建文件
              </button>
              <button className={menuItemClass} onClick={() => menuAction("newFolder")}>
                新建文件夹
              </button>
              <div className="my-1 border-t border-zinc-700" />
            </>
          )}
          <button className={menuItemClass} onClick={() => menuAction("rename")}>
            重命名
          </button>
          <button className={menuItemClass} onClick={() => menuAction("refresh")}>
            刷新
          </button>
          <div className="my-1 border-t border-zinc-700" />
          <button
            className="block w-full px-3 py-1.5 text-left text-sm text-red-400 hover:bg-zinc-700"
            onClick={() => menuAction("delete")}
          >
            删除
          </button>
        </div>
      )}

      {dialog && (
        <Modal
          title={
            dialog.kind === "newFile"
              ? "新建文件"
              : dialog.kind === "newFolder"
                ? "新建文件夹"
                : dialog.kind === "rename"
                  ? "重命名"
                  : "删除"
          }
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button onClick={() => setDialog(null)}>取消</Button>
              <PrimaryButton onClick={submitDialog} disabled={busy || (dialog.kind !== "delete" && input.trim().length === 0)}>
                {dialog.kind === "delete" ? "删除" : "确定"}
              </PrimaryButton>
            </>
          }
        >
          {dialog.kind === "delete" ? (
            <p>
              确定删除 <span className="text-zinc-100">{dialog.name}</span>
              {dialog.isDir ? " 及其全部内容" : ""}？此操作不可撤销。
            </p>
          ) : (
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitDialog();
              }}
              placeholder="输入名称"
              className="w-full rounded border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-600"
            />
          )}
        </Modal>
      )}
    </div>
  );
}
