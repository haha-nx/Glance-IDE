//! 传输并发执行引擎、`run_upload` 与 `run_download` 实现。

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use tauri::ipc::Channel;
use tokio::task::JoinSet;
use uuid::Uuid;

use super::scanner::{scan_local_sources, scan_remote_sources};
use super::types::*;
use super::TransferRegistry;
use crate::app_services::ssh_sessions::SessionManager;

pub(super) async fn ensure_remote_dir_cached(
    sftp: &SftpHandle,
    dir: &str,
    cache: &mut HashSet<String>,
) -> Result<(), String> {
    let clean = normalize_posix(dir);
    if cache.contains(&clean) || clean == "/" {
        return Ok(());
    }
    if let Some(parent) = posix_parent(&clean) {
        Box::pin(ensure_remote_dir_cached(sftp, &parent, cache)).await?;
    }
    if let Ok(meta) = sftp.metadata(&clean).await {
        if meta.is_dir() {
            cache.insert(clean);
            return Ok(());
        }
        return Err(format!("目标路径已存在同名文件，无法创建目录: {clean}"));
    }
    if let Err(err) = sftp.create_dir(&clean).await {
        // 二次检查避免并发竞态误报
        if let Ok(meta) = sftp.metadata(&clean).await {
            if meta.is_dir() {
                cache.insert(clean);
                return Ok(());
            }
        }
        return Err(err);
    }
    cache.insert(clean);
    Ok(())
}

pub(super) async fn ensure_local_dir(dir: &Path) -> Result<(), String> {
    if let Ok(meta) = tokio::fs::metadata(dir).await {
        if meta.is_dir() {
            return Ok(());
        }
        return Err(format!(
            "目标路径已存在同名文件，无法创建目录: {}",
            dir.display()
        ));
    }
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("创建本地目录失败 ({}): {e}", dir.display()))
}

pub(super) fn join_rel_local(base: &Path, parts: &[String]) -> Result<PathBuf, String> {
    let mut out = base.to_path_buf();
    for seg in parts {
        validate_safe_segment(seg)?;
        let comp_check = Path::new(seg).components().next();
        if !matches!(comp_check, Some(Component::Normal(_))) {
            return Err(format!("非法目标子路径: {seg}"));
        }
        out.push(seg);
    }
    Ok(out)
}

pub(super) fn join_rel_posix(base: &str, parts: &[String]) -> Result<String, String> {
    let mut out = normalize_posix(base);
    for seg in parts {
        validate_safe_segment(seg)?;
        out = join_posix(&out, seg);
    }
    Ok(out)
}

#[derive(Clone)]
pub(super) enum SourceBackend {
    Local,
    Remote(Vec<SftpHandle>),
}

impl SourceBackend {
    pub(super) fn worker_handle(&self, worker_idx: usize) -> Option<&SftpHandle> {
        match self {
            Self::Local => None,
            Self::Remote(pool) => pool.get(worker_idx % pool.len()),
        }
    }

    pub(super) fn has_shared_sftp(&self) -> bool {
        matches!(self, Self::Remote(pool) if pool.iter().any(|h| h.is_shared()))
    }
}

#[derive(Clone)]
pub(super) enum DestBackend {
    Local {
        base_dir: PathBuf,
        exact_single_file: Option<PathBuf>,
    },
    Remote {
        base_dir: String,
        pool: Vec<SftpHandle>,
    },
}

impl DestBackend {
    pub(super) fn has_shared_sftp(&self) -> bool {
        matches!(self, Self::Remote { pool, .. } if pool.iter().any(|h| h.is_shared()))
    }

    pub(super) fn worker_sftp(&self, worker_idx: usize) -> Option<&SftpHandle> {
        match self {
            Self::Remote { pool, .. } => pool.get(worker_idx % pool.len()),
            Self::Local { .. } => None,
        }
    }

