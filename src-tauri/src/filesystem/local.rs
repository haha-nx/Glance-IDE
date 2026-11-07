//! 本地文件系统实现（路线图 M1 任务 1.1）。
//! - 路径做词法规范化，拒绝 `..` 穿越（§12.1 路径穿越单测项）
//! - 保存采用「临时文件 + rename」近似原子替换（§5.4 第 4 步）
//! - 保存前冲突检测：expected mtime 与当前不一致时返回 Conflict

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use tokio::fs;

use super::provider::{
    system_time_to_ms, FileContent, FileEntry, FileKind, FileSystemProvider, FsError, FsResult,
    WriteResult, READ_LIMIT_BYTES,
};

/// 读取上限常量统一放 provider.rs（`super::provider::READ_LIMIT_BYTES`）

#[derive(Debug, Default)]
pub struct LocalFileSystem;

impl LocalFileSystem {
    pub fn new() -> Self {
        Self
    }
}

/// 词法规范化：解析 `.`，拒绝 `..`；空路径非法。
fn normalize(path: &str) -> FsResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(FsError::InvalidPath("空路径".into()));
    }
    let mut normalized = PathBuf::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                return Err(FsError::InvalidPath(format!("路径不允许包含 '..': {path}")));
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

fn entry_kind(metadata: &std::fs::Metadata, is_symlink: bool) -> FileKind {
    if is_symlink {
        FileKind::Symlink
    } else if metadata.is_dir() {
        FileKind::Dir
    } else {
        FileKind::File
    }
}

#[async_trait]
impl FileSystemProvider for LocalFileSystem {
    async fn list_dir(&self, path: &str) -> FsResult<Vec<FileEntry>> {
        let dir = normalize(path)?;
        if !dir.is_dir() {
            return Err(FsError::NotFound(dir.display().to_string()));
        }
        let mut reader = fs::read_dir(&dir)
            .await
            .map_err(|e| FsError::Io(format!("读取目录失败: {e}")))?;

        let mut entries = Vec::new();
        while let Some(item) = reader
            .next_entry()
            .await
            .map_err(|e| FsError::Io(format!("遍历目录失败: {e}")))?
        {
            let name = item.file_name().to_string_lossy().into_owned();
            let file_type = item
                .file_type()
                .await
                .map_err(|e| FsError::Io(format!("读取类型失败: {e}")))?;
            let is_symlink = file_type.is_symlink();
            // 符号链接按其自身属性展示，不跟随目标
            let metadata = item
                .metadata()
                .await
                .map_err(|e| FsError::Io(format!("读取元数据失败: {e}")))?;
            let modified_ms = metadata.modified().ok().map(system_time_to_ms);
            entries.push(FileEntry {
                name,
                path: item.path().display().to_string(),
                kind: entry_kind(&metadata, is_symlink),
                size: metadata.len(),
                modified_ms,
            });
        }
        entries.sort_by(|a, b| {
            let dir_cmp = (a.kind != FileKind::Dir).cmp(&(b.kind != FileKind::Dir));
            dir_cmp.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    async fn read_file(&self, path: &str) -> FsResult<FileContent> {
        let file_path = normalize(path)?;
        let metadata = fs::metadata(&file_path)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => FsError::NotFound(file_path.display().to_string()),
                _ => FsError::Io(format!("读取元数据失败: {e}")),
            })?;
        if metadata.is_dir() {
            return Err(FsError::InvalidPath(format!("目标是目录: {}", file_path.display())));
        }
        if metadata.len() > READ_LIMIT_BYTES {
            return Err(FsError::TooLarge {
                size: metadata.len(),
                limit: READ_LIMIT_BYTES,
            });
        }
        let modified_ms = metadata.modified().ok().map(system_time_to_ms).unwrap_or(0);
        let bytes = fs::read(&file_path)
            .await
            .map_err(|e| FsError::Io(format!("读取文件失败: {e}")))?;
        match String::from_utf8(bytes) {
            Ok(text) => Ok(FileContent {
                path: file_path.display().to_string(),
                text: Some(text),
                binary: false,
                size: metadata.len(),
                modified_ms,
            }),
            Err(_) => Ok(FileContent {
                path: file_path.display().to_string(),
                text: None,
                binary: true,
                size: metadata.len(),
                modified_ms,
            }),
        }
    }

    async fn write_file(
        &self,
        path: &str,
        content: &str,
        expected_mtime_ms: Option<i64>,
    ) -> FsResult<WriteResult> {
        let file_path = normalize(path)?;
        if file_path.is_dir() {
            return Err(FsError::InvalidPath(format!("目标是目录: {}", file_path.display())));
        }

        // 保存前冲突检测（§5.4 第 3 步）
        if let Some(expected) = expected_mtime_ms {
            if let Ok(current) = fs::metadata(&file_path).await {
                let current_ms = current.modified().ok().map(system_time_to_ms).unwrap_or(0);
                if current_ms != expected {
                    return Err(FsError::Conflict { current_mtime_ms: current_ms });
                }
            } else if expected != 0 {
                // 文件已消失视为冲突（远端被删除），由用户决定是否覆盖
                return Err(FsError::Conflict { current_mtime_ms: 0 });
            }
        }

        // 临时文件 + rename（§5.4 第 4 步；依赖文件系统 rename 覆盖语义）
        let parent = file_path
            .parent()
            .ok_or_else(|| FsError::InvalidPath(format!("缺少父目录: {path}")))?;
        let tmp_name = format!(
            ".{}.glance-tmp-{}",
            file_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into()),
            uuid::Uuid::new_v4().simple(),
        );
        let tmp_path = parent.join(tmp_name);

        {
            let bytes = content.as_bytes();
            use tokio::io::AsyncWriteExt;
            let mut file = fs::File::create(&tmp_path)
                .await
                .map_err(|e| FsError::Io(format!("创建临时文件失败: {e}")))?;
            file.write_all(bytes)
                .await
                .map_err(|e| FsError::Io(format!("写入临时文件失败: {e}")))?;
            file.sync_all()
                .await
                .map_err(|e| FsError::Io(format!("刷盘失败: {e}")))?;
        }

        if let Err(e) = fs::rename(&tmp_path, &file_path).await {
            let _ = fs::remove_file(&tmp_path).await;
            return Err(FsError::Io(format!("替换文件失败: {e}")));
        }

        let metadata = fs::metadata(&file_path)
            .await
            .map_err(|e| FsError::Io(format!("写后读取元数据失败: {e}")))?;
        Ok(WriteResult {
            size: metadata.len(),
            modified_ms: metadata.modified().ok().map(system_time_to_ms).unwrap_or(0),
        })
    }

