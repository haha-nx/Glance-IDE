import type { ReactNode } from "react";
import { tabsStore } from "../../stores/tabs";
import { IconClose, IconWarning } from "../../components/common/icons";

interface TabBarProps {
  /** 右侧工具区（预览/Diff 切换等） */
  actions?: ReactNode;
}

export function TabBar({ actions }: TabBarProps) {
  const tabs = tabsStore((s) => s.tabs);
  const activeId = tabsStore((s) => s.activeId);
  const setActive = tabsStore((s) => s.setActive);
  const requestClose = tabsStore((s) => s.requestClose);

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-zinc-800 bg-zinc-950">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.uri}
            onClick={() => setActive(tab.uri)}
            onAuxClick={(e) => {
              if (e.button === 1) requestClose(tab.uri);
            }}
            title={tab.path}
            className={`group flex min-w-32 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 border-r border-zinc-800 px-3 text-sm ${
              activeId === tab.uri
                ? "bg-zinc-900 text-zinc-100"
                : "bg-zinc-950 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.error ? (
              <span className="text-red-400">
                <IconWarning size={14} />
              </span>
            ) : (
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  tab.dirty ? "bg-amber-400" : "bg-transparent"
                }`}
              />
            )}
            <span className="truncate">{tab.name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                requestClose(tab.uri);
              }}
              className="ml-auto rounded px-1 text-zinc-600 opacity-0 hover:text-zinc-200 group-hover:opacity-100"
              title="关闭"
            >
              <IconClose size={12} />
            </button>
          </div>
        ))}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-1 border-l border-zinc-800 px-2">{actions}</div>
      )}
    </div>
  );
}