    pub(super) async fn prepare_dirs(&self, dirs: &[Vec<String>], cancel: &AtomicBool) -> Result<(), CopyAbort> {
        match self {
            Self::Local {
                base_dir,
                exact_single_file,
            } => {
                if let Some(exact) = exact_single_file {
                    if let Some(parent) = exact.parent() {
                        ensure_local_dir(parent).await.map_err(CopyAbort::Failed)?;
                    }
                    return Ok(());
                }
                ensure_local_dir(base_dir).await.map_err(CopyAbort::Failed)?;
                for rel in dirs {
                    if is_cancelled(cancel) {
                        return Err(CopyAbort::Cancelled);
                    }
                    let target = join_rel_local(base_dir, rel).map_err(CopyAbort::Failed)?;
                    ensure_local_dir(&target).await.map_err(CopyAbort::Failed)?;
                }
                Ok(())
            }
            Self::Remote { base_dir, pool } => {
                let sftp = pool
                    .first()
                    .ok_or_else(|| CopyAbort::Failed("缺少可用 SFTP 会话".into()))?;
                let mut dir_cache = HashSet::new();
                ensure_remote_dir_cached(sftp, base_dir, &mut dir_cache)
                    .await
                    .map_err(CopyAbort::Failed)?;
                for rel in dirs {
                    if is_cancelled(cancel) {
                        return Err(CopyAbort::Cancelled);
                    }
                    let target = join_rel_posix(base_dir, rel).map_err(CopyAbort::Failed)?;
                    ensure_remote_dir_cached(sftp, &target, &mut dir_cache)
                        .await
                        .map_err(CopyAbort::Failed)?;
                }
                Ok(())
            }
        }
    }

