//! 文件传输公共数据类型、SFTP 句柄池与 URI 路径工具。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
pub(super) const TRANSFER_CHUNK_SIZE: usize = 256 * 1024;
/// 多文件并发传输工作协程上限（在独立 SFTP 通道或本地盘上并发）
pub(super) const CONCURRENT_FILE_WORKERS: usize = 4;
/// 进度节流间隔（毫秒）
pub(super) const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(80);
/// 递归遍历深度上限，防止异常挂载结构导致栈/内存无限扩张
pub(super) const MAX_TRAVERSE_DEPTH: usize = 128;

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


#[derive(Clone)]
pub(super) enum SftpHandle {
    Dedicated(Arc<SftpSession>),
    Shared(Arc<SftpFileSystem>),
}

impl SftpHandle {
    pub(super) async fn acquire(sessions: &SessionManager, device_identity_id: Uuid) -> Result<Self, String> {
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

    pub(super) async fn expand_pool(
        self,
        sessions: &SessionManager,
        device_identity_id: Uuid,
        max_handles: usize,
    ) -> Vec<Self> {
        let mut pool = vec![self];
        if max_handles <= 1 || !matches!(pool[0], Self::Dedicated(_)) {
            return pool;
        }
        let Some(entry) = sessions.find_by_device(&device_identity_id).await else {
            return pool;
        };
        for _ in 1..max_handles {
            match entry.open_transfer_sftp().await {
                Ok(sess) => pool.push(Self::Dedicated(Arc::new(sess))),
                Err(_) => break,
            }
        }
        pool
    }

    pub(super) fn is_shared(&self) -> bool {
        matches!(self, Self::Shared(_))
    }

    pub(super) async fn close(&self) {
        if let Self::Dedicated(sess) = self {
            let _ = sess.close().await;
        }
    }

    pub(super) async fn open_read(&self, path: &str) -> Result<SftpFile, String> {
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

    pub(super) async fn create_write(&self, path: &str) -> Result<SftpFile, String> {
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

    pub(super) async fn symlink_metadata(&self, path: &str) -> Result<SftpMetadata, String> {
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

    pub(super) async fn metadata(&self, path: &str) -> Result<SftpMetadata, String> {
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

    pub(super) async fn read_dir(&self, path: &str) -> Result<Vec<SftpDirEntry>, String> {
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

    pub(super) async fn create_dir(&self, path: &str) -> Result<(), String> {
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

    pub(super) async fn remove_file(&self, path: &str) -> Result<(), String> {
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
pub(super) enum LocalOrigin {
    Plain,
    Wsl { distro: String },
}

#[derive(Clone)]
pub(super) enum ResolvedEndpoint {
    Local {
        path: PathBuf,
        origin: LocalOrigin,
    },
    Remote {
        device_identity_id: Uuid,
        path: String,
    },
}

pub(super) fn normalize_posix(raw: &str) -> String {
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

pub(super) fn join_posix(base: &str, name: &str) -> String {
    let clean_base = base.trim_end_matches('/');
    let clean_name = name.trim_start_matches('/');
    if clean_base.is_empty() {
        format!("/{clean_name}")
    } else {
        format!("{clean_base}/{clean_name}")
    }
}

pub(super) fn posix_parent(path: &str) -> Option<String> {
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

pub(super) fn validate_safe_segment(name: &str) -> Result<(), String> {
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

pub(super) fn resolve_uri(raw: &str) -> Result<ResolvedEndpoint, String> {
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

pub(super) fn extract_uri_basename(raw: &str) -> Result<String, String> {
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

pub(super) fn format_dest_display(endpoint: &ResolvedEndpoint, rel_name: &str) -> String {
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


#[derive(Clone)]
pub(super) struct PlannedFile {
    pub(super) src_path: String,
    pub(super) rel_parts: Vec<String>,
    pub(super) size: u64,
}

#[derive(Default)]
pub(super) struct TransferPlan {
    pub(super) dirs: Vec<Vec<String>>,
    pub(super) files: Vec<PlannedFile>,
    pub(super) total_bytes: u64,
    pub(super) top_names: Vec<String>,
}

pub(super) enum SourceStream {
    Local(tokio::fs::File),
    Remote(SftpFile),
}

impl SourceStream {
    pub(super) async fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Local(f) => f.read(buf).await,
            Self::Remote(f) => f.read(buf).await,
        }
    }
}

pub(super) enum DestStream {
    Local(tokio::fs::File),
    Remote(SftpFile),
}

impl DestStream {
    pub(super) async fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self {
            Self::Local(f) => f.write_all(buf).await,
            Self::Remote(f) => f.write_all(buf).await,
        }
    }

    pub(super) async fn finish(self) -> Result<(), String> {
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

pub(super) enum CopyAbort {
    Cancelled,
    Failed(String),
}

pub(super) struct ProgressTracker<'a> {
    pub(super) task_id: String,
    pub(super) direction: TransferDirection,
    pub(super) channel: &'a Channel<TransferProgressEvent>,
    pub(super) started_at: Instant,
    pub(super) last_emit: Instant,
    pub(super) total_files: usize,
    pub(super) completed_files: usize,
    pub(super) total_bytes: u64,
    pub(super) transferred_bytes: u64,
    pub(super) current_file: String,
}

impl<'a> ProgressTracker<'a> {
    pub(super) fn new(task_id: String, direction: TransferDirection, channel: &'a Channel<TransferProgressEvent>) -> Self {
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

    pub(super) fn speed(&self) -> u64 {
        let elapsed = self.started_at.elapsed().as_secs_f64();
        if elapsed > 0.05 {
            (self.transferred_bytes as f64 / elapsed) as u64
        } else {
            0
        }
    }

    pub(super) fn emit_force(&mut self, status: TransferStatus, error: Option<String>) {
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

    pub(super) fn emit_throttled(&mut self, status: TransferStatus) {
        if self.last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL {
            self.emit_force(status, None);
        }
    }
}

pub(super) fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

