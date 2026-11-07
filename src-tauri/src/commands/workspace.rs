//! 搜索与界面状态 Commands（M1 任务 1.6/1.7）。

use tauri::State;

use crate::app_services::search::{self, SearchHit};
use crate::AppState;

use super::CmdError;

#[tauri::command]
pub async fn search_workspace(
    _state: State<'_, AppState>,
    root: String,
    query: String,
) -> Result<Vec<SearchHit>, CmdError> {
    let hits = search::search(std::path::PathBuf::from(root), query).await;
    Ok(hits)
}

#[tauri::command]
pub async fn get_ui_state(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, CmdError> {
    let value = state
        .db
        .with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value FROM ui_state WHERE key = ?1",
                    rusqlite::params![key],
                    |row| row.get::<_, String>(0),
                )
                .ok())
        })?;
    Ok(value)
}

#[tauri::command]
pub async fn set_ui_state(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), CmdError> {
    state.db.with(|conn| {
        conn.execute(
            "INSERT INTO ui_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    })?;
    Ok(())
}
