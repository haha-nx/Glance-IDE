//! 文件与文件夹传输服务（支持 本地 ↔ SSH / WSL / 本地，含分块流式传输、实时进度、冲突检测与取消清理）。

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use russh_sftp::client::fs::{DirEntry as SftpDirEntry, File as SftpFile, Metadata as SftpMetadata};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::app_services::ssh_sessions::SessionManager;
use crate::app_services::wsl;
use crate::filesystem::remote_uri::ResourceUri;
use crate::filesystem::sftp::SftpFileSystem;

/// 流式读写块大小：256 KiB，与 russh-sftp max_packet_len 匹配以减少 RTT 开销
const TRANSFER_CHUNK_SIZE: usize = 256 * 1024;
/// 进度节流间隔（毫秒）
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(80);
/// 递归遍历深度上限，防止异常挂载结构导致栈/内存无限扩张
const MAX_TRAVERSE_DEPTH: usize = 128;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Scanning,
    Transferring,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    #[default]
    Overwrite,
    Skip,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferConflict {
    pub name: String,
    pub dest_path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressEvent {
    pub task_id: String,
    pub direction: TransferDirection,
    pub status: TransferStatus,
    pub total_files: usize,
    pub completed_files: usize,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub current_file: String,
    pub speed_bytes_per_sec: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub task_id: String,
    pub direction: TransferDirection,
    pub status: TransferStatus,
    pub total_files: usize,
    pub completed_files: usize,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub dest_paths: Vec<String>,
    pub error: Option<String>,
}

/// 活跃传输任务注册表（用于取消与退出清理）
#[derive(Default)]
pub struct TransferRegistry {
    tasks: StdMutex<HashMap<String, Arc<AtomicBool>>>,
}

pub struct TaskGuard {
    registry: Arc<TransferRegistry>,
    task_id: String,
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.registry.tasks.lock() {
            guard.remove(&self.task_id);
        }
    }
}

impl TransferRegistry {
    pub fn register(self: &Arc<Self>, task_id: String) -> (Arc<AtomicBool>, TaskGuard) {
        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.tasks.lock() {
            guard.insert(task_id.clone(), cancel.clone());
        }
        let guard = TaskGuard {
            registry: self.clone(),
            task_id,
        };
        (cancel, guard)
    }

    pub fn cancel(&self, task_id: &str) -> bool {
        if let Ok(guard) = self.tasks.lock() {
            if let Some(flag) = guard.get(task_id) {
                flag.store(true, Ordering::Relaxed);
                return true;
            }
        }
        false
    }

