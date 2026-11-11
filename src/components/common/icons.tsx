import type { ReactNode } from "react";

/**
 * 单色 2D 图标集（16×16 线性风格，currentColor 随文本颜色）。
 * 统一 stroke 描边、圆角端点，保证在暗色主题下的可读性。
 */

export interface IconProps {
  /** 像素尺寸，默认 16 */
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function Svg({
  size = 16,
  className,
  strokeWidth = 1.3,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 活动栏：文件（双页纸） */
export function IconFiles(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5.75" y="1.75" width="8.5" height="10.5" rx="1.2" />
      <path d="M2.75 4.25v8.5a1.5 1.5 0 0 0 1.5 1.5H11" />
    </Svg>
  );
}

/** 活动栏：搜索 */
export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m13.4 13.4-3.2-3.2" />
    </Svg>
  );
}

/** 活动栏：远程设备（带提示符的终端屏幕） */
export function IconRemote(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="1.75" y="2.25" width="12.5" height="9" rx="1.2" />
      <path d="m4.25 5.25 2 1.75-2 1.75" />
      <path d="M8.25 9h3.25" />
      <path d="M8 11.25v2.5M5.5 13.75h5" />
    </Svg>
  );
}

/** 活动栏：局域网发现（广播波） */
export function IconRadar(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="1.35" fill="currentColor" stroke="none" />
      <path d="M5.2 5.2a4 4 0 0 0 0 5.6" />
      <path d="M10.8 5.2a4 4 0 0 1 0 5.6" />
      <path d="M3.1 3.1a7 7 0 0 0 0 9.8" />
      <path d="M12.9 3.1a7 7 0 0 1 0 9.8" />
    </Svg>
  );
}

/** 树形展开/收起箭头 */
export function IconChevronRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m6.25 4 4 4-4 4" />
    </Svg>
  );
}

export function IconChevronDown(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m4 6.25 4 4 4-4" />
    </Svg>
  );
}

/** 文件夹 */
export function IconFolder(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3.1l1.5 1.6h5.4a1.25 1.25 0 0 1 1.25 1.25v6.9A1.25 1.25 0 0 1 13 14H3a1.25 1.25 0 0 1-1.25-1.25Z" />
    </Svg>
  );
}

/** 文件（折角页） */
export function IconFile(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.25 1.75h4.25L12 5.25v8a1.25 1.25 0 0 1-1.25 1.25h-6.5A1.25 1.25 0 0 1 3 13.25v-10.25a1.25 1.25 0 0 1 1.25-1.25Z" />
      <path d="M8.5 1.9v3.35H12" />
    </Svg>
  );
}

/** 符号链接（弧线箭头） */
export function IconSymlink(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 12.5c0-4.4 2.7-6.9 6.9-7" />
      <path d="m8 3.5 3 2-3 2" />
    </Svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </Svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.29" />
      <path d="M13.35 1.65v2.64h-2.64" />
    </Svg>
  );
}

export function IconClose(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5" />
    </Svg>
  );
}

/** 警告（三角叹号） */
export function IconWarning(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.25 14.75 13.75H1.25Z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.6" r="0.55" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 编辑（铅笔） */
export function IconEdit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 3.25 12.75 6.5 6.25 13H3v-3.25Z" />
      <path d="M8.25 4.5l3.25 3.25" />
    </Svg>
  );
}

/** 删除（垃圾桶） */
export function IconTrash(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.75 4.25h10.5" />
      <path d="M5.75 4.25V3a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v1.25" />
      <path d="M4.25 4.25l.7 9.05A1.25 1.25 0 0 0 6.2 14.5h3.6a1.25 1.25 0 0 0 1.25-1.2l.7-9.05" />
      <path d="M6.6 7v4.5M9.4 7v4.5" />
    </Svg>
  );
}

/** 连接（插头/链路）：两个对接半环 */
export function IconPlug(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5.5 3.5v3M10.5 3.5v3" />
      <path d="M3.25 6.5h9.5v2a4.75 4.75 0 0 1-9.5 0Z" />
      <path d="M8 13.25v1.5" />
    </Svg>
  );
}

/** WSL（Linux/终端控制台风格） */
export function IconWsl(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M5 6.5l2.5 2L5 10.5M9.5 10.5h2" />
    </Svg>
  );
}

/** Git 分支 / 工作树图标 */
export function IconGitBranch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="6" r="1.5" />
      <path d="M4.5 5v6" />
      <path d="M11.5 7.5c0 2.5-2.5 3-7 3" />
    </Svg>
  );
}
