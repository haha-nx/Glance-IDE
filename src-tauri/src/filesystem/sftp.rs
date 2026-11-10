//! SFTP 文件系统实现（路线图 M3 任务 3.1，§5.2 统一 Provider 的远程侧）。
//! 绑定到已验证的 SSH 会话：一个会话打开一个 SFTP subsystem Channel。
//! 保存前冲突检测与本地实现一致（§5.4 第 3 步）。

use async_trait::async_trait;
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use tokio::sync::Mutex as AsyncMutex;

use super::provider::{
    FileContent, FileEntry, FileKind, FileSystemProvider, FsError, FsResult, WriteResult,
};

pub struct SftpFileSystem {
    sftp: AsyncMutex<SftpSession>,
}

impl SftpFileSystem {
    pub fn new(session: SftpSession) -> Self {
        Self { sftp: AsyncMutex::new(session) }
    }

    /// 解析远程路径（如 "." → 用户主目录）。
    /// 注意：russh-sftp 的 expand_path 依赖 expand-path@openssh.com 扩展（标准 sftp-server
    /// 不宣告该扩展，恒返回 None）；改用标准 SSH_FXP_REALPATH（canonicalize），全服务器可用。
    pub async fn expand_path(&self, path: &str) -> FsResult<String> {
        let clean = path.replace('\\', "/");
        let sftp = self.sftp.lock().await;
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            sftp.canonicalize(&clean),
        )
        .await
        .map_err(|_| FsError::Io("远程路径解析超时 (10s)".into()))?
        .map_err(Self::map_err)
        .map(|p| p.replace('\\', "/"))
    }

    fn map_err(e: impl std::fmt::Display) -> FsError {
        FsError::Io(format!("SFTP: {e}"))
    }

    fn classify(ft: &FileType) -> FileKind {
        if ft.is_symlink() {
            FileKind::Symlink
        } else if ft.is_dir() {
            FileKind::Dir
        } else {
            FileKind::File
        }
    }

    fn mtime_ms(meta: &Metadata) -> i64 {
        meta.mtime.map(|s| (s as i64) * 1000).unwrap_or(0)
    }
}

#[async_trait]
impl FileSystemProvider for SftpFileSystem {
    async fn list_dir(&self, path: &str) -> FsResult<Vec<FileEntry>> {
        let clean_path = path.replace('\\', "/");
        let sftp = self.sftp.lock().await;
        let read_dir = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            sftp.read_dir(&clean_path),
        )
        .await
        .map_err(|_| FsError::Io("读取远程目录超时 (15s)".into()))?
        .map_err(|e| FsError::NotFound(format!("读取远程目录失败: {e}")))?;

