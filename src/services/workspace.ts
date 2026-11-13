import { invokeIpc } from "../lib/ipc";

export interface SearchHit {
  path: string;
  lineNumber: number;
  lineText: string;
  matchStart: number;
  matchLen: number;
}

export const workspaceApi = {
  async search(root: string, query: string): Promise<SearchHit[]> {
    return invokeIpc<SearchHit[]>("search_workspace", { root, query });
  },

  async getUiState(key: string): Promise<string | null> {
    return invokeIpc<string | null>("get_ui_state", { key });
  },

  async setUiState(key: string, value: string): Promise<void> {
    await invokeIpc("set_ui_state", { key, value });
  },
};
