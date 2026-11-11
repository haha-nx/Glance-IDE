//! Git 工作树（Worktrees）与工作区更改管理 Commands。
//! 统一支持本地仓库、WSL (`wsl://`) 与远程 SSH (`remote://`) 工作区。

use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::process::Command;
use uuid::Uuid;

use crate::app_services::terminal::exec_capture;
use crate::commands::CmdError;
use crate::filesystem::{FileSystemProvider, ResourceUri};
use crate::AppState;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone)]
enum GitTarget {
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

struct CmdOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

fn decode_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2
        && ((bytes[0] == 0xFF && bytes[1] == 0xFE)
            || bytes.iter().skip(1).step_by(2).take(16).filter(|&&b| b == 0).count() > 4)
    {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .filter(|&c| c != 0xFEFF && c != 0)
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn normalize_path(raw: &str) -> String {
    let s = raw.trim().replace('\\', "/");
    if s.len() > 1 && s.ends_with('/') {
        // 保留 Windows 盘符根目录如 C:/
        if s.len() == 3 && s.as_bytes()[1] == b':' {
            s
        } else {
            s.trim_end_matches('/').to_string()
        }
    } else {
        s
    }
}

fn paths_equal(target: &GitTarget, a: &str, b: &str) -> bool {
    let na = normalize_path(a);
    let nb = normalize_path(b);
    match target {
        GitTarget::Local { .. } if cfg!(target_os = "windows") => na.eq_ignore_ascii_case(&nb),
        _ => na == nb,
    }
}

fn build_workspace_uri(target: &GitTarget, raw_fs_path: &str) -> String {
    let norm = normalize_path(raw_fs_path);
    match target {
        GitTarget::Local { .. } => norm,
        GitTarget::Wsl { distro, .. } => {
            let p = if norm.starts_with('/') { norm } else { format!("/{norm}") };
            format!("wsl://{distro}{p}")
        }
        GitTarget::Remote { device_id, .. } => {
            let p = if norm.starts_with('/') { norm } else { format!("/{norm}") };
            format!("remote://{device_id}{p}")
        }
    }
}

fn join_repo_file_uri(target: &GitTarget, repo_root: &str, rel_path: &str) -> String {
    let base = normalize_path(repo_root);
    let rel = rel_path.trim_start_matches('/');
    let full = if base.ends_with('/') {
        format!("{base}{rel}")
    } else {
        format!("{base}/{rel}")
    };
    build_workspace_uri(target, &full)
}

fn shell_quote_posix(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\"'\"'"))
}

fn strip_uri_to_fs_path(target: &GitTarget, input: &str) -> String {
    let trimmed = input.trim();
    match ResourceUri::parse(trimmed) {
        Ok(ResourceUri::Local { path }) => path,
        Ok(ResourceUri::Wsl { path, .. }) => path,
        Ok(ResourceUri::Remote { path, .. }) => path,
        Err(_) => match target {
            GitTarget::Local { .. } => trimmed.to_string(),
            GitTarget::Wsl { .. } | GitTarget::Remote { .. } => trimmed.replace('\\', "/"),
        },
    }
}

async fn resolve_target(state: &AppState, root_uri: &str) -> Result<GitTarget, CmdError> {
    let parsed = ResourceUri::parse(root_uri)
        .map_err(|e| CmdError::validation(format!("工作区路径无效: {e}")))?;
    match parsed {
        ResourceUri::Local { path } => Ok(GitTarget::Local { root: path }),
        ResourceUri::Wsl { distro, path } => Ok(GitTarget::Wsl { distro, path }),
        ResourceUri::Remote {
            device_identity_id,
            path,
        } => {
            let entry = state
                .sessions
                .find_by_device(&device_identity_id)
                .await
                .ok_or_else(|| CmdError::validation("SSH 会话未连接，无法执行 Git 操作"))?;
            Ok(GitTarget::Remote {
                session_id: entry.session_id,
                device_id: device_identity_id.to_string(),
                path: path.replace('\\', "/"),
            })
        }
    }
}

