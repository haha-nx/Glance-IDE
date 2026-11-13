//! 传输冲突检查、源文件/目录树扫描与本地文件管理器定位。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use super::types::*;
use crate::app_services::ssh_sessions::SessionManager;

/// 在系统文件管理器中显示本地文件或目录。
pub fn reveal_local_path_sync(path: &Path) -> Result<(), String> {
    let target = if path.exists() {
        path.to_path_buf()
    } else if let Some(parent) = path.parent().filter(|p| p.exists()) {
        parent.to_path_buf()
    } else {
        return Err(format!("路径不存在: {}", path.display()));
    };

    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        cmd.arg("-R").arg(&target);
        let status = cmd.status().map_err(|e| format!("无法打开 Finder: {e}"))?;
        if !status.success() {
            return Err(format!("Finder 返回非零状态: {status}"));
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = std::process::Command::new("explorer.exe");
        if target.is_file() {
            cmd.raw_arg(format!("/select,\"{}\"", target.to_string_lossy()));
        } else {
            cmd.arg(&target);
        }
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.spawn().map_err(|e| format!("无法打开资源管理器: {e}"))?;
        Ok(())
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        let open_dir = if target.is_dir() {
            target
        } else {
            target.parent().unwrap_or(&target).to_path_buf()
        };
        let status = std::process::Command::new("xdg-open")
            .arg(&open_dir)
            .status()
            .map_err(|e| format!("无法打开文件管理器: {e}"))?;
        if !status.success() {
            return Err(format!("文件管理器返回错误: {status}"));
        }
        Ok(())
    }
}

/// 检查传输前目标目录中是否存在同名冲突项。
pub async fn check_conflicts(
    sessions: &SessionManager,
    items: Vec<String>,
    target_dir_uri: String,
) -> Result<Vec<TransferConflict>, String> {
    let dest = resolve_uri(&target_dir_uri)?;
    let mut conflicts = Vec::new();
    let mut seen_names = HashSet::new();

    match &dest {
        ResolvedEndpoint::Local { path: dest_dir, .. } => {
            for raw in &items {
                let name = extract_uri_basename(raw)?;
                if !seen_names.insert(name.clone()) {
                    continue;
                }
                let candidate = dest_dir.join(&name);
                if let Ok(meta) = tokio::fs::symlink_metadata(&candidate).await {
                    let is_dir = if meta.file_type().is_symlink() {
                        tokio::fs::metadata(&candidate)
                            .await
                            .map(|m| m.is_dir())
                            .unwrap_or(false)
                    } else {
                        meta.is_dir()
                    };
                    conflicts.push(TransferConflict {
                        name: name.clone(),
                        dest_path: format_dest_display(&dest, &name),
                        is_dir,
                    });
                }
            }
        }
        ResolvedEndpoint::Remote {
            device_identity_id,
            path: dest_dir_posix,
        } => {
            let sftp = SftpHandle::acquire(sessions, *device_identity_id).await?;
            let result = async {
                for raw in &items {
                    let name = extract_uri_basename(raw)?;
                    if !seen_names.insert(name.clone()) {
                        continue;
                    }
                    let candidate = join_posix(dest_dir_posix, &name);
                    if let Ok(meta) = sftp.symlink_metadata(&candidate).await {
                        let is_dir = if meta.is_symlink() {
                            sftp.metadata(&candidate)
                                .await
                                .map(|m| m.is_dir())
                                .unwrap_or(false)
                        } else {
                            meta.is_dir()
                        };
                        conflicts.push(TransferConflict {
                            name: name.clone(),
                            dest_path: format_dest_display(&dest, &name),
                            is_dir,
                        });
                    }
                }
                Ok::<(), String>(())
            }
            .await;
            sftp.close().await;
            result?;
        }
    }

    Ok(conflicts)
}


pub(super) async fn check_self_descendant_local(src: &Path, dest_dir: &Path) -> Result<(), String> {
    let Ok(src_canon) = tokio::fs::canonicalize(src).await else {
        return Ok(());
    };
    let Ok(dest_canon) = tokio::fs::canonicalize(dest_dir).await else {
        return Ok(());
    };
    if dest_canon == src_canon || dest_canon.starts_with(&src_canon) {
        return Err(format!(
            "不能将文件夹 '{}' 传输到其自身或子目录中",
            src.display()
        ));
    }
    Ok(())
}

