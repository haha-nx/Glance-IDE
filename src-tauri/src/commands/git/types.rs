//! Git 命令 DTO 与内部命令输出类型。

use serde::Serialize;
use uuid::Uuid;

#[cfg(target_os = "windows")]
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone)]
pub(super) enum GitTarget {
    Local { root: String },
    Wsl { distro: String, path: String },
    Remote {
        session_id: Uuid,
        device_id: String,
        path: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntryDto {
    pub path: String,
    pub old_path: Option<String>,
    pub uri: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeDto {
    pub path: String,
    pub uri: String,
    pub head: String,
    pub branch: Option<String>,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_locked: bool,
    pub is_prunable: bool,
    pub is_main: bool,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchDto {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefDto {
    pub name: String,
    pub kind: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDto {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub refs: Vec<GitRefDto>,
    pub subject: String,
    pub author: String,
    pub relative_time: String,
    pub is_head: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileDto {
    pub path: String,
    pub old_path: Option<String>,
    pub uri: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffDto {
    pub repo_root_uri: String,
    pub file_uri: String,
    pub file_path: String,
    pub original_label: String,
    pub modified_label: String,
    pub original_text: String,
    pub modified_text: String,
    pub is_binary: bool,
    pub error_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOverviewDto {
    pub is_repo: bool,
    pub git_available: bool,
    pub repo_root: Option<String>,
    pub repo_root_uri: Option<String>,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitFileEntryDto>,
    pub changes: Vec<GitFileEntryDto>,
    pub worktrees: Vec<GitWorktreeDto>,
    pub branches: Vec<GitBranchDto>,
    pub commits: Vec<GitCommitDto>,
    pub graph_error: Option<String>,
    pub message: Option<String>,
}

pub(super) struct CmdOutput {
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) code: i32,
}