async fn run_git_at(
    state: &AppState,
    target: &GitTarget,
    cwd_override: Option<&str>,
    args: &[&str],
    timeout_secs: u64,
) -> Result<CmdOutput, CmdError> {
    match target {
        GitTarget::Local { root } => {
            let dir = cwd_override.unwrap_or(root.as_str());
            let mut cmd = Command::new("git");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.env("GIT_TERMINAL_PROMPT", "0");
            cmd.env("LC_ALL", "C");
            cmd.arg("-C").arg(dir);
            cmd.args(["-c", "core.quotepath=false"]);
            cmd.args(args);

            let out = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
                .await
                .map_err(|_| CmdError::validation("Git 命令执行超时"))?
                .map_err(|e| CmdError::validation(format!("无法启动 git（请确认本机已安装 Git）: {e}")))?;

            Ok(CmdOutput {
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                code: out.status.code().unwrap_or(-1),
            })
        }
        GitTarget::Wsl { distro, path } => {
            let dir = cwd_override.unwrap_or(path.as_str());
            let mut cmd = Command::new("wsl.exe");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.args([
                "-d",
                distro.as_str(),
                "--",
                "env",
                "GIT_TERMINAL_PROMPT=0",
                "LC_ALL=C",
                "git",
                "-C",
                dir,
                "-c",
                "core.quotepath=false",
            ]);
            cmd.args(args);

            let out = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
                .await
                .map_err(|_| CmdError::validation("WSL Git 命令执行超时"))?
                .map_err(|e| CmdError::validation(format!("无法调用 WSL 执行 git: {e}")))?;

            Ok(CmdOutput {
                stdout: decode_output(&out.stdout),
                stderr: decode_output(&out.stderr),
                code: out.status.code().unwrap_or(-1),
            })
        }
        GitTarget::Remote {
            session_id, path, ..
        } => {
            let dir = cwd_override.unwrap_or(path.as_str());
            let mut inner = vec![
                "GIT_TERMINAL_PROMPT=0".to_string(),
                "LC_ALL=C".to_string(),
                "git".to_string(),
                "-C".to_string(),
                shell_quote_posix(dir),
                "-c".to_string(),
                "core.quotepath=false".to_string(),
            ];
            for a in args {
                inner.push(shell_quote_posix(a));
            }
            // 使用 POSIX sh -c 包装，避免远程用户默认登录 shell 为 fish / tcsh 时环境变量写法不兼容
            let full = format!("sh -c {}", shell_quote_posix(&inner.join(" ")));
            let (stdout, stderr, code) = exec_capture(
                &state.sessions,
                *session_id,
                &full,
                Duration::from_secs(timeout_secs),
            )
            .await
            .map_err(CmdError::validation)?;

            Ok(CmdOutput {
                stdout,
                stderr,
                code,
            })
        }
    }
}

fn parse_branch_header(header: &str) -> (String, Option<String>, u32, u32) {
    let raw = header.strip_prefix("## ").unwrap_or(header).trim();
    if let Some(rest) = raw.strip_prefix("No commits yet on ") {
        return (rest.trim().to_string(), None, 0, 0);
    }
    if let Some(rest) = raw.strip_prefix("Initial commit on ") {
        return (rest.trim().to_string(), None, 0, 0);
    }
    if raw.starts_with("HEAD (no branch)") || raw == "HEAD" {
        return ("HEAD (detached)".to_string(), None, 0, 0);
    }

    let (branch_part, bracket_part) = match raw.rfind(" [") {
        Some(idx) if raw.ends_with(']') => (&raw[..idx], Some(&raw[idx + 2..raw.len() - 1])),
        _ => (raw, None),
    };

    let (branch, upstream) = match branch_part.split_once("...") {
        Some((b, u)) => (b.trim().to_string(), Some(u.trim().to_string())),
        None => (branch_part.trim().to_string(), None),
    };

    let mut ahead = 0u32;
    let mut behind = 0u32;
    if let Some(info) = bracket_part {
        for seg in info.split(',') {
            let s = seg.trim();
            if let Some(n) = s.strip_prefix("ahead ") {
                ahead = n.trim().parse().unwrap_or(0);
            } else if let Some(n) = s.strip_prefix("behind ") {
                behind = n.trim().parse().unwrap_or(0);
            }
        }
    }
    (branch, upstream, ahead, behind)
}

fn unquote_porcelain_path(p: &str) -> String {
    let trimmed = p.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1]
            .replace("\\\\", "\\")
            .replace("\\\"", "\"")
    } else {
        trimmed.to_string()
    }
}

fn parse_status_lines(
    output: &str,
    target: &GitTarget,
    repo_root: &str,
) -> (
    String,
    Option<String>,
    u32,
    u32,
    Vec<GitFileEntryDto>,
    Vec<GitFileEntryDto>,
) {
    let mut branch = "HEAD".to_string();
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut staged = Vec::new();
    let mut changes = Vec::new();

    for raw_line in output.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if line.starts_with("## ") {
            let parsed = parse_branch_header(line);
            branch = parsed.0;
            upstream = parsed.1;
            ahead = parsed.2;
            behind = parsed.3;
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let bytes = line.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let rest = &line[3..];

        let (old_path, cur_path) = if let Some((a, b)) = rest.split_once(" -> ") {
            (
                Some(unquote_porcelain_path(a)),
                unquote_porcelain_path(b),
            )
        } else {
            (None, unquote_porcelain_path(rest))
        };

        let uri = join_repo_file_uri(target, repo_root, &cur_path);

        if x == '?' && y == '?' {
            changes.push(GitFileEntryDto {
                path: cur_path,
                old_path: None,
                uri,
                status: "U".to_string(),
                staged: false,
            });
            continue;
        }

        let is_conflict =
            x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
        if is_conflict {
            changes.push(GitFileEntryDto {
                path: cur_path,
                old_path,
                uri,
                status: "C".to_string(),
                staged: false,
            });
            continue;
        }

        if x != ' ' {
            staged.push(GitFileEntryDto {
                path: cur_path.clone(),
                old_path: old_path.clone(),
                uri: uri.clone(),
                status: x.to_string(),
                staged: true,
            });
        }
        if y != ' ' {
            changes.push(GitFileEntryDto {
                path: cur_path,
                old_path: None,
                uri,
                status: y.to_string(),
                staged: false,
            });
        }
    }

    (branch, upstream, ahead, behind, staged, changes)
}