/// 扫描本地源路径列表（用于上传，或本地复制）。
pub(super) async fn scan_local_sources(
    sources: &[PathBuf],
    dest_dir_if_local: Option<&Path>,
    cancel: &AtomicBool,
    tracker: &mut ProgressTracker<'_>,
) -> Result<TransferPlan, CopyAbort> {
    let mut plan = TransferPlan::default();
    let mut seen_top = HashSet::new();

    for src in sources {
        if is_cancelled(cancel) {
            return Err(CopyAbort::Cancelled);
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| CopyAbort::Failed(format!("无效源路径: {}", src.display())))?;
        validate_safe_segment(&name).map_err(CopyAbort::Failed)?;
        if !seen_top.insert(name.clone()) {
            continue;
        }
        plan.top_names.push(name.clone());

        let meta = tokio::fs::metadata(src).await.map_err(|e| {
            CopyAbort::Failed(format!("无法访问源路径 {}: {e}", src.display()))
        })?;

        if meta.is_dir() {
            if let Some(local_dest) = dest_dir_if_local {
                check_self_descendant_local(src, local_dest)
                    .await
                    .map_err(CopyAbort::Failed)?;
            }
            let rel = vec![name];
            plan.dirs.push(rel.clone());
            let mut stack: Vec<(PathBuf, Vec<String>, usize)> = vec![(src.clone(), rel, 0)];
            while let Some((dir_path, rel_parts, depth)) = stack.pop() {
                if is_cancelled(cancel) {
                    return Err(CopyAbort::Cancelled);
                }
                if depth >= MAX_TRAVERSE_DEPTH {
                    return Err(CopyAbort::Failed(format!(
                        "目录层级超过上限 ({MAX_TRAVERSE_DEPTH}): {}",
                        dir_path.display()
                    )));
                }
                let mut rd = tokio::fs::read_dir(&dir_path).await.map_err(|e| {
                    CopyAbort::Failed(format!("读取源目录失败 ({}): {e}", dir_path.display()))
                })?;
                let mut children = Vec::new();
                while let Some(entry) = rd.next_entry().await.map_err(|e| {
                    CopyAbort::Failed(format!("遍历目录失败 ({}): {e}", dir_path.display()))
                })? {
                    children.push(entry);
                }
                children.sort_by_key(|e| e.file_name());

                for entry in children {
                    if is_cancelled(cancel) {
                        return Err(CopyAbort::Cancelled);
                    }
                    let child_name = entry.file_name().to_string_lossy().into_owned();
                    if validate_safe_segment(&child_name).is_err() {
                        continue;
                    }
                    let child_path = entry.path();
                    let Ok(lmeta) = tokio::fs::symlink_metadata(&child_path).await else {
                        continue;
                    };
                    let mut next_rel = rel_parts.clone();
                    next_rel.push(child_name);

                    if lmeta.file_type().is_symlink() {
                        // 不递归符号链接目录，防止死循环；若指向常规文件则复制其内容，悬空链接跳过
                        if let Ok(target_meta) = tokio::fs::metadata(&child_path).await {
                            if target_meta.is_file() {
                                let size = target_meta.len();
                                plan.total_bytes += size;
                                tracker.total_bytes = plan.total_bytes;
                                tracker.current_file = next_rel.join("/");
                                plan.files.push(PlannedFile {
                                    src_path: child_path.to_string_lossy().into_owned(),
                                    rel_parts: next_rel,
                                    size,
                                });
                                tracker.total_files = plan.files.len();
                                tracker.emit_throttled(TransferStatus::Scanning);
                            }
                        }
                    } else if lmeta.is_dir() {
                        plan.dirs.push(next_rel.clone());
                        stack.push((child_path, next_rel, depth + 1));
                    } else if lmeta.is_file() {
                        let size = lmeta.len();
                        plan.total_bytes += size;
                        tracker.total_bytes = plan.total_bytes;
                        tracker.current_file = next_rel.join("/");
                        plan.files.push(PlannedFile {
                            src_path: child_path.to_string_lossy().into_owned(),
                            rel_parts: next_rel,
                            size,
                        });
                        tracker.total_files = plan.files.len();
                        tracker.emit_throttled(TransferStatus::Scanning);
                    }
                }
            }
        } else if meta.is_file() {
            let size = meta.len();
            plan.total_bytes += size;
            tracker.total_bytes = plan.total_bytes;
            tracker.current_file = name.clone();
            plan.files.push(PlannedFile {
                src_path: src.to_string_lossy().into_owned(),
                rel_parts: vec![name],
                size,
            });
            tracker.total_files = plan.files.len();
            tracker.emit_throttled(TransferStatus::Scanning);
        } else {
            return Err(CopyAbort::Failed(format!(
                "不支持传输特殊文件类型: {}",
                src.display()
            )));
        }
    }

    Ok(plan)
}

