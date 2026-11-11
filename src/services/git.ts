import { invoke } from "@tauri-apps/api/core";

export interface GitFileEntryDto {
  path: string;
  oldPath: string | null;
  uri: string;
  status: string;
  staged: boolean;
}

export interface GitWorktreeDto {
  path: string;
  uri: string;
  head: string;
  branch: string | null;
  isBare: boolean;
  isDetached: boolean;
  isLocked: boolean;
  isPrunable: boolean;
  isMain: boolean;
  isCurrent: boolean;
}

export interface GitBranchDto {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitRefDto {
  name: string;
  kind: "head" | "branch" | "remote" | "tag" | string;
  isCurrent: boolean;
}

export interface GitCommitDto {
  hash: string;
  shortHash: string;
  parents: string[];
  refs: GitRefDto[];
  subject: string;
  author: string;
  relativeTime: string;
  isHead: boolean;
}

export interface GitCommitFileDto {
  path: string;
  oldPath: string | null;
  uri: string;
  status: string;
}

export interface GitFileDiffDto {
  repoRootUri: string;
  fileUri: string;
  filePath: string;
  originalLabel: string;
  modifiedLabel: string;
  originalText: string;
  modifiedText: string;
  isBinary: boolean;
  errorNote: string | null;
}

export interface GitFileDiffRequest {
  root: string;
  mode: "working" | "staged" | "commit";
  path: string;
  oldPath?: string | null;
  status?: string;
  commitHash?: string;
  parentHash?: string | null;
}

export interface GitOverviewDto {
  isRepo: boolean;
  gitAvailable: boolean;
  repoRoot: string | null;
  repoRootUri: string | null;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileEntryDto[];
  changes: GitFileEntryDto[];
  worktrees: GitWorktreeDto[];
  branches: GitBranchDto[];
  commits: GitCommitDto[];
  graphError: string | null;
  message: string | null;
}

function errMsg(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return err instanceof Error ? err.message : String(err);
}

export const gitApi = {
  async overview(root: string, allBranches = true): Promise<GitOverviewDto> {
    try {
      return await invoke<GitOverviewDto>("git_overview", { root, allBranches });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async commitFiles(root: string, hash: string): Promise<GitCommitFileDto[]> {
    try {
      return await invoke<GitCommitFileDto[]>("git_commit_files", { root, hash });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async fileDiff(params: GitFileDiffRequest): Promise<GitFileDiffDto> {
    try {
      return await invoke<GitFileDiffDto>("git_file_diff", {
        root: params.root,
        mode: params.mode,
        path: params.path,
        oldPath: params.oldPath ?? null,
        status: params.status ?? null,
        commitHash: params.commitHash ?? null,
        parentHash: params.parentHash ?? null,
      });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async init(root: string): Promise<void> {
    try {
      await invoke("git_init", { root });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async stage(root: string, paths: string[] = []): Promise<void> {
    try {
      await invoke("git_stage", { root, paths });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async unstage(root: string, paths: string[] = []): Promise<void> {
    try {
      await invoke("git_unstage", { root, paths });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async discard(root: string, path: string, untracked: boolean): Promise<void> {
    try {
      await invoke("git_discard", { root, path, untracked });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async discardAll(root: string): Promise<void> {
    try {
      await invoke("git_discard_all", { root });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async commit(root: string, message: string): Promise<string> {
    try {
      return await invoke<string>("git_commit", { root, message });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async checkout(root: string, branch: string, create = false): Promise<void> {
    try {
      await invoke("git_checkout", { root, branch, create });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async pull(root: string): Promise<string> {
    try {
      return await invoke<string>("git_pull", { root });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async push(root: string): Promise<string> {
    try {
      return await invoke<string>("git_push", { root });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async fetch(root: string): Promise<void> {
    try {
      await invoke("git_fetch", { root });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async worktreeAdd(params: {
    root: string;
    targetPath: string;
    branch: string;
    createBranch: boolean;
    baseRef?: string;
  }): Promise<string> {
    try {
      return await invoke<string>("git_worktree_add", {
        root: params.root,
        targetPath: params.targetPath,
        branch: params.branch,
        createBranch: params.createBranch,
        baseRef: params.baseRef?.trim() || null,
      });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async worktreeRemove(root: string, worktreePath: string, force = false): Promise<void> {
    try {
      await invoke("git_worktree_remove", { root, worktreePath, force });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },

  async worktreePrune(root: string): Promise<void> {
    try {
      await invoke("git_worktree_prune", { root });
    } catch (e) {
      throw new Error(errMsg(e));
    }
  },
};