fn parse_worktrees(
    output: &str,
    target: &GitTarget,
    repo_root: &str,
) -> Vec<GitWorktreeDto> {
    let normalized = output.replace("\r\n", "\n");
    let mut list = Vec::new();
    for (idx, block) in normalized.split("\n\n").enumerate() {
        let trimmed = block.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut path = String::new();
        let mut head = String::new();
        let mut branch = None;
        let mut is_bare = false;
        let mut is_detached = false;
        let mut is_locked = false;
        let mut is_prunable = false;

        for line in trimmed.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = normalize_path(p);
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = h.trim().chars().take(8).collect();
            } else if let Some(b) = line.strip_prefix("branch ") {
                let name = b.trim();
                branch = Some(
                    name.strip_prefix("refs/heads/")
                        .unwrap_or(name)
                        .to_string(),
                );
            } else if line == "bare" {
                is_bare = true;
            } else if line == "detached" {
                is_detached = true;
            } else if line == "locked" || line.starts_with("locked ") {
                is_locked = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                is_prunable = true;
            }
        }

        if path.is_empty() {
            continue;
        }

        let uri = build_workspace_uri(target, &path);
        let is_current = paths_equal(target, &path, repo_root);
        list.push(GitWorktreeDto {
            path,
            uri,
            head,
            branch,
            is_bare,
            is_detached,
            is_locked,
            is_prunable,
            is_main: idx == 0,
            is_current,
        });
    }
    list
}

fn parse_branches(output: &str) -> Vec<GitBranchDto> {
    output
        .lines()
        .filter_map(|raw| {
            let line = raw.trim_end_matches('\r');
            if line.trim().is_empty() {
                return None;
            }
            let mut parts = line.splitn(3, '|');
            let head_mark = parts.next()?.trim();
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let upstream = parts
                .next()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Some(GitBranchDto {
                name: name.to_string(),
                current: head_mark == "*",
                upstream,
            })
        })
        .collect()
}

fn parse_decorate_refs(decorate: &str) -> (bool, Vec<GitRefDto>) {
    let trimmed = decorate.trim();
    if trimmed.is_empty() {
        return (false, Vec::new());
    }
    let mut is_head = false;
    let mut refs = Vec::new();
    for raw_item in trimmed.split(", ") {
        let item = raw_item.trim();
        if item.is_empty() || item == "refs/stash" {
            continue;
        }
        if let Some(target_ref) = item.strip_prefix("HEAD -> ") {
            is_head = true;
            let name = target_ref
                .trim()
                .strip_prefix("refs/heads/")
                .unwrap_or(target_ref.trim())
                .to_string();
            refs.push(GitRefDto {
                name,
                kind: "head".to_string(),
                is_current: true,
            });
        } else if item == "HEAD" {
            is_head = true;
            refs.push(GitRefDto {
                name: "HEAD".to_string(),
                kind: "head".to_string(),
                is_current: true,
            });
        } else if let Some(tag_ref) = item.strip_prefix("tag: ") {
            let name = tag_ref
                .trim()
                .strip_prefix("refs/tags/")
                .unwrap_or(tag_ref.trim())
                .to_string();
            refs.push(GitRefDto {
                name,
                kind: "tag".to_string(),
                is_current: false,
            });
        } else if let Some(remote_ref) = item.strip_prefix("refs/remotes/") {
            if remote_ref.ends_with("/HEAD") {
                continue;
            }
            refs.push(GitRefDto {
                name: remote_ref.to_string(),
                kind: "remote".to_string(),
                is_current: false,
            });
        } else if let Some(branch_ref) = item.strip_prefix("refs/heads/") {
            refs.push(GitRefDto {
                name: branch_ref.to_string(),
                kind: "branch".to_string(),
                is_current: false,
            });
        } else {
            refs.push(GitRefDto {
                name: item.to_string(),
                kind: "branch".to_string(),
                is_current: false,
            });
        }
    }
    (is_head, refs)
}

