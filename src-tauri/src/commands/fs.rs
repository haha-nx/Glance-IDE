//! 文件系统 Commands（M3 起按 URI 调度）：
//! - 本地：普通路径或 `local://<path>` → LocalFileSystem
//! - 远程：`remote://<device-uuid><path>` → 该设备活跃会话的 SftpFileSystem
//! - WSL：`wsl://<distro><path>` → 本地 UNC 虚拟文件系统
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
            let clean = path.replace('\\', "/");
            Ok((provider, clean))
        }
        ResourceUri::Wsl { distro, path } => {
            #[cfg(windows)]
            {
                let win_path = path.replace('/', "\\");
                let unc_path = format!(r"\\wsl.localhost\{distro}{win_path}");
                Ok((state.fs.clone(), unc_path))
            }
            #[cfg(not(windows))]
            {
                let _ = (distro, path);
                Err(FsError::InvalidPath("WSL 仅在 Windows 环境下可用".into()))
            }
        }
    }
}

#[tauri::command]
pub async fn list_dir(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<FileEntry>, FsError> {
    let parsed = ResourceUri::parse(&path).map_err(FsError::InvalidPath)?;
    match parsed {
        ResourceUri::Local { path } => {
            let (provider, real) = (state.fs.clone(), path);
            provider.list_dir(&real).await
        }
        ResourceUri::Remote {
            device_identity_id,
            path: real,
        } => {
            let entry = state
                .sessions
                .find_by_device(&device_identity_id)
                .await
                .ok_or_else(|| FsError::NotFound("设备会话未连接，请先连接".into()))?;
            let provider = entry.ensure_sftp().await.map_err(FsError::Io)?;
            let clean_real = real.replace('\\', "/");
            let mut entries = provider.list_dir(&clean_real).await?;
            for item in &mut entries {
                let clean = item.path.replace('\\', "/");
                let p = if clean.starts_with('/') {
                    clean
                } else {
                    format!("/{clean}")
                };
                item.path = format!("remote://{}{}", device_identity_id, p);
            }
            Ok(entries)
        }
        ResourceUri::Wsl { distro, path } => {
            #[cfg(windows)]
            {
                let win_path = path.replace('/', "\\");
                let unc_path = format!(r"\\wsl.localhost\{distro}{win_path}");
                let mut entries = state.fs.list_dir(&unc_path).await?;
                let unc_prefix = format!(r"\\wsl.localhost\{distro}");
                let unc_prefix_alt = format!(r"\\wsl$\{distro}");
                for item in &mut entries {
                    let subpath = if let Some(stripped) = item.path.strip_prefix(&unc_prefix) {
                        stripped.replace('\\', "/")
                    } else if let Some(stripped) = item.path.strip_prefix(&unc_prefix_alt) {
                        stripped.replace('\\', "/")
                    } else {
                        if path.ends_with('/') {
                            format!("{}{}", path, item.name)
                        } else {
                            format!("{}/{}", path, item.name)
                        }
                    };
                    let normalized = if subpath.starts_with('/') {
                        subpath
                    } else {
                        format!("/{subpath}")
                    };
                    item.path = format!("wsl://{}{}", distro, normalized);
                }
                Ok(entries)
            }
            #[cfg(not(windows))]
            {
                let _ = (distro, path);
                Err(FsError::InvalidPath("WSL 仅在 Windows 环境下可用".into()))
            }
        }
    }
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, path: String) -> Result<FileContent, FsError> {
    let (provider, real) = resolve(&state, &path).await?;
    let mut content = provider.read_file(&real).await?;
    content.path = path;
    Ok(content)
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
    let (from_provider, from_real) = resolve(&state, &from).await?;
    let (to_provider, to_real) = resolve(&state, &to).await?;
    if !Arc::ptr_eq(&from_provider, &to_provider) {
        return Err(FsError::InvalidPath("不支持跨文件系统重命名".into()));
    }
    from_provider.rename(&from_real, &to_real).await
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
