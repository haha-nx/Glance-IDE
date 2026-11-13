//! 文件与文件夹传输 Commands（上传 / 下载 / 冲突检测 / 取消 / 定位本地文件）。

use std::path::Path;

use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::app_services::transfer::{
    self, ConflictPolicy, TransferConflict, TransferProgressEvent, TransferResult,
};
use crate::AppState;

fn resolve_task_id(raw: Option<String>) -> String {
    raw.map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

#[tauri::command]
pub async fn check_transfer_conflicts(
    state: State<'_, AppState>,
    items: Vec<String>,
    target_dir_uri: String,
) -> Result<Vec<TransferConflict>, String> {
    transfer::check_conflicts(&state.sessions, items, target_dir_uri).await
}

#[tauri::command]
pub async fn upload_to_workspace(
    state: State<'_, AppState>,
    task_id: Option<String>,
    source_local_paths: Vec<String>,
    target_dir_uri: String,
    conflict_policy: Option<ConflictPolicy>,
    on_event: Channel<TransferProgressEvent>,
) -> Result<TransferResult, String> {
    transfer::run_upload(
        &state.sessions,
        &state.transfers,
        resolve_task_id(task_id),
        source_local_paths,
        target_dir_uri,
        conflict_policy.unwrap_or_default(),
        on_event,
    )
    .await
}

#[tauri::command]
pub async fn download_from_workspace(
    state: State<'_, AppState>,
    task_id: Option<String>,
    source_uris: Vec<String>,
    dest_dir_path: Option<String>,
    dest_file_path: Option<String>,
    conflict_policy: Option<ConflictPolicy>,
    on_event: Channel<TransferProgressEvent>,
) -> Result<TransferResult, String> {
    transfer::run_download(
        &state.sessions,
        &state.transfers,
        resolve_task_id(task_id),
        source_uris,
        dest_dir_path,
        dest_file_path,
        conflict_policy.unwrap_or_default(),
        on_event,
    )
    .await
}

#[tauri::command]
pub async fn cancel_transfer(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<bool, String> {
    Ok(state.transfers.cancel(&task_id))
}

#[tauri::command]
pub async fn reveal_local_path(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("本地路径不能为空".to_string());
    }
    transfer::reveal_local_path_sync(Path::new(&path))
}