fn parse_commits(output: &str) -> Vec<GitCommitDto> {
    output
        .lines()
        .filter_map(|raw| {
            let line = raw.trim_end_matches('\r');
            if line.trim().is_empty() {
                return None;
            }
            let mut parts = line.splitn(7, '\x1f');
            let hash = parts.next()?.trim().to_string();
            let short_hash = parts.next()?.trim().to_string();
            let parents_raw = parts.next().unwrap_or("");
            let decorate_raw = parts.next().unwrap_or("");
            let subject = parts.next().unwrap_or("").trim().to_string();
            let author = parts.next().unwrap_or("").trim().to_string();
            let relative_time = parts.next().unwrap_or("").trim().to_string();
            if hash.is_empty() {
                return None;
            }
            let parents = parents_raw
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            let (is_head, refs) = parse_decorate_refs(decorate_raw);
            Some(GitCommitDto {
                hash,
                short_hash,
                parents,
                refs,
                subject,
                author,
                relative_time,
                is_head,
            })
        })
        .collect()
}

fn parse_commit_files(output: &str, target: &GitTarget, repo_root: &str) -> Vec<GitCommitFileDto> {
    output
        .lines()
        .filter_map(|raw| {
            let line = raw.trim_end_matches('\r');
            if line.trim().is_empty() {
                return None;
            }
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() < 2 {
                return None;
            }
            let raw_status = cols[0].trim();
            let status_char = raw_status.chars().next()?;
            let status = status_char.to_string();
            let (old_path, rel_path) = if (status_char == 'R' || status_char == 'C') && cols.len() >= 3 {
                (
                    Some(normalize_path(&unquote_porcelain_path(cols[1]))),
                    normalize_path(&unquote_porcelain_path(cols[2])),
                )
            } else {
                (None, normalize_path(&unquote_porcelain_path(cols[1])))
            };
            if rel_path.is_empty() {
                return None;
            }
            let uri = join_repo_file_uri(target, repo_root, &rel_path);
            Some(GitCommitFileDto {
                path: rel_path,
                old_path,
                uri,
                status,
            })
        })
        .collect()
}

fn empty_overview(is_repo: bool, git_available: bool, message: Option<String>) -> GitOverviewDto {
    GitOverviewDto {
        is_repo,
        git_available,
        repo_root: None,
        repo_root_uri: None,
        branch: String::new(),
        upstream: None,
        ahead: 0,
        behind: 0,
        staged: Vec::new(),
        changes: Vec::new(),
        worktrees: Vec::new(),
        branches: Vec::new(),
        commits: Vec::new(),
        graph_error: None,
        message,
    }
}

