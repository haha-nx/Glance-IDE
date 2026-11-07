import { useEffect } from "react";
import { explorerStore } from "../../stores/explorer";
import { tabsStore } from "../../stores/tabs";
import type { FileEntryDto } from "../../types/ipc";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconSymlink,
} from "../../components/common/icons";

interface TreeNodeProps {
  dirPath: string;
  depth: number;
  onContextMenu: (entry: FileEntryDto, x: number, y: number) => void;
}

function TreeGlyph({ entry }: { entry: FileEntryDto }) {
  if (entry.kind === "dir") return <IconFolder size={14} />;
  if (entry.kind === "symlink") return <IconSymlink size={14} />;
  return <IconFile size={14} />;
}

export function TreeNode({ dirPath, depth, onContextMenu }: TreeNodeProps) {
  const children = explorerStore((s) => s.childrenMap[dirPath]);
  const expanded = explorerStore((s) => s.expanded[dirPath]);
  const selectedPath = explorerStore((s) => s.selectedPath);
  const loading = explorerStore((s) => s.loadingDirs[dirPath]);

  useEffect(() => {
    if (expanded && !children && !loading) {
      void explorerStore.getState().ensureLoaded(dirPath);
    }
  }, [expanded, children, loading, dirPath]);

  if (!expanded) return null;
  if (!children) {
    return (
      <div
        className="px-3 py-0.5 text-xs text-zinc-600"
        style={{ paddingLeft: 12 + depth * 14 }}
      >
        {loading ? "加载中…" : "(空)"}
      </div>
    );
  }

  return (
    <div>
      {children.map((entry) => {
        const isSelected = selectedPath === entry.path;
        const isDir = entry.kind === "dir";
        const isExpanded = !!explorerStore.getState().expanded[entry.path];

        return (
          <div key={entry.path}>
            <div
              className={`flex cursor-pointer items-center gap-1.5 py-[3px] pr-2 hover:bg-zinc-800/70 ${
                isSelected ? "bg-zinc-800" : ""
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => {
                explorerStore.getState().select(entry.path);
                if (isDir) {
                  void explorerStore.getState().toggleDir(entry.path);
                } else {
                  void tabsStore.getState().openFile(entry);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                explorerStore.getState().select(entry.path);
                onContextMenu(entry, e.clientX, e.clientY);
              }}
            >
              <span className="flex w-3 items-center justify-center text-zinc-500">
                {isDir &&
                  (isExpanded ? (
                    <IconChevronDown size={12} strokeWidth={1.5} />
                  ) : (
                    <IconChevronRight size={12} strokeWidth={1.5} />
                  ))}
              </span>
              <span className={isDir ? "text-sky-400/90" : "text-zinc-400"}>
                <TreeGlyph entry={entry} />
              </span>
              <span className="truncate text-sm text-zinc-300">{entry.name}</span>
            </div>
            {isDir && (
              <TreeNode
                dirPath={entry.path}
                depth={depth + 1}
                onContextMenu={onContextMenu}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
