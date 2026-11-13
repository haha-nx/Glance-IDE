//! Git 只读查询实现（总览、提交变更文件与文件 Diff 内容）。

use tauri::State;

use super::cli::*;
use super::parsers::*;
use super::types::*;
use crate::commands::CmdError;
use crate::filesystem::FileSystemProvider;
use crate::AppState;

pub(super) async fn git_overview_impl(
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

pub(super) async fn git_commit_files_impl(
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
pub(super) async fn git_file_diff_impl(
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