#[tauri::command]
pub async fn git_overview(
    state: State<'_, AppState>,
    root: String,
    all_branches: Option<bool>,
) -> Result<GitOverviewDto, CmdError> {
    let target = resolve_target(&state, &root).await?;
    let show_all = all_branches.unwrap_or(true);

    let top = match run_git_at(&state, &target, None, &["rev-parse", "--show-toplevel"], 10).await
    {
        Ok(out) => out,
        Err(err) => {
            return Ok(empty_overview(false, false, Some(err.to_string())));
        }
    };

    if top.code != 0 {
        let msg = top.stderr.trim().to_string();
        if msg.to_ascii_lowercase().contains("not a git repository") || top.code == 128 {
            return Ok(empty_overview(false, true, Some("当前打开的文件夹不是 Git 仓库".into())));
        }
        return Ok(empty_overview(
            false,
            true,
            Some(if msg.is_empty() {
                "无法读取 Git 仓库状态".into()
            } else {
                msg
            }),
        ));
    }

    let repo_root = normalize_path(&top.stdout);
    let repo_root_uri = build_workspace_uri(&target, &repo_root);

    let log_args_all = [
        "log",
        "--all",
        "--topo-order",
        "-n",
        "80",
        "--decorate=full",
        "--format=%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%an%x1f%ar",
    ];
    let log_args_cur = [
        "log",
        "--topo-order",
        "-n",
        "80",
        "--decorate=full",
        "--format=%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%an%x1f%ar",
    ];
    let status_args = ["status", "--porcelain", "-b", "-uall"];
    let wt_args = ["worktree", "list", "--porcelain"];
    let branch_args = [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(HEAD)|%(refname:short)|%(upstream:short)",
        "refs/heads",
    ];

    // 远程 SSH 串行执行避免多路 exec 通道并发受限；本地/WSL 并发采集缩短等待
    let (status_res, wt_res, branch_res, mut log_res) = if matches!(target, GitTarget::Remote { .. }) {
        let s = run_git_at(&state, &target, Some(&repo_root), &status_args, 20).await;
        let w = run_git_at(&state, &target, Some(&repo_root), &wt_args, 15).await;
        let b = run_git_at(&state, &target, Some(&repo_root), &branch_args, 15).await;
        let l = run_git_at(
            &state,
            &target,
            Some(&repo_root),
            if show_all { &log_args_all } else { &log_args_cur },
            20,
        )
        .await;
        (s, w, b, l)
    } else {
        tokio::join!(
            run_git_at(&state, &target, Some(&repo_root), &status_args, 15),
            run_git_at(&state, &target, Some(&repo_root), &wt_args, 10),
            run_git_at(&state, &target, Some(&repo_root), &branch_args, 10),
            run_git_at(
                &state,
                &target,
                Some(&repo_root),
                if show_all { &log_args_all } else { &log_args_cur },
                20,
            ),
        )
    };

    // 若 --all 因损坏引用或兼容问题失败，尝试回退仅加载当前分支提交记录
    if show_all {
        let need_fallback = match &log_res {
            Ok(out) => out.code != 0,
            Err(_) => true,
        };
        if need_fallback {
            if let Ok(cur_out) =
                run_git_at(&state, &target, Some(&repo_root), &log_args_cur, 20).await
            {
                if cur_out.code == 0 {
                    log_res = Ok(cur_out);
                }
            }
        }
    }

    let status_out = status_res?;
    if status_out.code != 0 {
        return Err(CmdError::validation(format!(
            "读取 git status 失败: {}",
            status_out.stderr.trim()
        )));
    }

    let (branch, upstream, ahead, behind, staged, changes) =
        parse_status_lines(&status_out.stdout, &target, &repo_root);

    let worktrees = match wt_res {
        Ok(w) if w.code == 0 => parse_worktrees(&w.stdout, &target, &repo_root),
        _ => Vec::new(),
    };

    let branches = match branch_res {
        Ok(b) if b.code == 0 => parse_branches(&b.stdout),
        _ => Vec::new(),
    };

    let mut graph_error: Option<String> = None;
    let commits = match log_res {
        Ok(l) if l.code == 0 => parse_commits(&l.stdout),
        Ok(l) => {
            let err_msg = l.stderr.trim().to_string();
            let low = err_msg.to_ascii_lowercase();
            // 全新初始化仓库尚无任何提交时不视为异常
            if !low.contains("does not have any commits") && !low.contains("bad default revision") {
                graph_error = Some(if err_msg.is_empty() {
                    format!("读取提交历史失败（退出码 {}）", l.code)
                } else {
                    err_msg
                });
            }
            Vec::new()
        }
        Err(e) => {
            graph_error = Some(e.to_string());
            Vec::new()
        }
    };

    Ok(GitOverviewDto {
        is_repo: true,
        git_available: true,
        repo_root: Some(repo_root),
        repo_root_uri: Some(repo_root_uri),
        branch,
        upstream,
        ahead,
        behind,
        staged,
        changes,
        worktrees,
        branches,
        commits,
        graph_error,
        message: None,
    })
}

#[tauri::command]
pub async fn git_commit_files(
    state: State<'_, AppState>,
    root: String,
    hash: String,
) -> Result<Vec<GitCommitFileDto>, CmdError> {
    let clean_hash = validate_hex_hash(&hash, "提交哈希")?;
    let target = resolve_target(&state, &root).await?;
    let top = run_git_at(&state, &target, None, &["rev-parse", "--show-toplevel"], 15).await?;
    let top = check_git_success(top, "解析仓库根目录")?;
    let repo_root = normalize_path(&top.stdout);

    // -m --first-parent 确保合并提交（Merge Commit）同样返回完整变更文件列表
    let out = run_git_at(
        &state,
        &target,
        Some(&repo_root),
        &[
            "diff-tree",
            "--root",
            "-m",
            "--first-parent",
            "--no-commit-id",
            "--name-status",
            "-r",
            "-M",
            clean_hash,
        ],
        20,
    )
    .await?;
    let ok = check_git_success(out, "读取提交变更文件")?;
    Ok(parse_commit_files(&ok.stdout, &target, &repo_root))
}

fn validate_hex_hash<'a>(hash: &'a str, label: &str) -> Result<&'a str, CmdError> {
    let clean = hash.trim();
    if clean.len() < 4 || clean.len() > 64 || !clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CmdError::validation(format!("无效的{label}")));
    }
    Ok(clean)
}

fn sanitize_rel_repo_path(path: &str) -> Result<String, CmdError> {
    let clean = path.trim().replace('\\', "/").trim_start_matches('/').to_string();
    if clean.is_empty() || clean.starts_with('-') || clean.contains('\0') {
        return Err(CmdError::validation("无效的仓库相对文件路径"));
    }
    Ok(clean)
}

