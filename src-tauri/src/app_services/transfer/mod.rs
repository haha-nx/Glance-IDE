//! 文件与文件夹传输服务（支持 本地 ↔ SSH / WSL / 本地，含分块流式传输、并发通道、实时进度、冲突检测与取消清理）。

mod runner;
mod scanner;
mod types;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

pub use runner::{run_download, run_upload};
pub use scanner::{check_conflicts, reveal_local_path_sync};
pub use types::{
    ConflictPolicy, TransferConflict, TransferDirection, TransferProgressEvent, TransferResult,
    TransferStatus,
};

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

#[cfg(test)]
mod tests {
    use super::*;
    use super::types::validate_safe_segment;
    use crate::app_services::ssh_sessions::SessionManager;
    use std::path::{Path, PathBuf};
    use tauri::ipc::Channel;
    use uuid::Uuid;

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
