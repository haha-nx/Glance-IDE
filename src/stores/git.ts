import { create } from "zustand";
import { gitApi, type GitOverviewDto } from "../services/git";

interface GitStoreState {
  overview: GitOverviewDto | null;
  loading: boolean;
  error: string | null;
  lastRoot: string | null;
  graphAllBranches: boolean;
  setGraphAllBranches(all: boolean): void;
  refresh(root: string | null, silent?: boolean): Promise<GitOverviewDto | null>;
  clearError(): void;
  clear(): void;
}

let refreshGen = 0;

export const gitStore = create<GitStoreState>()((set, get) => ({
  overview: null,
  loading: false,
  error: null,
  lastRoot: null,
  graphAllBranches: true,

  setGraphAllBranches: (all) => {
    set({ graphAllBranches: all });
    const root = get().lastRoot;
    if (root) {
      void get().refresh(root, true);
    }
  },

  refresh: async (root, silent = false) => {
    const gen = ++refreshGen;
    if (!root) {
      set({ overview: null, loading: false, error: null, lastRoot: null });
      return null;
    }
    if (!silent) set({ loading: true, error: null });
    try {
      const data = await gitApi.overview(root, get().graphAllBranches);
      if (gen !== refreshGen) return null;
      set({ overview: data, loading: false, error: null, lastRoot: root });
      return data;
    } catch (e) {
      if (gen !== refreshGen) return null;
      const msg = e instanceof Error ? e.message : String(e);
      set({
        loading: false,
        error: silent ? get().error : msg,
        lastRoot: root,
      });
      return null;
    }
  },

  clearError: () => set({ error: null }),

  clear: () => {
    refreshGen += 1;
    set({ overview: null, loading: false, error: null, lastRoot: null });
  },
}));