        let mut entries = Vec::new();
        for entry in read_dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            let path_full = entry.path().replace('\\', "/");
            entries.push(FileEntry {
                name,
                path: path_full,
                kind: Self::classify(&entry.file_type()),
                size: meta.size.unwrap_or(0),
                modified_ms: meta.mtime.map(|s| (s as i64) * 1000),
            });
        }
        entries.sort_by(|a, b| {
            let dir_cmp = (a.kind != FileKind::Dir).cmp(&(b.kind != FileKind::Dir));
            dir_cmp.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    async fn read_file(&self, path: &str) -> FsResult<FileContent> {
        let clean_path = path.replace('\\', "/");
        let sftp = self.sftp.lock().await;
        let meta = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            sftp.metadata(&clean_path),
        )
        .await
        .map_err(|_| FsError::Io("读取远程文件元数据超时 (15s)".into()))?
        .map_err(Self::map_err)?;

        if meta.is_dir() {
            return Err(FsError::InvalidPath(format!("目标是目录: {clean_path}")));
        }
        let size = meta.size.unwrap_or(0);
        if size > super::provider::READ_LIMIT_BYTES {
            return Err(FsError::TooLarge {
                size,
                limit: super::provider::READ_LIMIT_BYTES,
            });
        }
        let bytes = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            sftp.read(&clean_path),
        )
        .await
        .map_err(|_| FsError::Io("读取远程文件内容超时 (30s)".into()))?
        .map_err(Self::map_err)?;

        let (text, binary) = match String::from_utf8(bytes) {
            Ok(t) => (Some(t), false),
            Err(_) => (None, true),
        };
        Ok(FileContent {
            path: clean_path,
            text,
            binary,
            size,
            modified_ms: Self::mtime_ms(&meta),
        })
    }

    async fn write_file(
        &self,
        path: &str,
        content: &str,
        expected_mtime_ms: Option<i64>,
    ) -> FsResult<WriteResult> {
        let clean_path = path.replace('\\', "/");
        let sftp = self.sftp.lock().await;

        // 保存前冲突检测（§5.4 第 3 步）
        let current_mtime = match sftp.metadata(&clean_path).await {
            Ok(meta) => Some(Self::mtime_ms(&meta)),
            Err(_) => None,
        };
        if let Some(expected) = expected_mtime_ms {
            match current_mtime {
                Some(actual) => {
                    if actual != expected {
                        return Err(FsError::Conflict { current_mtime_ms: actual });
                    }
                }
                None => {
                    if expected != 0 {
                        return Err(FsError::Conflict { current_mtime_ms: 0 });
                    }
                }
            }
        }

        let bytes = content.as_bytes();
        // russh-sftp 的 write() 仅用 WRITE 标志（不 CREATE），
        // 因此用 create()（CREATE|TRUNCATE|WRITE）实现写入。
        // SFTP v3 无服务端原子替换保证；冲突兜底由 expected 检查与 Diff 流程承担（§5.4）。
        {
            let mut file = sftp.create(&clean_path).await.map_err(Self::map_err)?;
            use tokio::io::AsyncWriteExt;
            file.write_all(bytes).await.map_err(Self::map_err)?;
            file.close().await.map_err(Self::map_err)?;
        }
        let meta = sftp.metadata(&clean_path).await.map_err(Self::map_err)?;
        Ok(WriteResult {
            size: meta.size.unwrap_or(bytes.len() as u64),
            modified_ms: Self::mtime_ms(&meta),
        })
    }

    async fn create_dir(&self, path: &str) -> FsResult<()> {
        let clean_path = path.replace('\\', "/");
        let sftp = self.sftp.lock().await;
        if sftp.try_exists(&clean_path).await.unwrap_or(false) {
            return Err(FsError::AlreadyExists(clean_path));
        }
        // 逐级创建（SFTP 无递归 mkdir）
        let mut current = String::new();
        for segment in clean_path.split('/').filter(|s| !s.is_empty()) {
            current = format!("{current}/{segment}");
            if sftp.try_exists(&current).await.unwrap_or(false) {
                continue;
            }
            sftp.create_dir(&current).await.map_err(Self::map_err)?;
        }
        Ok(())
    }

    async fn create_file(&self, path: &str) -> FsResult<()> {
        let clean_path = path.replace('\\', "/");
        let sftp = self.sftp.lock().await;
        if sftp.try_exists(&clean_path).await.unwrap_or(false) {
            return Err(FsError::AlreadyExists(clean_path));
        }
        let file = sftp.create(&clean_path).await.map_err(Self::map_err)?;
        file.close().await.map_err(|e| FsError::Io(format!("SFTP: {e}")))?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> FsResult<()> {
        let clean_from = from.replace('\\', "/");
        let clean_to = to.replace('\\', "/");
        let sftp = self.sftp.lock().await;
        if sftp.try_exists(&clean_to).await.unwrap_or(false) {
            return Err(FsError::AlreadyExists(clean_to));
        }
        sftp.rename(&clean_from, &clean_to).await.map_err(Self::map_err)?;
        Ok(())
    }

    async fn delete(&self, path: &str, recursive: bool) -> FsResult<()> {
        let clean_path = path.replace('\\', "/");
        let sftp = self.sftp.lock().await;
        let meta = sftp.metadata(&clean_path).await.map_err(Self::map_err)?;
        if meta.is_dir() {
            if recursive {
                // 后序遍历删除：先清空子项，再删目录本身
                let stack = vec![clean_path.clone()];
                let mut pending = stack;
                let mut dirs = Vec::new();
                while let Some(dir) = pending.pop() {
                    dirs.push(dir.clone());
                    for entry in sftp.read_dir(&dir).await.map_err(Self::map_err)? {
                        let sub = entry.path().replace('\\', "/");
                        if entry.file_type().is_dir() {
                            pending.push(sub);
                        } else {
                            sftp.remove_file(&sub).await.map_err(Self::map_err)?;
                        }
                    }
                }
                while let Some(dir) = dirs.pop() {
                    sftp.remove_dir(&dir).await.map_err(Self::map_err)?;
                }
                Ok(())
            } else {
                sftp.remove_dir(&clean_path).await.map_err(Self::map_err)
            }
        } else {
            sftp.remove_file(&clean_path).await.map_err(Self::map_err)
        }
    }
}
