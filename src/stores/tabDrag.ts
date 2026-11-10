import { create } from "zustand";

/** 编辑器标签拖拽分屏状态（基于指针事件实现，不依赖 HTML5 DnD，避免 Tauri 窗口拖放拦截） */
export type DropZone = "tabbar" | "center" | "left" | "right" | "top" | "bottom";

export interface TabDragState {
  drag: { uri: string; fromGroupId: string; label: string; x: number; y: number } | null;
  target: { groupId: string; zone: DropZone; index?: number } | null;
  setDrag(drag: TabDragState["drag"]): void;
  setTarget(target: TabDragState["target"]): void;
}

export const tabDragStore = create<TabDragState>()((set) => ({
  drag: null,
  target: null,
  setDrag: (drag) => set({ drag }),
  setTarget: (target) => set({ target }),
}));
