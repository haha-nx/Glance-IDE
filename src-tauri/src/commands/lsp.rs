//! 远程语言智能 Commands（M6）：
//! - 检测：lsp_detect / project_detect（只读不安装）
//! - 传输桥：lsp_open / lsp_send / lsp_close（冻结方案：Tauri Channel + Rust 组帧）

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspOpenInfo {
    pub lsp_id: Uuid,
    pub device_identity_id: Uuid,
}

/// 打开远程语言服务器通道（exec 无 PTY）。事件经 Channel 推送：
/// {type:"message", message} | {type:"stderr", text} | {type:"closed", reason?}
#[tauri::command]
pub async fn lsp_open(
    state: State<'_, AppState>,
    session_id: String,
    workspace_root: String,
    language: String,
    server: String,
    args: Vec<String>,
    on_event: tauri::ipc::Channel<lsp::LspEvent>,
) -> Result<LspOpenInfo, CmdError> {
    let sid = parse_uuid(&session_id, "session_id")?;
    let registry = state.lsp.clone();
    let sink: EventSink2 = {
        let channel = on_event;
        std::sync::Arc::new(move |e| {
            let _ = channel.send(e);
        })
    };
    let lsp_id = lsp::open_lsp(
        registry,
        &state.sessions,
        sid,
        &workspace_root,
        &language,
        &server,
        &args,
        sink,
    )
    .await
    .map_err(CmdError::validation)?;
    let device_identity_id = state
        .lsp
        .device_of(&lsp_id)
        .ok_or_else(|| CmdError::validation("LSP 通道注册失败"))?;
    Ok(LspOpenInfo { lsp_id, device_identity_id })
}

/// 前端事件回调类型（LSP 专用，避免与 terminal 的 serde_json::Value sink 混用）
type EventSink2 = std::sync::Arc<dyn Fn(lsp::LspEvent) + Send + Sync>;

/// 发送 JSON-RPC 消息（Rust 侧组帧）
#[tauri::command]
pub async fn lsp_send(
    state: State<'_, AppState>,
    lsp_id: String,
    message: serde_json::Value,
) -> Result<bool, CmdError> {
    let id = parse_uuid(&lsp_id, "lsp_id")?;
    Ok(lsp::send_message(&state.lsp, &id, &message))
}

/// 关闭 LSP 通道（shutdown/exit 语义由前端先发协议消息，此处仅关通道）
#[tauri::command]
pub async fn lsp_close(state: State<'_, AppState>, lsp_id: String) -> Result<(), CmdError> {
    let id = parse_uuid(&lsp_id, "lsp_id")?;
    lsp::close(&state.lsp, &id);
    Ok(())
}
