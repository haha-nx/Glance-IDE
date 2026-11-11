import { gitStore } from "../../stores/git";
import { IconFiles, IconSearch, IconGitBranch, IconRemote, IconRadar } from "./icons";
import { IS_MAC } from "../../lib/platform";

const items = [
  { id: "explorer", label: "资源管理器", Icon: IconFiles },
  { id: "search", label: "搜索", Icon: IconSearch },
  { id: "git", label: "源代码管理", Icon: IconGitBranch },
  { id: "remote", label: IS_MAC ? "远程连接" : "远程连接与 WSL", Icon: IconRemote },
  { id: "discovery", label: "局域网发现", Icon: IconRadar },
] as const;

interface ActivityBarProps {
  active: string;
  onActivate: (id: string) => void;
}

export function ActivityBar({ active, onActivate }: ActivityBarProps) {
  const overview = gitStore((s) => s.overview);
  const changeCount = overview?.isRepo
    ? overview.staged.length + overview.changes.length
    : 0;

  return (
    <div className="flex w-12 flex-col items-center gap-1 border-r border-zinc-800 bg-zinc-950 py-2">
      {items.map(({ id, label, Icon }) => {
        const isSelected =
          active === id || (id === "remote" && (active === "ssh" || active === "wsl"));
        const badgeCount = id === "git" ? changeCount : 0;
        return (
          <button
            key={id}
            title={badgeCount > 0 ? `${label} (${badgeCount} 个挂起的更改)` : label}
            data-tooltip-side="right"
            onClick={() => onActivate(id)}
            className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
              isSelected
                ? "bg-zinc-800 text-sky-400"
                : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
            }`}
          >
            <Icon size={22} strokeWidth={1.2} />
            {badgeCount > 0 && (
              <span className="absolute right-0.5 bottom-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-sky-600 px-1 text-[9px] font-semibold leading-none text-white shadow">
                {badgeCount > 99 ? "99+" : badgeCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
