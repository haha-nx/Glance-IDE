import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { AppTheme } from "../../stores/settings";

export function terminalThemeFor(theme: AppTheme) {
  switch (theme) {
    case "midnight":
      return {
        background: "#090d16",
        foreground: "#cbd5e1",
        cursor: "#38bdf8",
        selectionBackground: "#38bdf855",
      };
    case "nord":
      return {
        background: "#232831",
        foreground: "#d8dee9",
        cursor: "#88c0d0",
        selectionBackground: "#88c0d044",
      };
    case "light":
      return {
        background: "#f8fafc",
        foreground: "#1e293b",
        cursor: "#0284c7",
        cursorAccent: "#ffffff",
        selectionBackground: "#0284c733",
        black: "#1e293b",
        red: "#dc2626",
        green: "#16a34a",
        yellow: "#ca8a04",
        blue: "#2563eb",
        magenta: "#9333ea",
        cyan: "#0891b2",
        white: "#64748b",
        brightBlack: "#475569",
        brightRed: "#ef4444",
        brightGreen: "#22c55e",
        brightYellow: "#d97706",
        brightBlue: "#3b82f6",
        brightMagenta: "#a855f7",
        brightCyan: "#06b6d4",
        brightWhite: "#0f172a",
      };
    default:
      return {
        background: "#131316",
        foreground: "#d4d4d8",
        cursor: "#38bdf8",
        selectionBackground: "#38bdf855",
      };
  }
}

export interface TermTabItem {
  id: string;
  title: string;
  type: "local" | "wsl" | "ssh";
  channelId: string;
  /** SSH 终端关联的设备身份，用于会话掉线时精准回收对应标签 */
  deviceIdentityId?: string;
  /** 用户是否已在该终端输入过内容，防止自动连接替换掉正在使用的本机终端 */
  hasInput: boolean;
  term: XTerm;
  fit: FitAddon;
  container: HTMLDivElement;
}

/** 终端分屏窗格：每个窗格拥有独立的标签栏与活动终端 */
export interface TermPane {
  id: string;
  tabIds: string[];
  activeId: string | null;
}

export interface TermDragState {
  termId: string;
  fromPaneId: string;
  title: string;
  x: number;
  y: number;
  target: { paneId: string; zone: "tabbar" | "center" | "left" | "right"; index?: number } | null;
}

export interface TerminalPanelProps {
  visible?: boolean;
  onClose: () => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  onTerminalCountChange?: (count: number) => void;
}
