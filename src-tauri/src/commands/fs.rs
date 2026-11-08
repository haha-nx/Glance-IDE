//! 文件系统 Commands（M3 起按 URI 调度）：
//! - 本地：普通路径或 `local://<path>` → LocalFileSystem
//! - 远程：`remote://<device-uuid><path>` → 该设备活跃会话的 SftpFileSystem
//! 业务在 `filesystem` 模块；此处仅做 URI 解析与 Provider 路由。

use std::sync::Arc;

use tauri::State;

use crate::filesystem::{
    FileContent, FileEntry, FileSystemProvider, FsError, ResourceUri, WriteResult,
};
use crate::AppState;

/// 解析 URI → (Provider, 实际路径)
async fn resolve(
    state: &State<'_, AppState>,
    uri: &str,
) -> Result<(Arc<dyn FileSystemProvider>, String), FsError> {
    let parsed = ResourceUri::parse(uri).map_err(FsError::InvalidPath)?;
    match parsed {
        ResourceUri::Local { path } => Ok((state.fs.clone(), path)),
        ResourceUri::Remote {
            device_identity_id,
            path,
        } => {
            let entry = state
                .sessions
                .find_by_device(&device_identity_id)
                .await
                .ok_or_else(|| FsError::NotFound("设备会话未连接，请先连接".into()))?;
            let provider = entry.ensure_sftp().await.map_err(FsError::Io)?;
            Ok((provider, path))
        }
    }
}

#[tauri::command]
pub async fn list_dir(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<FileEntry>, FsError> {
    let (provider, real) = resolve(&state, &path).await?;
    provider.list_dir(&real).await
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, path: String) -> Result<FileContent, FsError> {
    let (provider, real) = resolve(&state, &path).await?;
    provider.read_file(&real).await
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
    expected_mtime_ms: Option<i64>,
) -> Result<WriteResult, FsError> {
    let (provider, real) = resolve(&state, &path).await?;
    provider.write_file(&real, &content, expected_mtime_ms).await
}

#[tauri::command]
pub async fn create_dir(state: State<'_, AppState>, path: String) -> Result<(), FsError> {
    let (provider, real) = resolve(&state, &path).await?;
    provider.create_dir(&real).await
}

#[tauri::command]
pub async fn create_file(state: State<'_, AppState>, path: String) -> Result<(), FsError> {
    let (provider, real) = resolve(&state, &path).await?;
    provider.create_file(&real).await
}

#[tauri::command]
pub async fn rename_entry(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), FsError> {
    let (provider, from_real) = resolve(&state, &from).await?;
    let to_parsed = ResourceUri::parse(&to).map_err(FsError::InvalidPath)?;
    // 跨 Provider 重命名不支持（本地 ↔ 远程）
    match to_parsed {
        ResourceUri::Local { .. } => {
            let (_, to_real) = resolve(&state, &to).await?;
            provider.rename(&from_real, &to_real).await
        }
        ResourceUri::Remote { device_identity_id, path } => {
            let to_provider = state
                .sessions
                .find_by_device(&device_identity_id)
                .await
                .ok_or_else(|| FsError::NotFound("设备会话未连接".into()))?
                .ensure_sftp()
                .await
                .map_err(FsError::Io)?;
            if !Arc::ptr_eq(&provider, &(to_provider.clone() as Arc<dyn FileSystemProvider>)) {
                return Err(FsError::InvalidPath("不支持跨文件系统重命名".into()));
            }
            to_provider.rename(&from_real, &path).await
        }
    }
}

#[tauri::command]
pub async fn delete_entry(
    state: State<'_, AppState>,
    path: String,
    recursive: bool,
) -> Result<(), FsError> {
    let (provider, real) = resolve(&state, &path).await?;
    provider.delete(&real, recursive).await
}