async fn read_git_blob_text(
    state: &State<'_, AppState>,
    target: &GitTarget,
    repo_root: &str,
    rev: &str,
    rel_path: &str,
) -> Option<(String, bool)> {
    let spec = format!("{rev}:{rel_path}");
    let out = run_git_at(state, target, Some(repo_root), &["show", &spec], 20)
        .await
        .ok()?;
    if out.code != 0 {
        return None;
    }
    if out.stdout.contains('\0') {
        return Some((String::new(), true));
    }
    Some((out.stdout, false))
}

async fn read_working_file_text(
    state: &State<'_, AppState>,
    target: &GitTarget,
    repo_root: &str,
    rel_path: &str,
) -> Option<(String, bool)> {
    let base = normalize_path(repo_root);
    let rel = rel_path.trim_start_matches('/');
    let full = if base.ends_with('/') {
        format!("{base}{rel}")
    } else {
        format!("{base}/{rel}")
    };

    let content = match target {
        GitTarget::Local { .. } => state.fs.read_file(&full).await.ok()?,
        GitTarget::Wsl { distro, .. } => {
            #[cfg(windows)]
            {
                let win = full.replace('/', "\\");
                let unc = if win.starts_with('\\') {
                    format!(r"\\wsl.localhost\{distro}{win}")
                } else {
                    format!(r"\\wsl.localhost\{distro}\{win}")
                };
                state.fs.read_file(&unc).await.ok()?
            }
            #[cfg(not(windows))]
            {
                let _ = distro;
                return None;
            }
        }
        GitTarget::Remote { session_id, .. } => {
            let entry = state.sessions.get(session_id)?;
            let provider = entry.ensure_sftp().await.ok()?;
            provider.read_file(&full).await.ok()?
        }
    };

    if content.binary {
        Some((String::new(), true))
    } else {
        Some((content.text.unwrap_or_default(), false))
    }
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
    let target = resolve_target(&state, &root).await?;
    let top = run_git_at(&state, &target, None, &["rev-parse", "--show-toplevel"], 15).await?;
    let top = check_git_success(top, "解析仓库根目录")?;
    let repo_root = normalize_path(&top.stdout);
    let repo_root_uri = build_workspace_uri(&target, &repo_root);

    let clean_path = sanitize_rel_repo_path(&path)?;
    let clean_old = old_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(sanitize_rel_repo_path)
        .transpose()?
        .unwrap_or_else(|| clean_path.clone());
    let file_uri = join_repo_file_uri(&target, &repo_root, &clean_path);
    let st = status.as_deref().unwrap_or("M").trim();

    match mode.trim() {
        "working" => {
            let (orig_text, orig_bin) = if st == "U" {
                (String::new(), false)
            } else {
                match read_git_blob_text(&state, &target, &repo_root, "", &clean_old).await {
                    Some(v) => v,
                    None => read_git_blob_text(&state, &target, &repo_root, "HEAD", &clean_old)
                        .await
                        .unwrap_or_default(),
                }
            };
            let (mod_text, mod_bin) = if st == "D" {
                (String::new(), false)
            } else {
                read_working_file_text(&state, &target, &repo_root, &clean_path)
                    .await
                    .unwrap_or_default()
            };
            let is_binary = orig_bin || mod_bin;
            Ok(GitFileDiffDto {
                repo_root_uri,
                file_uri,
                file_path: clean_path,
                original_label: if st == "U" {
                    "新增（未跟踪）".into()
                } else {
                    "暂存区 (Index)".into()
                },
                modified_label: if st == "D" {
                    "工作区（已删除）".into()
                } else {
                    "工作区（当前）".into()
                },
                original_text: orig_text,
                modified_text: mod_text,
                is_binary,
                error_note: if is_binary {
                    Some("二进制文件暂不支持文本对比".into())
                } else {
                    None
                },
            })
        }
        "staged" => {
            let (orig_text, orig_bin) = if st == "A" {
                (String::new(), false)
            } else {
                read_git_blob_text(&state, &target, &repo_root, "HEAD", &clean_old)
                    .await
                    .unwrap_or_default()
            };
            let (mod_text, mod_bin) = if st == "D" {
                (String::new(), false)
            } else {
                read_git_blob_text(&state, &target, &repo_root, "", &clean_path)
                    .await
                    .unwrap_or_default()
            };
            let is_binary = orig_bin || mod_bin;
            Ok(GitFileDiffDto {
                repo_root_uri,
                file_uri,
                file_path: clean_path,
                original_label: "HEAD".into(),
                modified_label: if st == "D" {
                    "暂存区（已删除）".into()
                } else {
                    "暂存区 (Index)".into()
                },
                original_text: orig_text,
                modified_text: mod_text,
                is_binary,
                error_note: if is_binary {
                    Some("二进制文件暂不支持文本对比".into())
                } else {
                    None
                },
            })
        }
        "commit" => {
            let raw_commit = commit_hash
                .as_deref()
                .ok_or_else(|| CmdError::validation("缺少提交哈希"))?;
            let clean_commit = validate_hex_hash(raw_commit, "提交哈希")?.to_string();
            let clean_parent = parent_hash
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(|s| validate_hex_hash(s, "父提交哈希").map(|h| h.to_string()))
                .transpose()?;
            let short_commit: String = clean_commit.chars().take(7).collect();

            let (orig_label, (orig_text, orig_bin)) = match (&clean_parent, st) {
                (None, _) => ("空（初始提交）".to_string(), (String::new(), false)),
                (Some(_), "A") => ("空（新增文件）".to_string(), (String::new(), false)),
                (Some(p), _) => {
                    let short_p: String = p.chars().take(7).collect();
                    let blob = read_git_blob_text(&state, &target, &repo_root, p, &clean_old)
                        .await
                        .unwrap_or_default();
                    (short_p, blob)
                }
            };

            let (mod_text, mod_bin) = if st == "D" {
                (String::new(), false)
            } else {
                read_git_blob_text(&state, &target, &repo_root, &clean_commit, &clean_path)
                    .await
                    .unwrap_or_default()
            };

            let is_binary = orig_bin || mod_bin;
            Ok(GitFileDiffDto {
                repo_root_uri,
                file_uri,
                file_path: clean_path,
                original_label: orig_label,
                modified_label: if st == "D" {
                    format!("{short_commit}（已删除）")
                } else {
                    short_commit
                },
                original_text: orig_text,
                modified_text: mod_text,
                is_binary,
                error_note: if is_binary {
                    Some("二进制文件暂不支持文本对比".into())
                } else {
                    None
                },
            })
        }
        other => Err(CmdError::validation(format!("不支持的对比模式: {other}"))),
    }
}

