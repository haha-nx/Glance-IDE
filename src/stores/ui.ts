import { create } from "zustand";

export interface UiState {
  /** 光标行（1-based） */
  line: number;
  /** 光标列（1-based） */
  column: number;
  setCursor(line: number, column: number): void;
}

export const uiStore = create<UiState>()((set) => ({
  line: 1,
  column: 1,
  setCursor: (line, column) => set({ line, column }),
}));
