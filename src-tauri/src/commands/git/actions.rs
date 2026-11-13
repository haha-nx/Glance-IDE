//! Git 写操作与工作树管理实现。

use tauri::State;

use super::cli::*;
use crate::commands::CmdError;
use crate::AppState;

pub(super) async fn git_init_impl(state: State<'_, AppState>, root: String) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    let out = run_git_at(&state, &target, None, &["init"], 15).await?;
    check_git_success(out, "初始化 Git 仓库")?;
    Ok(())
}

pub(super) async fn git_stage_impl(
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

pub(super) async fn git_unstage_impl(
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

pub(super) async fn git_discard_impl(
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

pub(super) async fn git_discard_all_impl(state: State<'_, AppState>, root: String) -> Result<(), CmdError> {
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

pub(super) async fn git_commit_impl(
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

pub(super) async fn git_checkout_impl(
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

pub(super) async fn git_pull_impl(state: State<'_, AppState>, root: String) -> Result<String, CmdError> {
    let target = resolve_target(&state, &root).await?;
    let out = run_git_at(&state, &target, None, &["pull"], 60).await?;
    let ok = check_git_success(out, "拉取")?;
    Ok(ok.stdout.trim().to_string())
}

pub(super) async fn git_push_impl(state: State<'_, AppState>, root: String) -> Result<String, CmdError> {
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

pub(super) async fn git_fetch_impl(state: State<'_, AppState>, root: String) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    let out = run_git_at(&state, &target, None, &["fetch", "--all", "--prune"], 60).await?;
    check_git_success(out, "获取远程更新")?;
    Ok(())
}

pub(super) async fn git_worktree_add_impl(
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

pub(super) async fn git_worktree_remove_impl(
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

pub(super) async fn git_worktree_prune_impl(
    state: State<'_, AppState>,
    root: String,
) -> Result<(), CmdError> {
    let target = resolve_target(&state, &root).await?;
    let out = run_git_at(&state, &target, None, &["worktree", "prune"], 15).await?;
    check_git_success(out, "清理失效工作树")?;
    Ok(())
}