fn check_git_success(out: CmdOutput, action: &str) -> Result<CmdOutput, CmdError> {
    if out.code == 0 {
        Ok(out)
    } else {
        let msg = out.stderr.trim();
        let alt = out.stdout.trim();
        let detail = if !msg.is_empty() { msg } else { alt };
        Err(CmdError::validation(if detail.is_empty() {
            format!("{action}失败")
        } else {
            format!("{action}失败: {detail}")
        }))
    }
}

fn validate_ref_name(name: &str, what: &str) -> Result<String, CmdError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.contains('\0') {
        return Err(CmdError::validation(format!("无效的{what}名称")));
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
pub async fn git_init(state: State<'_, AppState>, root: String) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    let out = run_git_at(&state, &target, None, &["init"], 15).await?;
    check_git_success(out, "初始化 Git 仓库")?;
    Ok(())
}

#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    root: String,
    paths: Vec<String>,
) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    if paths.is_empty() {
        let out = run_git_at(&state, &target, None, &["add", "-A"], 20).await?;
        check_git_success(out, "全部暂存")?;
    } else {
        let mut args = vec!["add", "--"];
        let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        args.extend(refs);
        let out = run_git_at(&state, &target, None, &args, 20).await?;
        check_git_success(out, "暂存文件")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    root: String,
    paths: Vec<String>,
) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    let has_head = run_git_at(&state, &target, None, &["rev-parse", "--verify", "HEAD"], 10)
        .await
        .map(|o| o.code == 0)
        .unwrap_or(false);

    if has_head {
        let mut args = vec!["reset", "-q", "HEAD", "--"];
        if !paths.is_empty() {
            args.extend(paths.iter().map(|s| s.as_str()));
        }
        let out = run_git_at(&state, &target, None, &args, 20).await?;
        check_git_success(out, "取消暂存")?;
    } else {
        let mut args = vec!["rm", "--cached", "-q"];
        if paths.is_empty() {
            args.extend(["-r", "--", "."]);
        } else {
            args.push("--");
            args.extend(paths.iter().map(|s| s.as_str()));
        }
        let out = run_git_at(&state, &target, None, &args, 20).await?;
        check_git_success(out, "取消暂存")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_discard(
    state: State<'_, AppState>,
    root: String,
    path: String,
    untracked: bool,
) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    if path.trim().is_empty() {
        return Err(CmdError::validation("文件路径不能为空"));
    }
    let out = if untracked {
        run_git_at(&state, &target, None, &["clean", "-fd", "--", &path], 15).await?
    } else {
        run_git_at(&state, &target, None, &["checkout", "--", &path], 15).await?
    };
    check_git_success(out, "放弃更改")?;
    Ok(())
}