    pub(super) async fn check_file_conflict(
        &self,
        worker_idx: usize,
        rel_parts: &[String],
        policy: ConflictPolicy,
    ) -> Result<bool, CopyAbort> {
        match self {
            Self::Local {
                base_dir,
                exact_single_file,
            } => {
                let target = match exact_single_file {
                    Some(p) => p.clone(),
                    None => join_rel_local(base_dir, rel_parts).map_err(CopyAbort::Failed)?,
                };
                if let Ok(meta) = tokio::fs::symlink_metadata(&target).await {
                    let is_dir = if meta.file_type().is_symlink() {
                        tokio::fs::metadata(&target)
                            .await
                            .map(|m| m.is_dir())
                            .unwrap_or(false)
                    } else {
                        meta.is_dir()
                    };
                    if is_dir {
                        return Err(CopyAbort::Failed(format!(
                            "目标路径 '{}' 是目录，无法覆盖为文件",
                            target.display()
                        )));
                    }
                    if policy == ConflictPolicy::Skip {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            Self::Remote { base_dir, .. } => {
                let sftp = self
                    .worker_sftp(worker_idx)
                    .ok_or_else(|| CopyAbort::Failed("缺少可用 SFTP 会话".into()))?;
                let target = join_rel_posix(base_dir, rel_parts).map_err(CopyAbort::Failed)?;
                if let Ok(meta) = sftp.symlink_metadata(&target).await {
                    let is_dir = if meta.is_symlink() {
                        sftp.metadata(&target)
                            .await
                            .map(|m| m.is_dir())
                            .unwrap_or(false)
                    } else {
                        meta.is_dir()
                    };
                    if is_dir {
                        return Err(CopyAbort::Failed(format!(
                            "目标路径 '{target}' 是目录，无法覆盖为文件"
                        )));
                    }
                    if policy == ConflictPolicy::Skip {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
        }
    }

    pub(super) async fn create_writer(
        &self,
        worker_idx: usize,
        rel_parts: &[String],
    ) -> Result<(DestStream, String), String> {
        match self {
            Self::Local {
                base_dir,
                exact_single_file,
            } => {
                let target = match exact_single_file {
                    Some(p) => p.clone(),
                    None => join_rel_local(base_dir, rel_parts)?,
                };
                if let Some(parent) = target.parent() {
                    ensure_local_dir(parent).await?;
                }
                let file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&target)
                    .await
                    .map_err(|e| format!("创建目标文件失败 ({}): {e}", target.display()))?;
                Ok((
                    DestStream::Local(file),
                    target.to_string_lossy().into_owned(),
                ))
            }
            Self::Remote { base_dir, .. } => {
                let sftp = self
                    .worker_sftp(worker_idx)
                    .ok_or_else(|| "缺少可用 SFTP 会话".to_string())?;
                let target = join_rel_posix(base_dir, rel_parts)?;
                let file = sftp.create_write(&target).await?;
                Ok((DestStream::Remote(file), target))
            }
        }
    }

    pub(super) async fn cleanup_partial(&self, worker_idx: usize, dest_path: &str) {
        match self {
            Self::Local { .. } => {
                let _ = tokio::fs::remove_file(dest_path).await;
            }
            Self::Remote { .. } => {
                if let Some(sftp) = self.worker_sftp(worker_idx) {
                    let _ = sftp.remove_file(dest_path).await;
                }
            }
        }
    }
}

pub(super) async fn open_source(
    backend: &SourceBackend,
    worker_idx: usize,
    src_path: &str,
) -> Result<SourceStream, String> {
    match backend {
        SourceBackend::Local => {
            let f = tokio::fs::File::open(src_path)
                .await
                .map_err(|e| format!("打开源文件失败 ({src_path}): {e}"))?;
            Ok(SourceStream::Local(f))
        }
        SourceBackend::Remote(_) => {
            let sftp = backend
                .worker_handle(worker_idx)
                .ok_or_else(|| "缺少可用 SFTP 会话".to_string())?;
            let f = sftp.open_read(src_path).await?;
            Ok(SourceStream::Remote(f))
        }
    }
}

pub(super) struct SharedProgress {
    pub(super) task_id: String,
    pub(super) direction: TransferDirection,
    pub(super) channel: Channel<TransferProgressEvent>,
    pub(super) started_at: Instant,
    pub(super) total_files: usize,
    pub(super) total_bytes: u64,
    pub(super) completed_files: AtomicUsize,
    pub(super) transferred_bytes: AtomicU64,
    pub(super) emit_state: StdMutex<(Instant, String)>,
}

impl SharedProgress {
    pub(super) fn new(tracker: &ProgressTracker<'_>) -> Self {
        let now = Instant::now();
        Self {
            task_id: tracker.task_id.clone(),
            direction: tracker.direction,
            channel: tracker.channel.clone(),
            started_at: tracker.started_at,
            total_files: tracker.total_files,
            total_bytes: tracker.total_bytes,
            completed_files: AtomicUsize::new(tracker.completed_files),
            transferred_bytes: AtomicU64::new(tracker.transferred_bytes),
            emit_state: StdMutex::new((
                now.checked_sub(PROGRESS_EMIT_INTERVAL).unwrap_or(now),
                tracker.current_file.clone(),
            )),
        }
    }

    pub(super) fn record_and_maybe_emit(&self, add_bytes: u64, add_file: usize, file_name: &str) {
        let transferred = if add_bytes > 0 {
            self.transferred_bytes
                .fetch_add(add_bytes, Ordering::Relaxed)
                .saturating_add(add_bytes)
        } else {
            self.transferred_bytes.load(Ordering::Relaxed)
        };
        let completed = if add_file > 0 {
            self.completed_files.fetch_add(add_file, Ordering::Relaxed) + add_file
        } else {
            self.completed_files.load(Ordering::Relaxed)
        };

        let Ok(mut state) = self.emit_state.lock() else {
            return;
        };
        if state.1 != file_name {
            state.1.clear();
            state.1.push_str(file_name);
        }
        if state.0.elapsed() < PROGRESS_EMIT_INTERVAL {
            return;
        }
        state.0 = Instant::now();
        let current_file = state.1.clone();
        drop(state);

        let elapsed = self.started_at.elapsed().as_secs_f64();
        let speed_bytes_per_sec = if elapsed > 0.05 {
            (transferred as f64 / elapsed) as u64
        } else {
            0
        };
        let _ = self.channel.send(TransferProgressEvent {
            task_id: self.task_id.clone(),
            direction: self.direction,
            status: TransferStatus::Transferring,
            total_files: self.total_files,
            completed_files: completed,
            total_bytes: self.total_bytes,
            transferred_bytes: transferred,
            current_file,
            speed_bytes_per_sec,
            error: None,
        });
    }
}

pub(super) async fn copy_single_file(
    file: &PlannedFile,
    source_backend: &SourceBackend,
    dest_backend: &DestBackend,
    worker_idx: usize,
    policy: ConflictPolicy,
    cancel: &AtomicBool,
    worker_abort: &AtomicBool,
    progress: &SharedProgress,
    buf: &mut [u8],
) -> Result<(), CopyAbort> {
    let rel_name = file.rel_parts.join("/");
    progress.record_and_maybe_emit(0, 0, &rel_name);

    if dest_backend
        .check_file_conflict(worker_idx, &file.rel_parts, policy)
        .await?
    {
        progress.record_and_maybe_emit(file.size, 1, &rel_name);
        return Ok(());
    }

    let mut reader = open_source(source_backend, worker_idx, &file.src_path)
        .await
        .map_err(CopyAbort::Failed)?;
    let (mut writer, created_path) = dest_backend
        .create_writer(worker_idx, &file.rel_parts)
        .await
        .map_err(CopyAbort::Failed)?;

    let mut copy_err: Option<CopyAbort> = None;
    loop {
        if is_cancelled(cancel) {
            copy_err = Some(CopyAbort::Cancelled);
            break;
        }
        if worker_abort.load(Ordering::Relaxed) {
            copy_err = Some(CopyAbort::Cancelled);
            break;
        }
        match reader.read(buf).await {
            Ok(0) => break,
            Ok(n) => {
                if let Err(e) = writer.write_all(&buf[..n]).await {
                    copy_err = Some(CopyAbort::Failed(format!(
                        "写入文件失败 ({rel_name}): {e}"
                    )));
                    break;
                }
                progress.record_and_maybe_emit(n as u64, 0, &rel_name);
            }
            Err(e) => {
                copy_err = Some(CopyAbort::Failed(format!(
                    "读取文件失败 ({rel_name}): {e}"
                )));
                break;
            }
        }
    }

    if let Some(abort) = copy_err {
        drop(writer);
        drop(reader);
        dest_backend.cleanup_partial(worker_idx, &created_path).await;
        return Err(abort);
    }

    if let Err(e) = writer.finish().await {
        dest_backend.cleanup_partial(worker_idx, &created_path).await;
        return Err(CopyAbort::Failed(e));
    }

    progress.record_and_maybe_emit(0, 1, &rel_name);
    Ok(())
}

pub(super) async fn execute_plan(
    plan: &TransferPlan,
    source_backend: SourceBackend,
    dest_backend: DestBackend,
    policy: ConflictPolicy,
    cancel: &Arc<AtomicBool>,
    tracker: &mut ProgressTracker<'_>,
) -> Result<(), CopyAbort> {
    tracker.total_files = plan.files.len();
    tracker.total_bytes = plan.total_bytes;
    tracker.started_at = Instant::now();
    tracker.emit_force(TransferStatus::Transferring, None);

    dest_backend.prepare_dirs(&plan.dirs, cancel).await?;
    if plan.files.is_empty() {
        return Ok(());
    }

    let worker_count = if source_backend.has_shared_sftp() || dest_backend.has_shared_sftp() {
        1
    } else {
        CONCURRENT_FILE_WORKERS.min(plan.files.len())
    };

    let progress = Arc::new(SharedProgress::new(tracker));
    let files = Arc::new(plan.files.clone());
    let next_idx = Arc::new(AtomicUsize::new(0));
    let worker_abort = Arc::new(AtomicBool::new(false));

    let mut join_set = JoinSet::new();
    for worker_idx in 0..worker_count {
        let files = Arc::clone(&files);
        let next_idx = Arc::clone(&next_idx);
        let source_backend = source_backend.clone();
        let dest_backend = dest_backend.clone();
        let cancel = Arc::clone(cancel);
        let worker_abort = Arc::clone(&worker_abort);
        let progress = Arc::clone(&progress);

        join_set.spawn(async move {
            let mut buf = vec![0u8; TRANSFER_CHUNK_SIZE];
            loop {
                if is_cancelled(&cancel) {
                    worker_abort.store(true, Ordering::Relaxed);
                    return Err(CopyAbort::Cancelled);
                }
                if worker_abort.load(Ordering::Relaxed) {
                    return Err(CopyAbort::Cancelled);
                }
                let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                let Some(file) = files.get(idx) else {
                    return Ok(());
                };
                if let Err(err) = copy_single_file(
                    file,
                    &source_backend,
                    &dest_backend,
                    worker_idx,
                    policy,
                    &cancel,
                    &worker_abort,
                    &progress,
                    &mut buf,
                )
                .await
                {
                    worker_abort.store(true, Ordering::Relaxed);
                    return Err(err);
                }
            }
        });
    }

    let mut first_failure: Option<String> = None;
    let mut saw_cancel = false;
    while let Some(res) = join_set.join_next().await {
        match res {
            Ok(Ok(())) => {}
            Ok(Err(CopyAbort::Cancelled)) => {
                saw_cancel = true;
            }
            Ok(Err(CopyAbort::Failed(msg))) => {
                if first_failure.is_none() {
                    first_failure = Some(msg);
                }
            }
            Err(join_err) => {
                if first_failure.is_none() {
                    first_failure = Some(format!("传输工作协程异常终止: {join_err}"));
                }
            }
        }
    }

    tracker.completed_files = progress.completed_files.load(Ordering::Relaxed);
    tracker.transferred_bytes = progress.transferred_bytes.load(Ordering::Relaxed);

    if is_cancelled(cancel) {
        return Err(CopyAbort::Cancelled);
    }
    if let Some(msg) = first_failure {
        return Err(CopyAbort::Failed(msg));
    }
    if saw_cancel {
        return Err(CopyAbort::Cancelled);
    }
    Ok(())
}

/// 将本地文件/文件夹上传到工作区目录（支持 SSH Remote / WSL / 本地目录）。
pub async fn run_upload(
    sessions: &SessionManager,
    registry: &Arc<TransferRegistry>,
    task_id: String,
    source_local_paths: Vec<String>,
    target_dir_uri: String,
    conflict_policy: ConflictPolicy,
    on_event: Channel<TransferProgressEvent>,
) -> Result<TransferResult, String> {
    if source_local_paths.is_empty() {
        return Err("请至少选择一个本地文件或文件夹".to_string());
    }

    let src_paths: Vec<PathBuf> = source_local_paths.into_iter().map(PathBuf::from).collect();
    let dest = resolve_uri(&target_dir_uri)?;
    let (cancel, _guard) = registry.register(task_id.clone());
    let mut tracker = ProgressTracker::new(task_id.clone(), TransferDirection::Upload, &on_event);
    tracker.emit_force(TransferStatus::Scanning, None);

    let dest_local_path = match &dest {
        ResolvedEndpoint::Local { path, .. } => Some(path.as_path()),
        ResolvedEndpoint::Remote { .. } => None,
    };

    let plan = match scan_local_sources(&src_paths, dest_local_path, &cancel, &mut tracker).await {
        Ok(p) => p,
        Err(CopyAbort::Cancelled) => {
            tracker.emit_force(TransferStatus::Cancelled, None);
            return Ok(TransferResult {
                task_id,
                direction: TransferDirection::Upload,
                status: TransferStatus::Cancelled,
                total_files: tracker.total_files,
                completed_files: tracker.completed_files,
                total_bytes: tracker.total_bytes,
                transferred_bytes: tracker.transferred_bytes,
                dest_paths: vec![],
                error: None,
            });
        }
        Err(CopyAbort::Failed(msg)) => {
            tracker.emit_force(TransferStatus::Failed, Some(msg.clone()));
            return Err(msg);
        }
    };

    let dest_paths: Vec<String> = plan
        .top_names
        .iter()
        .map(|name| format_dest_display(&dest, name))
        .collect();

    let sftp_pool = match &dest {
        ResolvedEndpoint::Remote {
            device_identity_id, ..
        } => {
            let primary = SftpHandle::acquire(sessions, *device_identity_id)
                .await
                .map_err(|e| {
                    tracker.emit_force(TransferStatus::Failed, Some(e.clone()));
                    e
                })?;
            let max_handles = if plan.files.len() > 1 {
                CONCURRENT_FILE_WORKERS
            } else {
                1
            };
            primary
                .expand_pool(sessions, *device_identity_id, max_handles)
                .await
        }
        ResolvedEndpoint::Local { .. } => Vec::new(),
    };

    let outcome = {
        let source_backend = SourceBackend::Local;
        let dest_backend = match &dest {
            ResolvedEndpoint::Local { path, .. } => DestBackend::Local {
                base_dir: path.clone(),
                exact_single_file: None,
            },
            ResolvedEndpoint::Remote { path, .. } => DestBackend::Remote {
                base_dir: path.clone(),
                pool: sftp_pool.clone(),
            },
        };
        execute_plan(
            &plan,
            source_backend,
            dest_backend,
            conflict_policy,
            &cancel,
            &mut tracker,
        )
        .await
    };

    for sftp in sftp_pool {
        sftp.close().await;
    }

    match outcome {
        Ok(()) => {
            tracker.completed_files = tracker.total_files;
            tracker.transferred_bytes = tracker.total_bytes;
            tracker.emit_force(TransferStatus::Completed, None);
            Ok(TransferResult {
                task_id,
                direction: TransferDirection::Upload,
                status: TransferStatus::Completed,
                total_files: tracker.total_files,
                completed_files: tracker.completed_files,
                total_bytes: tracker.total_bytes,
                transferred_bytes: tracker.transferred_bytes,
                dest_paths,
                error: None,
            })
        }
        Err(CopyAbort::Cancelled) => {
            tracker.emit_force(TransferStatus::Cancelled, None);
            Ok(TransferResult {
                task_id,
                direction: TransferDirection::Upload,
                status: TransferStatus::Cancelled,
                total_files: tracker.total_files,
                completed_files: tracker.completed_files,
                total_bytes: tracker.total_bytes,
                transferred_bytes: tracker.transferred_bytes,
                dest_paths: vec![],
                error: None,
            })
        }
        Err(CopyAbort::Failed(msg)) => {
            tracker.emit_force(TransferStatus::Failed, Some(msg.clone()));
            Err(msg)
        }
    }
}

/// 从工作区下载文件或文件夹到本地（支持单文件另存为 exact_file，或目录保存 dest_dir）。
#[allow(clippy::too_many_arguments)]
pub async fn run_download(
    sessions: &SessionManager,
    registry: &Arc<TransferRegistry>,
    task_id: String,
    source_uris: Vec<String>,
    dest_dir_path: Option<String>,
    dest_file_path: Option<String>,
    conflict_policy: ConflictPolicy,
    on_event: Channel<TransferProgressEvent>,
) -> Result<TransferResult, String> {
    if source_uris.is_empty() {
        return Err("请至少选择一个要下载的文件或文件夹".to_string());
    }
    if dest_file_path.is_none() && dest_dir_path.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err("缺少本地保存路径".to_string());
    }

    let (cancel, _guard) = registry.register(task_id.clone());
    let mut tracker = ProgressTracker::new(task_id.clone(), TransferDirection::Download, &on_event);
    tracker.emit_force(TransferStatus::Scanning, None);

    let first_resolved = resolve_uri(&source_uris[0])?;

    enum DownloadKind {
        LocalSources(Vec<PathBuf>),
        RemoteSources {
            device_identity_id: Uuid,
            sftp: SftpHandle,
            paths: Vec<String>,
        },
    }

    let download_kind = match first_resolved {
        ResolvedEndpoint::Remote {
            device_identity_id,
            ..
        } => {
            let mut remote_paths = Vec::with_capacity(source_uris.len());
            for raw in &source_uris {
                match resolve_uri(raw)? {
                    ResolvedEndpoint::Remote {
                        device_identity_id: id,
                        path,
                    } if id == device_identity_id => remote_paths.push(path),
                    _ => return Err("批量下载必须在同一远程设备会话内进行".to_string()),
                }
            }
            let sftp = SftpHandle::acquire(sessions, device_identity_id)
                .await
                .map_err(|e| {
                    tracker.emit_force(TransferStatus::Failed, Some(e.clone()));
                    e
                })?;
            DownloadKind::RemoteSources {
                device_identity_id,
                sftp,
                paths: remote_paths,
            }
        }
        ResolvedEndpoint::Local { .. } => {
            let mut local_paths = Vec::with_capacity(source_uris.len());
            for raw in &source_uris {
                match resolve_uri(raw)? {
                    ResolvedEndpoint::Local { path, .. } => local_paths.push(path),
                    ResolvedEndpoint::Remote { .. } => {
                        return Err("不能在同一次下载中混用本地与远程路径".to_string())
                    }
                }
            }
            DownloadKind::LocalSources(local_paths)
        }
    };

    let dest_dir_buf = dest_dir_path.as_ref().map(PathBuf::from);
    let exact_file_buf = dest_file_path.as_ref().map(PathBuf::from);

    let scan_res = match &download_kind {
        DownloadKind::LocalSources(paths) => {
            scan_local_sources(paths, dest_dir_buf.as_deref(), &cancel, &mut tracker).await
        }
        DownloadKind::RemoteSources { sftp, paths, .. } => {
            scan_remote_sources(sftp, paths, &cancel, &mut tracker).await
        }
    };

    let plan = match scan_res {
        Ok(p) => p,
        Err(CopyAbort::Cancelled) => {
            if let DownloadKind::RemoteSources { sftp, .. } = &download_kind {
                sftp.close().await;
            }
            tracker.emit_force(TransferStatus::Cancelled, None);
            return Ok(TransferResult {
                task_id,
                direction: TransferDirection::Download,
                status: TransferStatus::Cancelled,
                total_files: tracker.total_files,
                completed_files: tracker.completed_files,
                total_bytes: tracker.total_bytes,
                transferred_bytes: tracker.transferred_bytes,
                dest_paths: vec![],
                error: None,
            });
        }
        Err(CopyAbort::Failed(msg)) => {
            if let DownloadKind::RemoteSources { sftp, .. } = &download_kind {
                sftp.close().await;
            }
            tracker.emit_force(TransferStatus::Failed, Some(msg.clone()));
            return Err(msg);
        }
    };

    let use_exact_file = exact_file_buf.is_some() && plan.dirs.is_empty() && plan.files.len() == 1;
    let base_dir = if use_exact_file {
        exact_file_buf
            .as_ref()
            .and_then(|p| p.parent())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf()
    } else if let Some(dir) = dest_dir_buf {
        dir
    } else if let Some(exact) = &exact_file_buf {
        exact
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf()
    } else {
        unreachable!()
    };

    let dest_paths: Vec<String> = if use_exact_file {
        vec![exact_file_buf
            .as_ref()
            .unwrap()
            .to_string_lossy()
            .into_owned()]
    } else {
        plan.top_names
            .iter()
            .map(|name| base_dir.join(name).to_string_lossy().into_owned())
            .collect()
    };

    let sftp_pool = match download_kind {
        DownloadKind::LocalSources(_) => Vec::new(),
        DownloadKind::RemoteSources {
            device_identity_id,
            sftp,
            ..
        } => {
            let max_handles = if plan.files.len() > 1 {
                CONCURRENT_FILE_WORKERS
            } else {
                1
            };
            sftp.expand_pool(sessions, device_identity_id, max_handles).await
        }
    };

    let outcome = {
        let source_backend = if sftp_pool.is_empty() {
            SourceBackend::Local
        } else {
            SourceBackend::Remote(sftp_pool.clone())
        };
        let dest_backend = DestBackend::Local {
            base_dir,
            exact_single_file: if use_exact_file { exact_file_buf } else { None },
        };
        execute_plan(
            &plan,
            source_backend,
            dest_backend,
            conflict_policy,
            &cancel,
            &mut tracker,
        )
        .await
    };

    for sftp in sftp_pool {
        sftp.close().await;
    }

    match outcome {
        Ok(()) => {
            tracker.completed_files = tracker.total_files;
            tracker.transferred_bytes = tracker.total_bytes;
            tracker.emit_force(TransferStatus::Completed, None);
            Ok(TransferResult {
                task_id,
                direction: TransferDirection::Download,
                status: TransferStatus::Completed,
                total_files: tracker.total_files,
                completed_files: tracker.completed_files,
                total_bytes: tracker.total_bytes,
                transferred_bytes: tracker.transferred_bytes,
                dest_paths,
                error: None,
            })
        }
        Err(CopyAbort::Cancelled) => {
            tracker.emit_force(TransferStatus::Cancelled, None);
            Ok(TransferResult {
                task_id,
                direction: TransferDirection::Download,
                status: TransferStatus::Cancelled,
                total_files: tracker.total_files,
                completed_files: tracker.completed_files,
                total_bytes: tracker.total_bytes,
                transferred_bytes: tracker.transferred_bytes,
                dest_paths: vec![],
                error: None,
            })
        }
        Err(CopyAbort::Failed(msg)) => {
            tracker.emit_force(TransferStatus::Failed, Some(msg.clone()));
            Err(msg)
        }
    }
}

