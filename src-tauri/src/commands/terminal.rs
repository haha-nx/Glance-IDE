//! 终端与构建任务 Commands（M4）。

use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::app_services::terminal::{self, EventSink, TerminalCommand, TerminalInfo};

pub(crate) fn channel_sink(channel: tauri::ipc::Channel<serde_json::Value>) -> EventSink {
    Arc::new(move |v| {
        let _ = channel.send(v);
    })
}
use crate::AppState;

use super::CmdError;

fn parse_uuid(s: &str, what: &str) -> Result<Uuid, CmdError> {
    Uuid::parse_str(s).map_err(|e| CmdError::validation(format!("{what} 无效: {e}")))
}

#[tauri::command]
pub async fn terminal_open(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
    on_data: tauri::ipc::Channel<serde_json::Value>,
) -> Result<TerminalInfo, CmdError> {
    let sid = parse_uuid(&session_id, "session_id")?;
    let registry = state.terminals.clone();
    terminal::open_pty(registry, &state.sessions, sid, cols, rows, channel_sink(on_data))
        .await
        .map_err(CmdError::validation)
}

#[tauri::command]
pub async fn terminal_open_local(
    state: State<'_, AppState>,
    cwd: Option<String>,
    on_data: tauri::ipc::Channel<serde_json::Value>,
) -> Result<TerminalInfo, CmdError> {
    let registry = state.terminals.clone();
    terminal::open_local_terminal(registry, cwd.as_deref(), channel_sink(on_data))
        .await
        .map_err(CmdError::validation)
}

#[tauri::command]
pub async fn terminal_open_wsl(
    state: State<'_, AppState>,
    distro: String,
    cwd: Option<String>,
    on_data: tauri::ipc::Channel<serde_json::Value>,
) -> Result<TerminalInfo, CmdError> {
    let registry = state.terminals.clone();
    terminal::open_wsl_terminal(registry, &distro, cwd.as_deref(), channel_sink(on_data))
        .await
        .map_err(CmdError::validation)
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    channel_id: String,
    data: String,
) -> Result<bool, CmdError> {
    let cid = parse_uuid(&channel_id, "channel_id")?;
    Ok(state
        .terminals
        .send(&cid, TerminalCommand::Write(data.into_bytes())))
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    channel_id: String,
    cols: u32,
    rows: u32,
) -> Result<bool, CmdError> {
    let cid = parse_uuid(&channel_id, "channel_id")?;
    Ok(state.terminals.send(&cid, TerminalCommand::Resize { cols, rows }))
}

#[tauri::command]
pub async fn terminal_close(
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<(), CmdError> {
    let cid = parse_uuid(&channel_id, "channel_id")?;
    state.terminals.send(&cid, TerminalCommand::Close);
    state.terminals.remove_pub(&cid);
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub exit_code: i32,
    pub duration_ms: i64,
}

/// 运行远程构建任务（无 PTY），记录 task_history（§9.1）。
pub async fn run_task_impl(
    state: &State<'_, AppState>,
    session_id: String,
    cwd: String,
    command: String,
    label: String,
    on_output: EventSink,
) -> Result<TaskResult, CmdError> {
    let sid = parse_uuid(&session_id, "session_id")?;
    let entry = state
        .sessions
        .get(&sid)
        .ok_or_else(|| CmdError::validation("会话不存在"))?;
    let device_identity_id = entry.device_identity_id;

    let task_id = Uuid::new_v4();
    let started_at = chrono::Utc::now().timestamp_millis();
    state.db.with(|conn| {
        conn.execute(
            "INSERT INTO task_history (id, device_identity_id, command_label, command, cwd, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                task_id.to_string(),
                device_identity_id.to_string(),
                label,
                command,
                cwd,
                started_at,
            ],
        )?;
        Ok(())
    })?;

    let started = std::time::Instant::now();
    let result = terminal::run_exec(&state.sessions, sid, &cwd, &command, on_output).await;

    let exit_code = match result {
        Ok(code) => code,
        Err(e) => {
            // 任务失败也记录历史
            let _ = state.db.with(|conn| {
                conn.execute(
                    "UPDATE task_history SET exit_code = -1, finished_at = ?2 WHERE id = ?1",
                    rusqlite::params![task_id.to_string(), chrono::Utc::now().timestamp_millis()],
                )?;
                Ok(())
            });
            return Err(CmdError::validation(e));
        }
    };
    state.db.with(|conn| {
        conn.execute(
            "UPDATE task_history SET exit_code = ?2, finished_at = ?3 WHERE id = ?1",
            rusqlite::params![task_id.to_string(), exit_code, chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(())
    })?;

    Ok(TaskResult { exit_code, duration_ms: started.elapsed().as_millis() as i64 })
}

#[tauri::command]
pub async fn run_remote_task(
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
    command: String,
    label: String,
    on_output: tauri::ipc::Channel<serde_json::Value>,
) -> Result<TaskResult, CmdError> {
    run_task_impl(&state, session_id, cwd, command, label, channel_sink(on_output)).await
}

/// 解析任务通道关联的设备（错误跳转定位远程文件用）
#[tauri::command]
pub async fn terminal_device(
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<Option<String>, CmdError> {
    let cid = parse_uuid(&channel_id, "channel_id")?;
    Ok(state.terminals.device_of(&cid).map(|u| u.to_string()))
}