    pub fn cancel_all(&self) {
        if let Ok(guard) = self.tasks.lock() {
            for flag in guard.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

#[derive(Clone)]
enum SftpHandle {
    Dedicated(Arc<SftpSession>),
    Shared(Arc<SftpFileSystem>),
}

impl SftpHandle {
    async fn acquire(sessions: &SessionManager, device_identity_id: Uuid) -> Result<Self, String> {
        let entry = sessions
            .find_by_device(&device_identity_id)
            .await
            .ok_or_else(|| "设备会话未连接，请先连接".to_string())?;
        match entry.open_transfer_sftp().await {
            Ok(sess) => Ok(Self::Dedicated(Arc::new(sess))),
            Err(err) => {
                log::warn!("打开独立传输 SFTP 通道失败，回退主通道: {err}");
                let shared = entry.ensure_sftp().await?;
                Ok(Self::Shared(shared))
            }
        }
    }

    async fn close(&self) {
        if let Self::Dedicated(sess) = self {
            let _ = sess.close().await;
        }
    }

    async fn open_read(&self, path: &str) -> Result<SftpFile, String> {
        match self {
            Self::Dedicated(sess) => sess
                .open(path)
                .await
                .map_err(|e| format!("打开远程文件失败 ({path}): {e}")),
            Self::Shared(fs) => fs
                .session_mutex()
                .lock()
                .await
                .open(path)
                .await
                .map_err(|e| format!("打开远程文件失败 ({path}): {e}")),
        }
    }

    async fn create_write(&self, path: &str) -> Result<SftpFile, String> {
        match self {
            Self::Dedicated(sess) => sess
                .create(path)
                .await
                .map_err(|e| format!("创建远程文件失败 ({path}): {e}")),
            Self::Shared(fs) => fs
                .session_mutex()
                .lock()
                .await
                .create(path)
                .await
                .map_err(|e| format!("创建远程文件失败 ({path}): {e}")),
        }
    }

    async fn symlink_metadata(&self, path: &str) -> Result<SftpMetadata, String> {
        match self {
            Self::Dedicated(sess) => sess
                .symlink_metadata(path)
                .await
                .map_err(|e| format!("读取远程元数据失败 ({path}): {e}")),
            Self::Shared(fs) => fs
                .session_mutex()
                .lock()
                .await
                .symlink_metadata(path)
                .await
                .map_err(|e| format!("读取远程元数据失败 ({path}): {e}")),
        }
    }

    async fn metadata(&self, path: &str) -> Result<SftpMetadata, String> {
        match self {
            Self::Dedicated(sess) => sess
                .metadata(path)
                .await
                .map_err(|e| format!("读取远程目标元数据失败 ({path}): {e}")),
            Self::Shared(fs) => fs
                .session_mutex()
                .lock()
                .await
                .metadata(path)
                .await
                .map_err(|e| format!("读取远程目标元数据失败 ({path}): {e}")),
        }
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<SftpDirEntry>, String> {
        let iter = match self {
            Self::Dedicated(sess) => sess
                .read_dir(path)
                .await
                .map_err(|e| format!("读取远程目录失败 ({path}): {e}"))?,
            Self::Shared(fs) => fs
                .session_mutex()
                .lock()
                .await
                .read_dir(path)
                .await
                .map_err(|e| format!("读取远程目录失败 ({path}): {e}"))?,
        };
        Ok(iter.collect())
    }

    async fn create_dir(&self, path: &str) -> Result<(), String> {
        match self {
            Self::Dedicated(sess) => sess
                .create_dir(path)
                .await
                .map_err(|e| format!("创建远程目录失败 ({path}): {e}")),
            Self::Shared(fs) => fs
                .session_mutex()
                .lock()
                .await
                .create_dir(path)
                .await
                .map_err(|e| format!("创建远程目录失败 ({path}): {e}")),
        }
    }

    async fn remove_file(&self, path: &str) -> Result<(), String> {
        match self {
            Self::Dedicated(sess) => sess
                .remove_file(path)
                .await
                .map_err(|e| format!("清理远程残留文件失败 ({path}): {e}")),
            Self::Shared(fs) => fs
                .session_mutex()
                .lock()
                .await
                .remove_file(path)
                .await
                .map_err(|e| format!("清理远程残留文件失败 ({path}): {e}")),
        }
    }
}

#[derive(Clone, Debug)]
enum LocalOrigin {
    Plain,
    Wsl { distro: String },
}

#[derive(Clone)]
enum ResolvedEndpoint {
    Local {
        path: PathBuf,
        origin: LocalOrigin,
    },
    Remote {
        device_identity_id: Uuid,
        path: String,
    },
}

fn normalize_posix(raw: &str) -> String {
    let mut s = raw.replace('\\', "/");
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    if s.len() > 1 {
        s = s.trim_end_matches('/').to_string();
    }
    if s.is_empty() || !s.starts_with('/') {
        format!("/{s}")
    } else {
        s
    }
}

fn join_posix(base: &str, name: &str) -> String {
    let clean_base = base.trim_end_matches('/');
    let clean_name = name.trim_start_matches('/');
    if clean_base.is_empty() {
        format!("/{clean_name}")
    } else {
        format!("{clean_base}/{clean_name}")
    }
}

fn posix_parent(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return None;
    }
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(idx) => Some(trimmed[..idx].to_string()),
        None => None,
    }
}

fn validate_safe_segment(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(format!("非法文件名或路径片段: {name:?}"));
    }
    Ok(())
}

fn resolve_uri(raw: &str) -> Result<ResolvedEndpoint, String> {
    let parsed = ResourceUri::parse(raw)?;
    match parsed {
        ResourceUri::Local { path } => {
            if path.trim().is_empty() {
                return Err("本地路径不能为空".to_string());
            }
            Ok(ResolvedEndpoint::Local {
                path: PathBuf::from(path),
                origin: LocalOrigin::Plain,
            })
        }
        ResourceUri::Wsl { distro, path } => {
            let unc = wsl::resolve_wsl_unc_path(&distro, &path)?;
            Ok(ResolvedEndpoint::Local {
                path: PathBuf::from(unc),
                origin: LocalOrigin::Wsl { distro },
            })
        }
        ResourceUri::Remote {
            device_identity_id,
            path,
        } => Ok(ResolvedEndpoint::Remote {
            device_identity_id,
            path: normalize_posix(&path),
        }),
    }
}

fn extract_uri_basename(raw: &str) -> Result<String, String> {
    match resolve_uri(raw)? {
        ResolvedEndpoint::Local { path, .. } => {
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .ok_or_else(|| format!("无法从路径提取名称: {raw}"))?;
            validate_safe_segment(&name)?;
            Ok(name)
        }
        ResolvedEndpoint::Remote { path, .. } => {
            let trimmed = path.trim_end_matches('/');
            let name = trimmed
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string();
            validate_safe_segment(&name)?;
            Ok(name)
        }
    }
}

fn format_dest_display(endpoint: &ResolvedEndpoint, rel_name: &str) -> String {
    match endpoint {
        ResolvedEndpoint::Local { path, origin } => {
            let joined = path.join(rel_name);
            match origin {
                LocalOrigin::Plain => joined.to_string_lossy().into_owned(),
                LocalOrigin::Wsl { distro } => {
                    let sub = wsl::strip_wsl_unc_prefix(&joined.to_string_lossy(), distro)
                        .unwrap_or_else(|| format!("/{rel_name}"));
                    format!("wsl://{}{}", distro, sub)
                }
            }
        }
        ResolvedEndpoint::Remote {
            device_identity_id,
            path,
        } => format!("remote://{}{}", device_identity_id, join_posix(path, rel_name)),
    }
}

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

#[derive(Clone)]
struct PlannedFile {
    src_path: String,
    rel_parts: Vec<String>,
    size: u64,
}

#[derive(Default)]
struct TransferPlan {
    dirs: Vec<Vec<String>>,
    files: Vec<PlannedFile>,
    total_bytes: u64,
    top_names: Vec<String>,
}

enum SourceStream {
    Local(tokio::fs::File),
    Remote(SftpFile),
}

impl SourceStream {
    async fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Local(f) => f.read(buf).await,
            Self::Remote(f) => f.read(buf).await,
        }
    }
}