/// 扫描远程 SFTP 源路径列表（用于下载）。
pub(super) async fn scan_remote_sources(
    sftp: &SftpHandle,
    sources_posix: &[String],
    cancel: &AtomicBool,
    tracker: &mut ProgressTracker<'_>,
) -> Result<TransferPlan, CopyAbort> {
    let mut plan = TransferPlan::default();
    let mut seen_top = HashSet::new();

    for raw_path in sources_posix {
        if is_cancelled(cancel) {
            return Err(CopyAbort::Cancelled);
        }
        let clean = normalize_posix(raw_path);
        let name = clean.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
        validate_safe_segment(&name).map_err(CopyAbort::Failed)?;
        if !seen_top.insert(name.clone()) {
            continue;
        }
        plan.top_names.push(name.clone());

        let meta = sftp
            .metadata(&clean)
            .await
            .map_err(CopyAbort::Failed)?;

        if meta.is_dir() {
            let rel = vec![name];
            plan.dirs.push(rel.clone());
            let mut stack: Vec<(String, Vec<String>, usize)> = vec![(clean, rel, 0)];
            while let Some((dir_posix, rel_parts, depth)) = stack.pop() {
                if is_cancelled(cancel) {
                    return Err(CopyAbort::Cancelled);
                }
                if depth >= MAX_TRAVERSE_DEPTH {
                    return Err(CopyAbort::Failed(format!(
                        "远程目录层级超过上限 ({MAX_TRAVERSE_DEPTH}): {dir_posix}"
                    )));
                }
                let mut entries = sftp.read_dir(&dir_posix).await.map_err(CopyAbort::Failed)?;
                entries.sort_by_key(|e| e.file_name());

                for entry in entries {
                    if is_cancelled(cancel) {
                        return Err(CopyAbort::Cancelled);
                    }
                    let child_name = entry.file_name();
                    if child_name == "." || child_name == ".." {
                        continue;
                    }
                    if validate_safe_segment(&child_name).is_err() {
                        continue;
                    }
                    let child_posix = join_posix(&dir_posix, &child_name);
                    let mut next_rel = rel_parts.clone();
                    next_rel.push(child_name);

                    let ft = entry.file_type();
                    if ft.is_symlink() {
                        if let Ok(target_meta) = sftp.metadata(&child_posix).await {
                            if !target_meta.is_dir() && target_meta.is_regular() {
                                let size = target_meta.len();
                                plan.total_bytes += size;
                                tracker.total_bytes = plan.total_bytes;
                                tracker.current_file = next_rel.join("/");
                                plan.files.push(PlannedFile {
                                    src_path: child_posix,
                                    rel_parts: next_rel,
                                    size,
                                });
                                tracker.total_files = plan.files.len();
                                tracker.emit_throttled(TransferStatus::Scanning);
                            }
                        }
                    } else if ft.is_dir() {
                        plan.dirs.push(next_rel.clone());
                        stack.push((child_posix, next_rel, depth + 1));
                    } else if ft.is_file() {
                        let size = entry.metadata().len();
                        plan.total_bytes += size;
                        tracker.total_bytes = plan.total_bytes;
                        tracker.current_file = next_rel.join("/");
                        plan.files.push(PlannedFile {
                            src_path: child_posix,
                            rel_parts: next_rel,
                            size,
                        });
                        tracker.total_files = plan.files.len();
                        tracker.emit_throttled(TransferStatus::Scanning);
                    } else if let Ok(lmeta) = sftp.symlink_metadata(&child_posix).await {
                        if lmeta.is_dir() {
                            plan.dirs.push(next_rel.clone());
                            stack.push((child_posix, next_rel, depth + 1));
                        } else if lmeta.is_regular() {
                            let size = lmeta.len();
                            plan.total_bytes += size;
                            tracker.total_bytes = plan.total_bytes;
                            tracker.current_file = next_rel.join("/");
                            plan.files.push(PlannedFile {
                                src_path: child_posix,
                                rel_parts: next_rel,
                                size,
                            });
                            tracker.total_files = plan.files.len();
                            tracker.emit_throttled(TransferStatus::Scanning);
                        }
                    }
                }
            }
        } else if meta.is_regular() || !meta.is_dir() {
            let size = meta.len();
            plan.total_bytes += size;
            tracker.total_bytes = plan.total_bytes;
            tracker.current_file = name.clone();
            plan.files.push(PlannedFile {
                src_path: clean,
                rel_parts: vec![name],
                size,
            });
            tracker.total_files = plan.files.len();
            tracker.emit_throttled(TransferStatus::Scanning);
        }
    }

    Ok(plan)
}

