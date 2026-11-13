//! WSL 相关 Tauri Commands。

#[cfg(windows)]
use std::process::Stdio;
use tauri::State;
#[cfg(windows)]
use tokio::io::AsyncReadExt;
#[cfg(windows)]
use tokio::process::Command;

use crate::app_services::wsl::{self, WslDistro};
use crate::commands::terminal::TaskResult;
use crate::commands::CmdError;
use crate::AppState;

#[cfg(windows)]
fn encode_payload(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[tauri::command]
pub async fn wsl_is_available() -> Result<bool, CmdError> {
    Ok(wsl::is_available())
}

#[tauri::command]
pub async fn wsl_list_distros() -> Result<Vec<WslDistro>, CmdError> {
    wsl::list_distros().map_err(CmdError::validation)
}

#[tauri::command]
pub async fn wsl_distro_home(distro: String) -> Result<String, CmdError> {
    Ok(wsl::get_distro_home(&distro))
}

#[tauri::command]
pub async fn wsl_run_task(
    state: State<'_, AppState>,
    distro: String,
    cwd: String,
    command: String,
    label: String,
    on_output: tauri::ipc::Channel<serde_json::Value>,
) -> Result<TaskResult, CmdError> {
    #[cfg(windows)]
    {
        let task_id = uuid::Uuid::new_v4();
        let started_at = chrono::Utc::now().timestamp_millis();
        let started = std::time::Instant::now();

        // 记录任务历史
        let _ = state.db.with(|conn| {
            conn.execute(
                "INSERT INTO task_history (id, device_identity_id, command_label, command, cwd, started_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    task_id.to_string(),
                    format!("wsl://{distro}"),
                    label,
                    command,
                    cwd,
                    started_at,
                ],
            )?;
            Ok(())
        });

        let mut cmd = Command::new("wsl.exe");
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.arg("-d").arg(&distro);
        if !cwd.trim().is_empty() {
            cmd.arg("--cd").arg(&cwd);
        }
        cmd.arg("--").arg("sh").arg("-c").arg(&command);

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| CmdError::validation(format!("启动 WSL 任务失败: {e}")))?;

        let mut stdout = child.stdout.take().ok_or_else(|| CmdError::validation("无法捕获 stdout"))?;
        let mut stderr = child.stderr.take().ok_or_else(|| CmdError::validation("无法捕获 stderr"))?;

        let on_out_stdout = on_output.clone();
        let stdout_handle = tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = on_out_stdout.send(serde_json::json!({
                            "type": "stdout",
                            "bytes": encode_payload(&buf[..n])
                        }));
                    }
                    Err(_) => break,
                }
            }
        });

        let on_out_stderr = on_output.clone();
        let stderr_handle = tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = on_out_stderr.send(serde_json::json!({
                            "type": "stderr",
                            "bytes": encode_payload(&buf[..n])
                        }));
                    }
                    Err(_) => break,
                }
            }
        });

        let status = child.wait().await.map_err(|e| CmdError::validation(format!("WSL 任务执行中断: {e}")))?;
        let _ = stdout_handle.await;
        let _ = stderr_handle.await;

        let exit_code = status.code().unwrap_or(-1);
        let duration_ms = started.elapsed().as_millis() as i64;

        let _ = on_output.send(serde_json::json!({ "type": "exit", "code": exit_code }));

        let _ = state.db.with(|conn| {
            conn.execute(
                "UPDATE task_history SET exit_code = ?2, finished_at = ?3 WHERE id = ?1",
                rusqlite::params![task_id.to_string(), exit_code, chrono::Utc::now().timestamp_millis()],
            )?;
            Ok(())
        });

        Ok(TaskResult { exit_code, duration_ms })
    }
    #[cfg(not(windows))]
    {
        let _ = (state, distro, cwd, command, label, on_output);
        Err(CmdError::validation("WSL 仅在 Windows 环境下可用"))
    }
}
