//! Git 工作树（Worktrees）与工作区更改管理 Commands。
//! 统一支持本地仓库、WSL (`wsl://`) 与远程 SSH (`remote://`) 工作区。

mod actions;
mod cli;
mod inspect;
mod parsers;
mod types;

use tauri::State;

use crate::commands::CmdError;
use crate::AppState;

pub use types::{
    GitBranchDto, GitCommitDto, GitCommitFileDto, GitFileDiffDto, GitFileEntryDto,
    GitOverviewDto, GitRefDto, GitWorktreeDto,
};

#[tauri::command]
pub async fn git_overview(
    state: State<'_, AppState>,
    root: String,
    all_branches: Option<bool>,
) -> Result<GitOverviewDto, CmdError> {
    inspect::git_overview_impl(state, root, all_branches).await
}

#[tauri::command]
pub async fn git_commit_files(
    state: State<'_, AppState>,
    root: String,
    hash: String,
) -> Result<Vec<GitCommitFileDto>, CmdError> {
    inspect::git_commit_files_impl(state, root, hash).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn git_file_diff(
    state: State<'_, AppState>,
    root: String,
    mode: String,
    path: String,
    old_path: Option<String>,
    status: Option<String>,
    commit_hash: Option<String>,
    parent_hash: Option<String>,
) -> Result<GitFileDiffDto, CmdError> {
    inspect::git_file_diff_impl(
        state,
        root,
        mode,
        path,
        old_path,
        status,
        commit_hash,
        parent_hash,
    )
    .await
}

#[tauri::command]
pub async fn git_init(state: State<'_, AppState>, root: String) -> Result<(), CmdError> {
    actions::git_init_impl(state, root).await
}

#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    root: String,
    paths: Vec<String>,
) -> Result<(), CmdError> {
    actions::git_stage_impl(state, root, paths).await
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    root: String,
    paths: Vec<String>,
) -> Result<(), CmdError> {
    actions::git_unstage_impl(state, root, paths).await
}

#[tauri::command]
pub async fn git_discard(
    state: State<'_, AppState>,
    root: String,
    path: String,
    untracked: bool,
) -> Result<(), CmdError> {
    actions::git_discard_impl(state, root, path, untracked).await
}

#[tauri::command]
pub async fn git_discard_all(state: State<'_, AppState>, root: String) -> Result<(), CmdError> {
    actions::git_discard_all_impl(state, root).await
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    root: String,
    message: String,
) -> Result<String, CmdError> {
    actions::git_commit_impl(state, root, message).await
}

#[tauri::command]
pub async fn git_checkout(
    state: State<'_, AppState>,
    root: String,
    target_ref: String,
    create_new: bool,
) -> Result<(), CmdError> {
    actions::git_checkout_impl(state, root, target_ref, create_new).await
}

#[tauri::command]
pub async fn git_pull(state: State<'_, AppState>, root: String) -> Result<String, CmdError> {
    actions::git_pull_impl(state, root).await
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, root: String) -> Result<String, CmdError> {
    actions::git_push_impl(state, root).await
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, root: String) -> Result<(), CmdError> {
    actions::git_fetch_impl(state, root).await
}

#[tauri::command]
pub async fn git_worktree_add(
    state: State<'_, AppState>,
    root: String,
    target_path: String,
    branch: String,
    create_branch: bool,
    base_ref: Option<String>,
) -> Result<String, CmdError> {
    actions::git_worktree_add_impl(state, root, target_path, branch, create_branch, base_ref).await
}

#[tauri::command]
pub async fn git_worktree_remove(
    state: State<'_, AppState>,
    root: String,
    worktree_path: String,
    force: bool,
) -> Result<(), CmdError> {
    actions::git_worktree_remove_impl(state, root, worktree_path, force).await
}

#[tauri::command]
pub async fn git_worktree_prune(
    state: State<'_, AppState>,
    root: String,
) -> Result<(), CmdError> {
    actions::git_worktree_prune_impl(state, root).await
}

