import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { explorerStore, joinChildPath } from "../../stores/explorer";
import { tabsStore } from "../../stores/tabs";
import { transferStore } from "../../stores/transfer";
import { filesApi } from "../../services/files";
import type { FileEntryDto } from "../../types/ipc";
import { Button, DangerButton, Modal, PrimaryButton } from "../common/Modal";
import { showErrorToast } from "../../stores/toast";
import {
  IconClose,
  IconFolder,
  IconFolderPlus,
  IconPlus,
  IconRefresh,
  IconUpload,
} from "../common/icons";
import { TransferQueuePanel } from "./TransferQueuePanel";
import { TreeNode } from "./TreeNode";

type Dialog =
  | { kind: "newFile"; parent: string }
  | { kind: "newFolder"; parent: string }
  | { kind: "rename"; path: string; name: string }
  | { kind: "delete"; path: string; name: string; isDir: boolean }
  | null;

interface ContextMenuState {
  /** null 表示在目录树空白处右键，作用于根目录 */
  entry: FileEntryDto | null;
  x: number;
  y: number;
}

export function ExplorerPanel() {
  const rootPath = explorerStore((s) => s.rootPath);
  const rootError = explorerStore((s) => s.rootError);
  const openRoot = explorerStore((s) => s.openRoot);
  const closeRoot = explorerStore((s) => s.closeRoot);
  const pendingConflict = transferStore((s) => s.pendingConflict);
  const resolveConflict = transferStore((s) => s.resolveConflict);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // 点击其他位置关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  // 监听操作系统级外部文件/文件夹拖拽事件（Tauri webview 原生拖拽通道）
  useEffect(() => {
    if (!rootPath) {
      setDropTargetDir(null);
      return;
    }

    let unlisten: (() => void) | undefined;
    let mounted = true;

    const resolveDropDirAt = (physX: number, physY: number): string | null => {
      const box = dropZoneRef.current?.getBoundingClientRect();
      if (!box) return null;
      const dpr = window.devicePixelRatio || 1;
      const cx = physX / dpr;
      const cy = physY / dpr;
      if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) {
        return null;
      }
      const el = document.elementFromPoint(cx, cy);
      const target = el?.closest<HTMLElement>("[data-drop-dir]")?.dataset.dropDir;
      return target || rootPath;
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!mounted) return;
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDropTargetDir(resolveDropDirAt(payload.position.x, payload.position.y));
        } else if (payload.type === "leave") {
          setDropTargetDir(null);
        } else if (payload.type === "drop") {
          const targetDir = resolveDropDirAt(payload.position.x, payload.position.y);
          setDropTargetDir(null);
          if (targetDir && payload.paths.length > 0) {
            void transferStore.getState().uploadLocalPaths(payload.paths, targetDir);
          }
        }
      })
      .then((fn) => {
        if (mounted) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch(() => {});

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [rootPath]);

  const rootName =
    rootPath?.replace(/[\\/]+$/, "").split(/[/\\]/).filter(Boolean).pop() ?? "";

  async function pickFolder() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string" && selected.length > 0) {
      await openRoot(selected);
    }
  }

  async function pickAndUpload(directory: boolean, targetDir: string) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory,
      multiple: true,
      title: directory ? "选择要上传的文件夹" : "选择要上传的文件",
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length > 0) {
      await transferStore.getState().uploadLocalPaths(paths, targetDir);
    }
  }

  function openDialog(d: Exclude<Dialog, null>) {
    setMenu(null);
    setInput(d.kind === "rename" ? d.name : "");
    setDialog(d);
  }

  function targetDirForMenu(entry: FileEntryDto | null): string {
    if (!entry) return rootPath ?? "";
    if (entry.kind === "dir") return entry.path;
    return explorerStore.getState().parentOf(entry.path) ?? rootPath ?? "";
  }

  function menuAction(action: string) {
    if (!menu || !rootPath) return;
    const { entry } = menu;
    const parentDir = targetDirForMenu(entry);
    setMenu(null);

    switch (action) {
      case "newFile":
        openDialog({ kind: "newFile", parent: parentDir });
        break;
      case "newFolder":
        openDialog({ kind: "newFolder", parent: parentDir });
        break;
      case "uploadFiles":
        void pickAndUpload(false, parentDir);
        break;
      case "uploadFolder":
        void pickAndUpload(true, parentDir);
        break;
      case "download":
        if (entry) void transferStore.getState().downloadEntry(entry);
        break;
      case "rename":
        if (entry) openDialog({ kind: "rename", path: entry.path, name: entry.name });
        break;
      case "delete":
        if (entry) {
          openDialog({
            kind: "delete",
            path: entry.path,
            name: entry.name,
            isDir: entry.kind === "dir",
          });
        }
        break;
      case "refresh":
        void explorerStore.getState().refresh(parentDir);
        break;
    }
  }

  async function submitDialog() {
    if (!dialog || busy) return;
    const trimmed = input.trim();
    if (dialog.kind !== "delete") {
      if (
        !trimmed ||
        trimmed === "." ||
        trimmed === ".." ||
        trimmed.includes("/") ||
        trimmed.includes("\\") ||
        trimmed.includes("\0")
      ) {
        showErrorToast("名称无效：不能为空、'.' / '..'，也不能包含 '/'、'\\' 或空字符。");
        return;
      }
    }
    setBusy(true);
    try {
      if (dialog.kind === "newFile") {
        const path = joinChildPath(dialog.parent, trimmed);
        await filesApi.createFile(path);
        await explorerStore.getState().refresh(dialog.parent);
        await tabsStore.getState().openFile({
          name: trimmed,
          path,
          kind: "file",
          size: 0,
          modifiedMs: Date.now(),
        });
      } else if (dialog.kind === "newFolder") {
        await filesApi.createDir(joinChildPath(dialog.parent, trimmed));
        await explorerStore.getState().refresh(dialog.parent);
      } else if (dialog.kind === "rename") {
        const parent = explorerStore.getState().parentOf(dialog.path);
        if (parent) {
          const newPath = joinChildPath(parent, trimmed);
          if (newPath !== dialog.path) {
            await filesApi.renameEntry(dialog.path, newPath);
            tabsStore.getState().handlePathRenamed(dialog.path, newPath);
            await explorerStore.getState().refresh(parent);
          }
        }
      } else if (dialog.kind === "delete") {
        await filesApi.deleteEntry(dialog.path, dialog.isDir);
        tabsStore.getState().handlePathDeleted(dialog.path, dialog.isDir);
        const parent = explorerStore.getState().parentOf(dialog.path);
        if (parent) await explorerStore.getState().refresh(parent);
      }
      setDialog(null);
    } catch (err) {
      showErrorToast(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const menuItemClass =
    "block w-full px-3 py-1.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-700";
  const toolbarBtnClass =
    "flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200";

  return (
    <div className="flex h-full flex-col bg-zinc-900">
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <span>资源管理器</span>
        {rootPath && (
          <button
            type="button"
            title="关闭文件夹"
            onClick={closeRoot}
            className={toolbarBtnClass}
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
            <span
              className="min-w-0 flex-1 truncate whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-zinc-300"
              title={rootPath || "文件"}
            >
              {rootName || "文件"}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                title="上传文件到此工作区"
                onClick={() => void pickAndUpload(false, rootPath)}
                className={toolbarBtnClass}
              >
                <IconUpload size={14} />
              </button>
              <button
                type="button"
                title="上传文件夹到此工作区"
                onClick={() => void pickAndUpload(true, rootPath)}
                className={toolbarBtnClass}
              >
                <IconFolderPlus size={14} />
              </button>
              <button
                type="button"
                title="打开其他文件夹"
                onClick={pickFolder}
                className={toolbarBtnClass}
              >
                <IconFolder size={14} />
              </button>
              <button
                type="button"
                title="新建文件"
                onClick={() => openDialog({ kind: "newFile", parent: rootPath })}
                className={toolbarBtnClass}
              >
                <IconPlus size={14} />
              </button>
              <button
                type="button"
                title="刷新"
                onClick={() => void explorerStore.getState().refresh(rootPath)}
                className={toolbarBtnClass}
              >
                <IconRefresh size={14} />
              </button>
            </div>
          </div>

          <div
            ref={dropZoneRef}
            data-drop-dir={rootPath}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ entry: null, x: e.clientX, y: e.clientY });
            }}
            className={`relative flex-1 overflow-y-auto pb-2 transition-colors ${
              dropTargetDir === rootPath
                ? "bg-sky-500/10 ring-1 ring-inset ring-sky-500/70"
                : ""
            }`}
          >
            {rootError ? (
              <p className="px-3 py-2 text-xs text-red-400">{rootError}</p>
            ) : (
              <TreeNode
                dirPath={rootPath}
                depth={0}
                dropTargetDir={dropTargetDir}
                onContextMenu={(entry, x, y) => setMenu({ entry, x, y })}
              />
            )}
            {dropTargetDir && (
              <div className="pointer-events-none sticky bottom-2 mx-3 mt-2 rounded border border-sky-500/50 bg-zinc-950/90 px-2.5 py-1 text-center text-[11px] text-sky-300 shadow">
                松开以上传到：{dropTargetDir === rootPath ? rootName || "/" : dropTargetDir}
              </div>
            )}
          </div>

          <TransferQueuePanel />
        </>
      )}

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-44 rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 190),
            top: Math.min(menu.y, window.innerHeight - 280),
          }}
        >
          {(!menu.entry || menu.entry.kind === "dir") && (
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
          <button className={menuItemClass} onClick={() => menuAction("uploadFiles")}>
            {menu.entry?.kind === "dir" ? "上传文件到此目录…" : "上传文件到此所在目录…"}
          </button>
          <button className={menuItemClass} onClick={() => menuAction("uploadFolder")}>
            {menu.entry?.kind === "dir" ? "上传文件夹到此目录…" : "上传文件夹到此所在目录…"}
          </button>
          {menu.entry && (
            <button className={menuItemClass} onClick={() => menuAction("download")}>
              {menu.entry.kind === "dir" ? "下载此文件夹…" : "下载此文件…"}
            </button>
          )}
          <div className="my-1 border-t border-zinc-700" />
          {menu.entry && (
            <button className={menuItemClass} onClick={() => menuAction("rename")}>
              重命名
            </button>
          )}
          <button className={menuItemClass} onClick={() => menuAction("refresh")}>
            刷新
          </button>
          {menu.entry && (
            <>
              <div className="my-1 border-t border-zinc-700" />
              <button
                className="block w-full px-3 py-1.5 text-left text-sm text-red-400 transition-colors hover:bg-zinc-700"
                onClick={() => menuAction("delete")}
              >
                删除
              </button>
            </>
          )}
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
              {dialog.kind === "delete" ? (
                <DangerButton onClick={submitDialog} disabled={busy}>
                  删除
                </DangerButton>
              ) : (
                <PrimaryButton
                  onClick={submitDialog}
                  disabled={busy || input.trim().length === 0}
                >
                  确定
                </PrimaryButton>
              )}
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
                if (e.key === "Enter" && !busy && input.trim().length > 0) {
                  void submitDialog();
                }
              }}
              placeholder="输入名称"
              className="w-full rounded border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-600"
            />
          )}
        </Modal>
      )}

      {pendingConflict && (
        <Modal
          title="目标目录存在同名项"
          onClose={() => void resolveConflict("cancel")}
          footer={
            <>
              <Button onClick={() => void resolveConflict("cancel")}>取消</Button>
              <Button onClick={() => void resolveConflict("skip")}>跳过已存在</Button>
              <PrimaryButton onClick={() => void resolveConflict("overwrite")}>
                覆盖同名项
              </PrimaryButton>
            </>
          }
        >
          <div className="space-y-2 text-xs text-zinc-300">
            <p>
              目标路径中已存在以下 {pendingConflict.conflicts.length} 个同名文件或文件夹：
            </p>
            <ul className="max-h-36 space-y-1 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-[11px] text-zinc-200">
              {pendingConflict.conflicts.slice(0, 8).map((c) => (
                <li key={c.destPath} className="truncate">
                  {c.isDir ? "📁 " : "📄 "}
                  {c.name}
                </li>
              ))}
              {pendingConflict.conflicts.length > 8 && (
                <li className="text-zinc-500">
                  …等共 {pendingConflict.conflicts.length} 项
                </li>
              )}
            </ul>
            <p className="text-[11px] text-zinc-400">
              选择「覆盖同名项」将覆盖同名文件并合并同名目录内容；选择「跳过已存在」将保留目标端原有文件。
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
