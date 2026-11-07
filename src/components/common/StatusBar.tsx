import { useEffect, useState } from "react";
import { tabsStore } from "../../stores/tabs";
import { uiStore } from "../../stores/ui";
import { appApi } from "../../services/files";

interface StatusBarProps {
  onToggleTerminal?: () => void;
}

export function StatusBar({ onToggleTerminal }: StatusBarProps) {
  const activeId = tabsStore((s) => s.activeId);
  const tabs = tabsStore((s) => s.tabs);
  const line = uiStore((s) => s.line);
  const column = uiStore((s) => s.column);
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    appApi
      .getInfo()
      .then((info) => setVersion(`${info.name} ${info.version}`))
      .catch(() => setVersion("Glance IDE"));
  }, []);

  const active = tabs.find((t) => t.uri === activeId);
  const dirtyCount = tabs.filter((t) => t.dirty).length;

  return (
    <div className="flex h-6 items-center justify-between border-t border-zinc-800 bg-zinc-950 px-3 text-xs text-zinc-500">
      <div className="flex items-center gap-3">
        <span className="text-sky-500">{version || "Glance IDE"}</span>
        {active && <span title={active.path}>{active.path}</span>}
      </div>
      <div className="flex items-center gap-4">
        {dirtyCount > 0 && (
          <span className="text-amber-500">{dirtyCount} 个未保存</span>
        )}
        {active && !active.error && (
          <>
            <span>
              行 {line}, 列 {column}
            </span>
            <span>UTF-8</span>
          </>
        )}
        {active?.readonly && <span className="text-amber-500">只读</span>}
        <button
          onClick={onToggleTerminal}
          className="rounded px-1 hover:bg-zinc-800 hover:text-zinc-300"
          title="终端 / 任务（Ctrl+`）"
        >
          ▮ 终端
        </button>
      </div>
    </div>
  );
}