enum DestStream {
    Local(tokio::fs::File),
    Remote(SftpFile),
}

impl DestStream {
    async fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self {
            Self::Local(f) => f.write_all(buf).await,
            Self::Remote(f) => f.write_all(buf).await,
        }
    }

    async fn finish(self) -> Result<(), String> {
        match self {
            Self::Local(mut f) => {
                f.flush()
                    .await
                    .map_err(|e| format!("写入本地文件刷新失败: {e}"))?;
                f.shutdown()
                    .await
                    .map_err(|e| format!("关闭本地文件失败: {e}"))?;
                Ok(())
            }
            Self::Remote(f) => f
                .close()
                .await
                .map_err(|e| format!("关闭远程文件句柄失败: {e}")),
        }
    }
}

enum CopyAbort {
    Cancelled,
    Failed(String),
}

struct ProgressTracker<'a> {
    task_id: String,
    direction: TransferDirection,
    channel: &'a Channel<TransferProgressEvent>,
    started_at: Instant,
    last_emit: Instant,
    total_files: usize,
    completed_files: usize,
    total_bytes: u64,
    transferred_bytes: u64,
    current_file: String,
}

impl<'a> ProgressTracker<'a> {
    fn new(task_id: String, direction: TransferDirection, channel: &'a Channel<TransferProgressEvent>) -> Self {
        let now = Instant::now();
        Self {
            task_id,
            direction,
            channel,
            started_at: now,
            last_emit: now.checked_sub(PROGRESS_EMIT_INTERVAL).unwrap_or(now),
            total_files: 0,
            completed_files: 0,
            total_bytes: 0,
            transferred_bytes: 0,
            current_file: String::new(),
        }
    }

