import type { GitFileEntryDto } from "../../services/git";

export const SCM_SPLIT_STORAGE_KEY = "glance:scm-split-ratio";
export const DEFAULT_SPLIT_RATIO = 0.52;

export function loadSavedSplitRatio(): number {
  try {
    const raw = localStorage.getItem(SCM_SPLIT_STORAGE_KEY);
    if (!raw) return DEFAULT_SPLIT_RATIO;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0.2 && n <= 0.85) return n;
  } catch {
    // 忽略本地存储读取异常
  }
  return DEFAULT_SPLIT_RATIO;
}

export function statusColorClass(status: string): string {
  switch (status) {
    case "M":
      return "text-amber-400";
    case "A":
      return "text-emerald-400";
    case "D":
      return "text-red-400";
    case "U":
      return "text-sky-400";
    case "C":
      return "text-red-300";
    default:
      return "text-zinc-400";
  }
}

export function splitPathParts(relPath: string): { name: string; dir: string } {
  const norm = relPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx < 0) return { name: norm, dir: "" };
  return { name: norm.slice(idx + 1), dir: norm.slice(0, idx) };
}

export function suggestWorktreePath(repoRoot: string, branchName: string): string {
  const norm = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = norm.lastIndexOf("/");
  const parent = slash > 0 ? norm.slice(0, slash) : "";
  const repoName = slash >= 0 ? norm.slice(slash + 1) : norm;
  const safeBranch = (branchName.trim() || "feature")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return parent ? `${parent}/${repoName}-worktrees/${safeBranch || "wt"}` : `${repoName}-${safeBranch || "wt"}`;
}

export function IconCheck({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

export function IconMore({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.2" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.8" cy="8" r="1.2" />
    </svg>
  );
}

export function IconWorktree({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.2" width="4.5" height="4.5" rx="1" />
      <rect x="9.5" y="2.2" width="4.5" height="4.5" rx="1" />
      <rect x="9.5" y="9.3" width="4.5" height="4.5" rx="1" />
      <path d="M4.25 6.7v4.8H9.5M6.5 4.45h3" />
    </svg>
  );
}

export function ChangeRow({
  item,
  onOpen,
  actions,
}: {
  item: GitFileEntryDto;
  onOpen: () => void;
  actions: React.ReactNode;
}) {
  const { name, dir } = splitPathParts(item.path);
  return (
    <div
      onClick={onOpen}
      title={`${item.path}（点击查看文件对比）`}
      className="group flex cursor-pointer items-center justify-between gap-2 px-3 py-1 text-xs hover:bg-zinc-800/70"
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-zinc-200">{name}</span>
        {dir && <span className="truncate text-[10px] text-zinc-500">{dir}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <div className="hidden items-center gap-0.5 group-hover:flex">{actions}</div>
        <span className={`w-3.5 text-center font-mono text-[11px] font-semibold ${statusColorClass(item.status)}`}>
          {item.status}
        </span>
      </div>
    </div>
  );
}