#[cfg(test)]
mod tests {
    use super::parsers::*;
    use super::types::*;

    #[test]
    fn parses_branch_header_with_ahead_behind() {
        let (b, u, a, beh) = parse_branch_header("## main...origin/main [ahead 3, behind 2]");
        assert_eq!(b, "main");
        assert_eq!(u.as_deref(), Some("origin/main"));
        assert_eq!(a, 3);
        assert_eq!(beh, 2);

        let (b2, u2, a2, beh2) = parse_branch_header("## No commits yet on feat/ui");
        assert_eq!(b2, "feat/ui");
        assert_eq!(u2, None);
        assert_eq!((a2, beh2), (0, 0));
    }

    #[test]
    fn parses_porcelain_status_both_staged_and_unstaged() {
        let raw = "## main\nMM src/App.tsx\n?? new file.ts\nR  old.txt -> new.txt\n";
        let target = GitTarget::Local {
            root: "E:/repo".into(),
        };
        let (branch, _, _, _, staged, changes) = parse_status_lines(raw, &target, "E:/repo");
        assert_eq!(branch, "main");
        assert_eq!(staged.len(), 2);
        assert_eq!(staged[0].path, "src/App.tsx");
        assert_eq!(staged[0].status, "M");
        assert_eq!(staged[1].path, "new.txt");
        assert_eq!(staged[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "src/App.tsx");
        assert_eq!(changes[1].path, "new file.ts");
        assert_eq!(changes[1].status, "U");
    }

    #[test]
    fn parses_worktree_list_porcelain() {
        let raw = "worktree E:/repo\nHEAD 1234567890\nbranch refs/heads/main\n\nworktree E:/repo-wt\nHEAD abcdef0123\ndetached\nlocked reason\n";
        let target = GitTarget::Local {
            root: "E:/repo".into(),
        };
        let list = parse_worktrees(raw, &target, "E:/repo");
        assert_eq!(list.len(), 2);
        assert!(list[0].is_main);
        assert!(list[0].is_current);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert!(!list[1].is_main);
        assert!(!list[1].is_current);
        assert!(list[1].is_detached);
        assert!(list[1].is_locked);
        assert_eq!(list[1].head, "abcdef01");
    }

    #[test]
    fn parses_commit_log_lines() {
        let raw = "0123456789abcdef\x1f0123456\x1faaaa1111 bbbb2222\x1fHEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v0.1.0\x1fmerge: add graph\x1falice\x1f5 minutes ago\n";
        let commits = parse_commits(raw);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].short_hash, "0123456");
        assert_eq!(commits[0].parents, vec!["aaaa1111", "bbbb2222"]);
        assert!(commits[0].is_head);
        assert_eq!(commits[0].refs.len(), 3);
        assert_eq!(commits[0].refs[0].kind, "head");
        assert_eq!(commits[0].refs[0].name, "main");
        assert_eq!(commits[0].refs[1].kind, "remote");
        assert_eq!(commits[0].refs[1].name, "origin/main");
        assert_eq!(commits[0].refs[2].kind, "tag");
        assert_eq!(commits[0].refs[2].name, "v0.1.0");
        assert_eq!(commits[0].subject, "merge: add graph");
        assert_eq!(commits[0].author, "alice");
        assert_eq!(commits[0].relative_time, "5 minutes ago");
    }

    #[test]
    fn parses_commit_files_lines() {
        let raw = "M\tsrc/App.tsx\nA\tsrc/graph.ts\nR100\told.txt\t\"new file.txt\"\n";
        let target = GitTarget::Local {
            root: "E:/repo".into(),
        };
        let files = parse_commit_files(raw, &target, "E:/repo");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].path, "src/App.tsx");
        assert_eq!(files[1].status, "A");
        assert_eq!(files[2].status, "R");
        assert_eq!(files[2].old_path.as_deref(), Some("old.txt"));
        assert_eq!(files[2].path, "new file.txt");
    }
}
