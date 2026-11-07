import { invoke } from "@tauri-apps/api/core";

export interface SearchHit {
  path: string;
  lineNumber: number;
  lineText: string;
  matchStart: number;
  matchLen: number;
}

export const workspaceApi = {
  async search(root: string, query: string): Promise<SearchHit[]> {
    return invoke<SearchHit[]>("search_workspace", { root, query });
  },

  async getUiState(key: string): Promise<string | null> {
    return invoke<string | null>("get_ui_state", { key });
  },

  async setUiState(key: string, value: string): Promise<void> {
    await invoke("set_ui_state", { key, value });
  },
};
