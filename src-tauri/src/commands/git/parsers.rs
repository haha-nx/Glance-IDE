//! Git CLI 输出解析器（status / worktree / branch / commit log / diff-tree）。

use super::cli::*;
use super::types::*;

pub(super) fn parse_branch_header(header: &str) -> (String, Option<String>, u32, u32) {
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

pub(super) fn unquote_porcelain_path(p: &str) -> String {
    let trimmed = p.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1]
            .replace("\\\\", "\\")
            .replace("\\\"", "\"")
    } else {
        trimmed.to_string()
    }
}

pub(super) fn parse_status_lines(
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

pub(super) fn parse_worktrees(
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

pub(super) fn parse_branches(output: &str) -> Vec<GitBranchDto> {
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

pub(super) fn parse_decorate_refs(decorate: &str) -> (bool, Vec<GitRefDto>) {
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

pub(super) fn parse_commits(output: &str) -> Vec<GitCommitDto> {
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

pub(super) fn parse_commit_files(output: &str, target: &GitTarget, repo_root: &str) -> Vec<GitCommitFileDto> {
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

pub(super) fn empty_overview(is_repo: bool, git_available: bool, message: Option<String>) -> GitOverviewDto {
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

