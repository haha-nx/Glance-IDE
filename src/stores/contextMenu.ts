import { create } from "zustand";

export type ContextMenuEntry =
  | { type: "separator" }
  | {
      type?: "item";
      label: string;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      action: () => void | Promise<void>;
    };

export interface ContextMenuData {
  x: number;
  y: number;
  items: ContextMenuEntry[];
}

interface ContextMenuState {
  menu: ContextMenuData | null;
  open: (x: number, y: number, items: ContextMenuEntry[]) => void;
  close: () => void;
}

/** 全局唯一自定义右键菜单状态（保证任意时刻最多只展开一个菜单） */
export const contextMenuStore = create<ContextMenuState>()((set) => ({
  menu: null,
  open: (x, y, items) => set({ menu: { x, y, items } }),
  close: () => set((s) => (s.menu ? { menu: null } : s)),
}));
