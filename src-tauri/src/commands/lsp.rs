//! 远程语言智能 Commands（M6 基础：检测；传输桥待 Spike 冻结）。

use tauri::State;

use crate::app_services::lsp::{self, LspServerInfo, ProjectInfo};
use crate::commands::ssh::parse_uuid;
use crate::AppState;

use super::CmdError;

#[tauri::command]
pub async fn lsp_detect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<LspServerInfo>, CmdError> {
    let sid = parse_uuid(&session_id, "session_id")?;
    lsp::detect_servers(&state.sessions, sid)
        .await
        .map_err(CmdError::validation)
}

#[tauri::command]
pub async fn project_detect(
    state: State<'_, AppState>,
    session_id: String,
    workspace_root: String,
) -> Result<ProjectInfo, CmdError> {
    let sid = parse_uuid(&session_id, "session_id")?;
    lsp::detect_project(&state.sessions, sid, &workspace_root)
        .await
        .map_err(CmdError::validation)
}