    async fn create_dir(&self, path: &str) -> FsResult<()> {
        let dir = normalize(path)?;
        if dir.exists() {
            return Err(FsError::AlreadyExists(dir.display().to_string()));
        }
        fs::create_dir_all(&dir)
            .await
            .map_err(|e| FsError::Io(format!("创建目录失败: {e}")))
    }

    async fn create_file(&self, path: &str) -> FsResult<()> {
        let file_path = normalize(path)?;
        if file_path.exists() {
            return Err(FsError::AlreadyExists(file_path.display().to_string()));
        }
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| FsError::Io(format!("创建父目录失败: {e}")))?;
        }
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)
            .await
            .map_err(|e| FsError::Io(format!("创建文件失败: {e}")))?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> FsResult<()> {
        let from = normalize(from)?;
        let to = normalize(to)?;
        if to.exists() {
            return Err(FsError::AlreadyExists(to.display().to_string()));
        }
        fs::rename(&from, &to)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => {
                    FsError::NotFound(from.display().to_string())
                }
                _ => FsError::Io(format!("重命名失败: {e}")),
            })
    }

    async fn delete(&self, path: &str, recursive: bool) -> FsResult<()> {
        let target = normalize(path)?;
        let metadata = fs::metadata(&target)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => FsError::NotFound(target.display().to_string()),
                _ => FsError::Io(format!("读取元数据失败: {e}")),
            })?;
        if metadata.is_dir() {
            if recursive {
                fs::remove_dir_all(&target)
                    .await
                    .map_err(|e| FsError::Io(format!("删除目录失败: {e}")))
            } else {
                fs::remove_dir(&target)
                    .await
                    .map_err(|e| FsError::Io(format!("目录非空，需递归删除: {e}")))
            }
        } else {
            fs::remove_file(&target)
                .await
                .map_err(|e| FsError::Io(format!("删除文件失败: {e}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "glance-test-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn rejects_parent_traversal() {
        let err = normalize("/tmp/a/../..");
        assert!(matches!(err, Err(FsError::InvalidPath(_))));
        assert!(normalize("/tmp/a/./b").is_ok());
    }

    #[tokio::test]
    async fn write_read_roundtrip_and_conflict() {
        let root = temp_root("roundtrip");
        let fs_impl = LocalFileSystem::new();
        let file = root.join("hello.txt");
        let path = file.display().to_string();

        let written = fs_impl
            .write_file(&path, "你好，Glance", None)
            .await
            .unwrap();
        assert!(written.modified_ms > 0);

        let content = fs_impl.read_file(&path).await.unwrap();
        assert_eq!(content.text.as_deref(), Some("你好，Glance"));
        assert!(!content.binary);

        // 期望 mtime 不一致 → Conflict
        let stale = written.modified_ms - 1000;
        let conflict = fs_impl.write_file(&path, "x", Some(stale)).await;
        assert!(matches!(conflict, Err(FsError::Conflict { .. })));

        // 一致 → 成功
        fs_impl.write_file(&path, "v2", Some(written.modified_ms))
            .await
            .unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn create_file_duplicate_fails() {
        let root = temp_root("dup");
        let fs_impl = LocalFileSystem::new();
        let path = root.join("a.txt").display().to_string();
        fs_impl.create_file(&path).await.unwrap();
        assert!(matches!(
            fs_impl.create_file(&path).await,
            Err(FsError::AlreadyExists(_))
        ));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn list_dir_dirs_first() {
        let root = temp_root("list");
        std::fs::create_dir_all(root.join("zdir")).unwrap();
        std::fs::write(root.join("afile.txt"), "x").unwrap();
        let fs_impl = LocalFileSystem::new();
        let entries = fs_impl.list_dir(&root.display().to_string()).await.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].kind, FileKind::Dir);
        assert_eq!(entries[1].name, "afile.txt");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