    fn speed(&self) -> u64 {
        let elapsed = self.started_at.elapsed().as_secs_f64();
        if elapsed > 0.05 {
            (self.transferred_bytes as f64 / elapsed) as u64
        } else {
            0
        }
    }

    fn emit_force(&mut self, status: TransferStatus, error: Option<String>) {
        self.last_emit = Instant::now();
        let _ = self.channel.send(TransferProgressEvent {
            task_id: self.task_id.clone(),
            direction: self.direction,
            status,
            total_files: self.total_files,
            completed_files: self.completed_files,
            total_bytes: self.total_bytes,
            transferred_bytes: self.transferred_bytes,
            current_file: self.current_file.clone(),
            speed_bytes_per_sec: self.speed(),
            error,
        });
    }

    fn emit_throttled(&mut self, status: TransferStatus) {
        if self.last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL {
            self.emit_force(status, None);
        }
    }
}

fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

async fn check_self_descendant_local(src: &Path, dest_dir: &Path) -> Result<(), String> {
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
async fn scan_local_sources(
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
async fn scan_remote_sources(
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

async fn ensure_remote_dir_cached(
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

async fn ensure_local_dir(dir: &Path) -> Result<(), String> {
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

fn join_rel_local(base: &Path, parts: &[String]) -> Result<PathBuf, String> {
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

fn join_rel_posix(base: &str, parts: &[String]) -> Result<String, String> {
    let mut out = normalize_posix(base);
    for seg in parts {
        validate_safe_segment(seg)?;
        out = join_posix(&out, seg);
    }
    Ok(out)
}

enum SourceBackend<'a> {
    Local,
    Remote(&'a SftpHandle),
}

enum DestBackend<'a> {
    Local {
        base_dir: PathBuf,
        exact_single_file: Option<PathBuf>,
    },
    Remote {
        base_dir: String,
        sftp: &'a SftpHandle,
        dir_cache: HashSet<String>,
    },
}

impl<'a> DestBackend<'a> {
    async fn prepare_dirs(&mut self, dirs: &[Vec<String>], cancel: &AtomicBool) -> Result<(), CopyAbort> {
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
            Self::Remote {
                base_dir,
                sftp,
                dir_cache,
            } => {
                ensure_remote_dir_cached(sftp, base_dir, dir_cache)
                    .await
                    .map_err(CopyAbort::Failed)?;
                for rel in dirs {
                    if is_cancelled(cancel) {
                        return Err(CopyAbort::Cancelled);
                    }
                    let target = join_rel_posix(base_dir, rel).map_err(CopyAbort::Failed)?;
                    ensure_remote_dir_cached(sftp, &target, dir_cache)
                        .await
                        .map_err(CopyAbort::Failed)?;
                }
                Ok(())
            }
        }
    }

    async fn check_file_conflict(
        &self,
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
            Self::Remote { base_dir, sftp, .. } => {
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

    async fn create_writer(&self, rel_parts: &[String]) -> Result<(DestStream, String), String> {
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
            Self::Remote { base_dir, sftp, .. } => {
                let target = join_rel_posix(base_dir, rel_parts)?;
                let file = sftp.create_write(&target).await?;
                Ok((DestStream::Remote(file), target))
            }
        }
    }

    async fn cleanup_partial(&self, dest_path: &str) {
        match self {
            Self::Local { .. } => {
                let _ = tokio::fs::remove_file(dest_path).await;
            }
            Self::Remote { sftp, .. } => {
                let _ = sftp.remove_file(dest_path).await;
            }
        }
    }
}

async fn open_source(backend: &SourceBackend<'_>, src_path: &str) -> Result<SourceStream, String> {
    match backend {
        SourceBackend::Local => {
            let f = tokio::fs::File::open(src_path)
                .await
                .map_err(|e| format!("打开源文件失败 ({src_path}): {e}"))?;
            Ok(SourceStream::Local(f))
        }
        SourceBackend::Remote(sftp) => {
            let f = sftp.open_read(src_path).await?;
            Ok(SourceStream::Remote(f))
        }
    }
}

async fn execute_plan(
    plan: &TransferPlan,
    source_backend: &SourceBackend<'_>,
    dest_backend: &mut DestBackend<'_>,
    policy: ConflictPolicy,
    cancel: &AtomicBool,
    tracker: &mut ProgressTracker<'_>,
) -> Result<(), CopyAbort> {
    tracker.total_files = plan.files.len();
    tracker.total_bytes = plan.total_bytes;
    tracker.started_at = Instant::now();
    tracker.emit_force(TransferStatus::Transferring, None);

    dest_backend.prepare_dirs(&plan.dirs, cancel).await?;

    let mut buf = vec![0u8; TRANSFER_CHUNK_SIZE];

    for file in &plan.files {
        if is_cancelled(cancel) {
            return Err(CopyAbort::Cancelled);
        }

        tracker.current_file = file.rel_parts.join("/");
        tracker.emit_throttled(TransferStatus::Transferring);

        if dest_backend
            .check_file_conflict(&file.rel_parts, policy)
            .await?
        {
            tracker.transferred_bytes = tracker.transferred_bytes.saturating_add(file.size);
            tracker.completed_files += 1;
            tracker.emit_throttled(TransferStatus::Transferring);
            continue;
        }

        let mut reader = open_source(source_backend, &file.src_path)
            .await
            .map_err(CopyAbort::Failed)?;
        let (mut writer, created_path) = dest_backend
            .create_writer(&file.rel_parts)
            .await
            .map_err(CopyAbort::Failed)?;

        let mut copy_err: Option<CopyAbort> = None;
        loop {
            if is_cancelled(cancel) {
                copy_err = Some(CopyAbort::Cancelled);
                break;
            }
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if let Err(e) = writer.write_all(&buf[..n]).await {
                        copy_err = Some(CopyAbort::Failed(format!(
                            "写入文件失败 ({}): {e}",
                            tracker.current_file
                        )));
                        break;
                    }
                    tracker.transferred_bytes = tracker.transferred_bytes.saturating_add(n as u64);
                    tracker.emit_throttled(TransferStatus::Transferring);
                }
                Err(e) => {
                    copy_err = Some(CopyAbort::Failed(format!(
                        "读取文件失败 ({}): {e}",
                        tracker.current_file
                    )));
                    break;
                }
            }
        }

        if let Some(abort) = copy_err {
            drop(writer);
            drop(reader);
            dest_backend.cleanup_partial(&created_path).await;
            return Err(abort);
        }

        if let Err(e) = writer.finish().await {
            dest_backend.cleanup_partial(&created_path).await;
            return Err(CopyAbort::Failed(e));
        }

        tracker.completed_files += 1;
        tracker.emit_throttled(TransferStatus::Transferring);
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

    let sftp_opt = match &dest {
        ResolvedEndpoint::Remote {
            device_identity_id, ..
        } => Some(SftpHandle::acquire(sessions, *device_identity_id).await.map_err(|e| {
            tracker.emit_force(TransferStatus::Failed, Some(e.clone()));
            e
        })?),
        ResolvedEndpoint::Local { .. } => None,
    };

    let outcome = {
        let source_backend = SourceBackend::Local;
        let mut dest_backend = match (&dest, &sftp_opt) {
            (ResolvedEndpoint::Local { path, .. }, _) => DestBackend::Local {
                base_dir: path.clone(),
                exact_single_file: None,
            },
            (ResolvedEndpoint::Remote { path, .. }, Some(sftp)) => DestBackend::Remote {
                base_dir: path.clone(),
                sftp,
                dir_cache: HashSet::new(),
            },
            _ => unreachable!(),
        };
        execute_plan(
            &plan,
            &source_backend,
            &mut dest_backend,
            conflict_policy,
            &cancel,
            &mut tracker,
        )
        .await
    };

    if let Some(sftp) = sftp_opt {
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
        DownloadKind::RemoteSources { sftp, paths } => {
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

    let outcome = {
        let source_backend = match &download_kind {
            DownloadKind::LocalSources(_) => SourceBackend::Local,
            DownloadKind::RemoteSources { sftp, .. } => SourceBackend::Remote(sftp),
        };
        let mut dest_backend = DestBackend::Local {
            base_dir,
            exact_single_file: if use_exact_file { exact_file_buf } else { None },
        };
        execute_plan(
            &plan,
            &source_backend,
            &mut dest_backend,
            conflict_policy,
            &cancel,
            &mut tracker,
        )
        .await
    };

    if let DownloadKind::RemoteSources { sftp, .. } = download_kind {
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("glance-transfer-test-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create test temp dir");
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_channel() -> (Channel<TransferProgressEvent>, std::sync::mpsc::Receiver<TransferProgressEvent>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let ch = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json_str) = body {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    let status = match val.get("status").and_then(|v| v.as_str()) {
                        Some("scanning") => TransferStatus::Scanning,
                        Some("transferring") => TransferStatus::Transferring,
                        Some("completed") => TransferStatus::Completed,
                        Some("failed") => TransferStatus::Failed,
                        Some("cancelled") => TransferStatus::Cancelled,
                        _ => TransferStatus::Transferring,
                    };
                    let direction = match val.get("direction").and_then(|v| v.as_str()) {
                        Some("download") => TransferDirection::Download,
                        _ => TransferDirection::Upload,
                    };
                    let _ = tx.send(TransferProgressEvent {
                        task_id: val["taskId"].as_str().unwrap_or_default().to_string(),
                        direction,
                        status,
                        total_files: val["totalFiles"].as_u64().unwrap_or(0) as usize,
                        completed_files: val["completedFiles"].as_u64().unwrap_or(0) as usize,
                        total_bytes: val["totalBytes"].as_u64().unwrap_or(0),
                        transferred_bytes: val["transferredBytes"].as_u64().unwrap_or(0),
                        current_file: val["currentFile"].as_str().unwrap_or_default().to_string(),
                        speed_bytes_per_sec: val["speedBytesPerSec"].as_u64().unwrap_or(0),
                        error: val["error"].as_str().map(str::to_string),
                    });
                }
            }
            Ok(())
        });
        (ch, rx)
    }

    #[tokio::test]
    async fn local_upload_and_download_handles_empty_dirs_zero_byte_binary_and_symlinks() {
        let tmp = TestDir::new();
        let src_root = tmp.path().join("src");
        let dst_root = tmp.path().join("dst");
        let dl_root = tmp.path().join("downloads");
        std::fs::create_dir_all(src_root.join("project/empty_sub")).unwrap();
        std::fs::create_dir_all(src_root.join("project/nested")).unwrap();
        std::fs::write(src_root.join("project/zero.txt"), b"").unwrap();
        let bin_data: Vec<u8> = (0..300_000).map(|i| (i % 251) as u8).collect();
        std::fs::write(src_root.join("project/nested/blob.bin"), &bin_data).unwrap();
        std::fs::write(src_root.join("standalone.txt"), b"hello transfer").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                src_root.join("standalone.txt"),
                src_root.join("project/link_file.txt"),
            )
            .unwrap();
            std::os::unix::fs::symlink(
                src_root.join("project"),
                src_root.join("project/loop_dir"),
            )
            .unwrap();
            std::os::unix::fs::symlink(
                src_root.join("does_not_exist"),
                src_root.join("project/broken_link"),
            )
            .unwrap();
        }

        let sessions = SessionManager::default();
        let registry = Arc::new(TransferRegistry::default());

        let (ch, rx) = test_channel();
        let res = run_upload(
            &sessions,
            &registry,
            "t1".into(),
            vec![
                src_root.join("project").to_string_lossy().into_owned(),
                src_root.join("standalone.txt").to_string_lossy().into_owned(),
            ],
            dst_root.to_string_lossy().into_owned(),
            ConflictPolicy::Overwrite,
            ch,
        )
        .await
        .expect("upload succeeds");

        assert_eq!(res.status, TransferStatus::Completed);
        assert!(dst_root.join("project/empty_sub").is_dir());
        assert_eq!(std::fs::read(dst_root.join("project/zero.txt")).unwrap(), b"");
        assert_eq!(
            std::fs::read(dst_root.join("project/nested/blob.bin")).unwrap(),
            bin_data
        );
        assert_eq!(
            std::fs::read(dst_root.join("standalone.txt")).unwrap(),
            b"hello transfer"
        );
        #[cfg(unix)]
        {
            assert_eq!(
                std::fs::read(dst_root.join("project/link_file.txt")).unwrap(),
                b"hello transfer"
            );
            assert!(!dst_root.join("project/loop_dir").exists());
            assert!(!dst_root.join("project/broken_link").exists());
        }

        let events: Vec<_> = rx.try_iter().collect();
        assert!(events.iter().any(|e| e.status == TransferStatus::Scanning));
        assert_eq!(events.last().unwrap().status, TransferStatus::Completed);
        assert_eq!(events.last().unwrap().transferred_bytes, res.total_bytes);

        // 冲突检测 + 跳过策略验证
        let conflicts = check_conflicts(
            &sessions,
            vec![src_root.join("standalone.txt").to_string_lossy().into_owned()],
            dst_root.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].name, "standalone.txt");

        std::fs::write(dst_root.join("standalone.txt"), b"keep-existing").unwrap();
        let (ch_skip, _) = test_channel();
        let skip_res = run_upload(
            &sessions,
            &registry,
            "t2".into(),
            vec![src_root.join("standalone.txt").to_string_lossy().into_owned()],
            dst_root.to_string_lossy().into_owned(),
            ConflictPolicy::Skip,
            ch_skip,
        )
        .await
        .unwrap();
        assert_eq!(skip_res.status, TransferStatus::Completed);
        assert_eq!(
            std::fs::read(dst_root.join("standalone.txt")).unwrap(),
            b"keep-existing"
        );

        // 单文件另存为下载验证
        let (ch_dl, _) = test_channel();
        let exact_dl = dl_root.join("renamed.bin");
        let dl_res = run_download(
            &sessions,
            &registry,
            "t3".into(),
            vec![dst_root.join("project/nested/blob.bin").to_string_lossy().into_owned()],
            None,
            Some(exact_dl.to_string_lossy().into_owned()),
            ConflictPolicy::Overwrite,
            ch_dl,
        )
        .await
        .unwrap();
        assert_eq!(dl_res.status, TransferStatus::Completed);
        assert_eq!(std::fs::read(&exact_dl).unwrap(), bin_data);
    }

    #[tokio::test]
    async fn self_descendant_transfer_is_rejected_and_cancel_cleans_up() {
        let tmp = TestDir::new();
        let dir = tmp.path().join("folder");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), b"abc").unwrap();

        let sessions = SessionManager::default();
        let registry = Arc::new(TransferRegistry::default());
        let (ch, _) = test_channel();
        let err = run_upload(
            &sessions,
            &registry,
            "t-self".into(),
            vec![dir.to_string_lossy().into_owned()],
            dir.join("sub").to_string_lossy().into_owned(),
            ConflictPolicy::Overwrite,
            ch,
        )
        .await
        .unwrap_err();
        assert!(err.contains("自身或子目录"));

        // 预先触发取消标志，验证 Cancelled 返回且不落盘
        let (cancel, _guard) = registry.register("t-cancel".into());
        assert!(registry.cancel("t-cancel"));
        drop(_guard);
        assert!(cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn validate_safe_segment_blocks_traversal() {
        assert!(validate_safe_segment("..").is_err());
        assert!(validate_safe_segment(".").is_err());
        assert!(validate_safe_segment("a/b").is_err());
        assert!(validate_safe_segment("normal-file_1.txt").is_ok());
    }
}
