import { IconFiles, IconSearch, IconRemote, IconRadar } from "./icons";

const items = [
  { id: "explorer", label: "资源管理器", Icon: IconFiles },
  { id: "search", label: "搜索", Icon: IconSearch },
  { id: "remote", label: "远程连接与 WSL", Icon: IconRemote },
  { id: "discovery", label: "局域网发现", Icon: IconRadar },
] as const;

interface ActivityBarProps {
  active: string;
  onActivate: (id: string) => void;
}

export function ActivityBar({ active, onActivate }: ActivityBarProps) {
  return (
    <div className="flex w-12 flex-col items-center gap-1 border-r border-zinc-800 bg-zinc-950 py-2">
      {items.map(({ id, label, Icon }) => {
        const isSelected = active === id || (id === "remote" && (active === "ssh" || active === "wsl"));
        return (
          <button
            key={id}
            title={label}
            onClick={() => onActivate(id)}
            className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
              isSelected
                ? "bg-zinc-800 text-sky-400"
                : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
            }`}
          >
            <Icon size={22} strokeWidth={1.2} />
          </button>
        );
      })}
    </div>
  );
}