#[tauri::command]
pub async fn git_discard_all(state: State<'_, AppState>, root: String) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    let has_head = run_git_at(&state, &target, None, &["rev-parse", "--verify", "HEAD"], 10)
        .await
        .map(|o| o.code == 0)
        .unwrap_or(false);
    if has_head {
        let out = run_git_at(&state, &target, None, &["checkout", "--", "."], 20).await?;
        check_git_success(out, "放弃已跟踪文件更改")?;
    }
    let clean = run_git_at(&state, &target, None, &["clean", "-fd"], 20).await?;
    check_git_success(clean, "清理未跟踪文件")?;
    Ok(())
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    root: String,
    message: String,
) -> Result<String, CmdError> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err(CmdError::validation("请输入提交说明后再提交"));
    }
    let target = resolve_target(&state, &root).await?;
    let out = run_git_at(&state, &target, None, &["commit", "-m", msg], 30).await?;
    let ok = check_git_success(out, "提交")?;
    Ok(ok.stdout.trim().to_string())
}

#[tauri::command]
pub async fn git_checkout(
    state: State<'_, AppState>,
    root: String,
    branch: String,
    create: bool,
) -> Result<(), CmdError> {
    let clean_branch = validate_ref_name(&branch, "分支")?;
    let target = resolve_target(&state, &root).await?;
    let out = if create {
        run_git_at(&state, &target, None, &["checkout", "-b", &clean_branch], 20).await?
    } else {
        run_git_at(&state, &target, None, &["checkout", &clean_branch], 20).await?
    };
    check_git_success(out, "切换分支")?;
    Ok(())
}

#[tauri::command]
pub async fn git_pull(state: State<'_, AppState>, root: String) -> Result<String, CmdError> {
    let target = resolve_target(&state, &root).await?;
    let out = run_git_at(&state, &target, None, &["pull"], 60).await?;
    let ok = check_git_success(out, "拉取")?;
    Ok(ok.stdout.trim().to_string())
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, root: String) -> Result<String, CmdError> {
    let target = resolve_target(&state, &root).await?;
    let out = run_git_at(&state, &target, None, &["push"], 60).await?;
    if out.code != 0 && out.stderr.contains("has no upstream branch") {
        let out2 = run_git_at(&state, &target, None, &["push", "-u", "origin", "HEAD"], 60).await?;
        let ok2 = check_git_success(out2, "推送")?;
        return Ok(ok2.stdout.trim().to_string());
    }
    let ok = check_git_success(out, "推送")?;
    Ok(ok.stdout.trim().to_string())
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, root: String) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    let out = run_git_at(&state, &target, None, &["fetch", "--all", "--prune"], 60).await?;
    check_git_success(out, "获取远程更新")?;
    Ok(())
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
    let target = resolve_target(&state, &root).await?;
    let clean_branch = validate_ref_name(&branch, "分支")?;
    let fs_target = strip_uri_to_fs_path(&target, &target_path);
    if fs_target.trim().is_empty() {
        return Err(CmdError::validation("工作树目录路径不能为空"));
    }

    let base_clean = match base_ref {
        Some(ref b) if !b.trim().is_empty() => Some(validate_ref_name(b, "基准分支")?),
        _ => None,
    };

    let mut args: Vec<&str> = vec!["worktree", "add"];
    if create_branch {
        args.push("-b");
        args.push(&clean_branch);
    }
    args.push("--");
    args.push(&fs_target);
    if !create_branch {
        args.push(&clean_branch);
    } else if let Some(ref b) = base_clean {
        args.push(b.as_str());
    }

    let out = run_git_at(&state, &target, None, &args, 30).await?;
    check_git_success(out, "创建工作树")?;

    // 尝试解析刚刚创建的工作树真实路径，并返回工作区 URI 以便直接打开
    if let Ok(resolved) =
        run_git_at(&state, &target, Some(&fs_target), &["rev-parse", "--show-toplevel"], 10).await
    {
        if resolved.code == 0 {
            return Ok(build_workspace_uri(&target, resolved.stdout.trim()));
        }
    }
    Ok(build_workspace_uri(&target, &fs_target))
}

#[tauri::command]
pub async fn git_worktree_remove(
    state: State<'_, AppState>,
    root: String,
    worktree_path: String,
    force: bool,
) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    let fs_path = strip_uri_to_fs_path(&target, &worktree_path);
    if fs_path.trim().is_empty() {
        return Err(CmdError::validation("工作树路径不能为空"));
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--");
    args.push(&fs_path);

    let out = run_git_at(&state, &target, None, &args, 20).await?;
    check_git_success(out, "删除工作树")?;
    Ok(())
}

#[tauri::command]
pub async fn git_worktree_prune(
    state: State<'_, AppState>,
    root: String,
) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    let out = run_git_at(&state, &target, None, &["worktree", "prune"], 15).await?;
    check_git_success(out, "清理失效工作树")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
