import { useEffect } from "react";
import { explorerStore } from "../../stores/explorer";
import { settingsStore } from "../../stores/settings";
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
  dropTargetDir?: string | null;
  onContextMenu: (entry: FileEntryDto, x: number, y: number) => void;
}

function TreeGlyph({ entry, size }: { entry: FileEntryDto; size: number }) {
  if (entry.kind === "dir") return <IconFolder size={size} />;
  if (entry.kind === "symlink") return <IconSymlink size={size} />;
  return <IconFile size={size} />;
}

export function TreeNode({ dirPath, depth, dropTargetDir, onContextMenu }: TreeNodeProps) {
  const children = explorerStore((s) => s.childrenMap[dirPath]);
  const expanded = explorerStore((s) => s.expanded[dirPath]);
  const expandedMap = explorerStore((s) => s.expanded);
  const selectedPath = explorerStore((s) => s.selectedPath);
  const loading = explorerStore((s) => s.loadingDirs[dirPath]);
  const explorerFontScale = settingsStore((s) => s.explorerFontScale);

  const scale = explorerFontScale / 100;
  const fontPx = Number((14 * scale).toFixed(1));
  const iconSize = Math.round(14 * scale);
  const chevronSize = Math.round(12 * scale);
  const rowPadY = Math.max(2, Math.round(3 * scale));
  const indentPx = Math.round((8 + depth * 14) * scale);
  const gapPx = Math.max(4, Math.round(6 * scale));

  useEffect(() => {
    if (expanded && !children && !loading) {
      void explorerStore.getState().ensureLoaded(dirPath);
    }
  }, [expanded, children, loading, dirPath]);

  if (!expanded) return null;
  if (!children) {
    return (
      <div
        className="px-3 py-0.5 text-zinc-600"
        style={{
          paddingLeft: Math.round((12 + depth * 14) * scale),
          fontSize: `${Math.max(11, Math.round(12 * scale))}px`,
        }}
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
        const isExpanded = !!expandedMap[entry.path];
        const isDropHover = isDir && dropTargetDir === entry.path;

        return (
          <div key={entry.path}>
            <div
              data-drop-dir={isDir ? entry.path : dirPath}
              className={`flex cursor-pointer items-center pr-2 transition-colors hover:bg-zinc-800/70 ${
                isDropHover
                  ? "bg-sky-500/20 ring-1 ring-inset ring-sky-500/70"
                  : isSelected
                    ? "bg-zinc-800"
                    : ""
              }`}
              style={{
                paddingLeft: indentPx,
                paddingTop: rowPadY,
                paddingBottom: rowPadY,
                gap: gapPx,
              }}
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
                e.stopPropagation();
                explorerStore.getState().select(entry.path);
                onContextMenu(entry, e.clientX, e.clientY);
              }}
            >
              <span
                className="flex shrink-0 items-center justify-center text-zinc-500"
                style={{ width: Math.round(14 * scale) }}
              >
                {isDir &&
                  (isExpanded ? (
                    <IconChevronDown size={chevronSize} strokeWidth={1.5} />
                  ) : (
                    <IconChevronRight size={chevronSize} strokeWidth={1.5} />
                  ))}
              </span>
              <span className={isDir ? "shrink-0 text-sky-400/90" : "shrink-0 text-zinc-400"}>
                <TreeGlyph entry={entry} size={iconSize} />
              </span>
              <span
                className={isSelected ? "truncate text-zinc-100" : "truncate text-zinc-200"}
                style={{ fontSize: `${fontPx}px`, lineHeight: 1.45 }}
              >
                {entry.name}
              </span>
            </div>
            {isDir && (
              <TreeNode
                dirPath={entry.path}
                depth={depth + 1}
                dropTargetDir={dropTargetDir}
                onContextMenu={onContextMenu}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
