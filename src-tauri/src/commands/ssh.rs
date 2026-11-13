//! SSH 连接配置、设备身份登记与连接编排 Commands（M2 任务 2.2/2.5/2.6）。
//! 安全基线：未知/变化 Host Key 阻断（ADR-007）；密码只进 OS 凭据库。

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

use crate::app_services::connection_profiles::{self, ConnectionProfileDto, DeviceIdentityDto, ProfileFields};
use crate::app_services::ssh_sessions::SessionManager;
use crate::ssh::client::{self, AuthKind, ConnectParams, ConnectStep, ObservedServerKey};
use crate::ssh::host_key_verifier::normalize_fingerprint;
use crate::AppState;

use super::CmdError;

pub fn parse_uuid(s: &str, what: &str) -> Result<Uuid, CmdError> {
    Uuid::parse_str(s).map_err(|e| CmdError::validation(format!("{what} 无效: {e}")))
}

// ---------- DTO ----------

#[derive(Debug, Serialize)]
// rename_all 只作用于变体名；变体字段需要 rename_all_fields（serde 1.0.185+）
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConnectOutcomeDto {
    Connected {
        session_id: Uuid,
        device_identity_id: Uuid,
        device_name: Option<String>,
    },
    /// 设备池为空：首次登记新设备
    UnknownIdentity {
        key_algorithm: String,
        fingerprint: String,
    },
    /// 设备池非空但未命中：设备轮换未登记或密钥变化（UI 明确区分提示）
    IdentityChanged {
        key_algorithm: String,
        fingerprint: String,
        expected: Vec<String>,
    },
    AuthFailed {
        message: String,
    },
    NetworkError {
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDto {
    pub session_id: Uuid,
    pub profile_id: Uuid,
    pub device_identity_id: Uuid,
    pub device_name: Option<String>,
    pub endpoint: String,
    pub connected_at: i64,
}

// ---------- 校验 ----------

#[allow(clippy::too_many_arguments)]
fn validate_profile_input(
    name: &str,
    host: &str,
    port: u16,
    username: &str,
    auth_method: &str,
    password: &Option<String>,
    key_path: &Option<String>,
    identity_mode: &str,
    require_password: bool,
) -> Result<(), CmdError> {
    if name.trim().is_empty() {
        return Err(CmdError::validation("名称不能为空"));
    }
    if host.trim().is_empty() {
        return Err(CmdError::validation("主机地址不能为空"));
    }
    if port == 0 {
        return Err(CmdError::validation("端口无效"));
    }
    if username.trim().is_empty() {
        return Err(CmdError::validation("用户名不能为空"));
    }
    match auth_method {
        "password" => {
            if require_password && password.as_deref().unwrap_or("").is_empty() {
                return Err(CmdError::validation("密码认证需要提供密码"));
            }
        }
        "public_key" => {
            if key_path.as_deref().unwrap_or("").trim().is_empty() {
                return Err(CmdError::validation("公钥认证需要提供私钥文件路径"));
            }
        }
        other => return Err(CmdError::validation(format!("暂不支持的认证方式: {other}"))),
    }
    if identity_mode != "single" && identity_mode != "device_pool" {
        return Err(CmdError::validation("身份模式无效"));
    }
    Ok(())
}

// ---------- Profile CRUD ----------

#[tauri::command]
pub async fn list_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfileDto>, CmdError> {
    Ok(connection_profiles::list_profiles(&state.db)?)
}

#[tauri::command]
pub async fn create_profile(
    state: State<'_, AppState>,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
    identity_mode: String,
) -> Result<ConnectionProfileDto, CmdError> {
    validate_profile_input(
        &name,
        &host,
        port,
        &username,
        &auth_method,
        &password,
        &key_path,
        &identity_mode,
        true,
    )?;

    let secret_seed = Uuid::new_v4();
    // 凭据只存 OS 凭据库：密码与私钥口令分别使用独立引用
    let credential_ref = match auth_method.as_str() {
        "password" => {
            let r = format!("glance://profile/{secret_seed}");
            state.secrets.set_secret(&r, password.as_deref().unwrap_or(""))?;
            Some(r)
        }
        "public_key" => match key_passphrase.as_deref().filter(|s| !s.is_empty()) {
            Some(pass) => {
                let r = format!("glance://keypass/{secret_seed}");
                state.secrets.set_secret(&r, pass)?;
                Some(r)
            }
            None => None,
        },
        _ => None,
    };

    let fields = ProfileFields {
        name: name.trim().to_string(),
        host: host.trim().to_string(),
        port,
        username: username.trim().to_string(),
        auth_method,
        identity_mode,
        key_path: key_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()),
        credential_ref: credential_ref.clone(),
    };
    let id = match connection_profiles::create_profile(&state.db, &fields) {
        Ok(id) => id,
        Err(e) => {
            if let Some(ref r) = credential_ref {
                let _ = state.secrets.delete_secret(r);
            }
            return Err(e.into());
        }
    };
    Ok(profile_by_id(&state, id).await?)
}

#[tauri::command]
pub async fn update_profile(
    state: State<'_, AppState>,
    profile_id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
    identity_mode: String,
) -> Result<ConnectionProfileDto, CmdError> {
    let id = parse_uuid(&profile_id, "profile_id")?;
    let existing = connection_profiles::get_profile(&state.db, id)?
        .ok_or_else(|| CmdError::validation("连接配置不存在"))?;

    let has_existing_password =
        existing.auth_method == "password" && existing.credential_ref.is_some();
    validate_profile_input(
        &name,
        &host,
        port,
        &username,
        &auth_method,
        &password,
        &key_path,
        &identity_mode,
        !has_existing_password,
    )?;

    // 凭据更新：严格隔离 password（profile/）与 public_key 口令（keypass/），禁止跨认证模式误用旧凭据
    let mut old_secret_to_delete: Option<String> = None;
    let credential_ref = match auth_method.as_str() {
        "password" => {
            let new_ref = format!("glance://profile/{id}");
            if existing.auth_method == "password" {
                let r = existing.credential_ref.clone().unwrap_or_else(|| new_ref.clone());
                if let Some(pass) = password.as_deref().filter(|s| !s.is_empty()) {
                    state.secrets.set_secret(&r, pass)?;
                }
                Some(r)
            } else {
                let pass = password.as_deref().filter(|s| !s.is_empty()).ok_or_else(|| {
                    CmdError::validation("切换到密码认证时需要提供密码")
                })?;
                state.secrets.set_secret(&new_ref, pass)?;
                if existing.credential_ref.as_deref() != Some(new_ref.as_str()) {
                    old_secret_to_delete = existing.credential_ref.clone();
                }
                Some(new_ref)
            }
        }
        "public_key" => {
            let new_ref = format!("glance://keypass/{id}");
            let has_pass = key_passphrase.as_deref().filter(|s| !s.is_empty());
            match has_pass {
                Some(pass) => {
                    let target_ref = if existing.auth_method == "public_key" {
                        existing.credential_ref.clone().unwrap_or_else(|| new_ref.clone())
                    } else {
                        if existing.credential_ref.as_deref() != Some(new_ref.as_str()) {
                            old_secret_to_delete = existing.credential_ref.clone();
                        }
                        new_ref
                    };
                    state.secrets.set_secret(&target_ref, pass)?;
                    Some(target_ref)
                }
                None => {
                    if existing.auth_method == "public_key" {
                        existing.credential_ref.clone()
                    } else {
                        old_secret_to_delete = existing.credential_ref.clone();
                        None
                    }
                }
            }
        }
        _ => existing.credential_ref.clone(),
    };

    let fields = ProfileFields {
        name: name.trim().to_string(),
        host: host.trim().to_string(),
        port,
        username: username.trim().to_string(),
        auth_method,
        identity_mode,
        key_path: key_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()),
        credential_ref,
    };
    connection_profiles::update_profile(&state.db, id, &fields)?;
    if let Some(old_ref) = old_secret_to_delete {
        let _ = state.secrets.delete_secret(&old_ref);
    }
    Ok(profile_by_id(&state, id).await?)
}

#[tauri::command]
pub async fn delete_profile(state: State<'_, AppState>, profile_id: String) -> Result<(), CmdError> {
    let id = parse_uuid(&profile_id, "profile_id")?;
    if let Some(cred_ref) = connection_profiles::delete_profile(&state.db, id)? {
        // 删除 Profile 时清理其独占的系统凭据（删除需分别确认，UI 已确认）
        let _ = state.secrets.delete_secret(&cred_ref);
    }
    Ok(())
}

async fn profile_by_id(
    state: &State<'_, AppState>,
    id: Uuid,
) -> Result<ConnectionProfileDto, CmdError> {
    connection_profiles::list_profiles(&state.db)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| CmdError::validation("连接配置不存在"))
}

// ---------- 设备身份 ----------

/// 登记并绑定设备身份（指纹确认对话框提交后调用）
#[tauri::command]
pub async fn approve_identity(
    state: State<'_, AppState>,
    profile_id: String,
    key_algorithm: String,
    fingerprint: String,
    display_name: Option<String>,
) -> Result<DeviceIdentityDto, CmdError> {
    let pid = parse_uuid(&profile_id, "profile_id")?;
    let fp = normalize_fingerprint(&fingerprint)
        .map_err(|e| CmdError::validation(format!("指纹无效: {e}")))?;
    // blob 来自此前握手的观测缓存；应用重启后补登记时允许为空
    let blob = state
        .pending_keys
        .lock()
        .unwrap()
        .get(&fp)
        .map(|k| k.blob.clone())
        .unwrap_or_default();

    let dto = connection_profiles::approve_identity(
        &state.db,
        pid,
        &key_algorithm,
        &fp,
        display_name.as_deref().filter(|s| !s.trim().is_empty()),
        blob,
    )?;
    state.pending_keys.lock().unwrap().remove(&fp);
    Ok(dto)
}

#[tauri::command]
pub async fn unbind_identity(
    state: State<'_, AppState>,
    profile_id: String,
    device_identity_id: String,
) -> Result<(), CmdError> {
    let pid = parse_uuid(&profile_id, "profile_id")?;
    let did = parse_uuid(&device_identity_id, "device_identity_id")?;
    connection_profiles::unbind_identity(&state.db, pid, did)?;
    Ok(())
}

// ---------- 连接编排 ----------

/// 从多个打开窗口中选择唯一负责弹窗提示 SSH 断线的窗口标签（纯函数便于单测）。
/// 优先选择正在使用该设备远程工作区的窗口（当前聚焦 → 最近聚焦 → "main" → 字典序首个）；
/// 若无远程工作区命中（例如仅打开了 SSH 终端），则兜底选择发起连接且尚未切到其他设备的窗口。
fn select_prompt_window_label<'a>(
    device_identity_id: Uuid,
    open_windows: &[(&'a str, bool)],
    window_devices: &HashMap<String, Option<Uuid>>,
    last_focused: Option<&str>,
    initiator_label: Option<&str>,
) -> Option<String> {
    let matching: Vec<(&str, bool)> = open_windows
        .iter()
        .copied()
        .filter(|(label, _)| window_devices.get(*label).copied().flatten() == Some(device_identity_id))
        .collect();

    if !matching.is_empty() {
        if let Some((label, _)) = matching.iter().find(|(_, focused)| *focused) {
            return Some((*label).to_string());
        }
        if let Some(last) = last_focused {
            if matching.iter().any(|(label, _)| *label == last) {
                return Some(last.to_string());
            }
        }
        if matching.iter().any(|(label, _)| *label == "main") {
            return Some("main".to_string());
        }
        let mut sorted: Vec<&str> = matching.into_iter().map(|(l, _)| l).collect();
        sorted.sort_unstable();
        return sorted.into_iter().next().map(str::to_string);
    }

    if let Some(initiator) = initiator_label {
        if open_windows.iter().any(|(label, _)| *label == initiator) {
            // 若发起窗口后来切到了另一台远程设备，则不再在它上面弹出本设备的断线提示
            let bound = window_devices.get(initiator).copied().flatten();
            if bound.is_none() || bound == Some(device_identity_id) {
                return Some(initiator.to_string());
            }
        }
    }

    None
}

/// 会话健康监控：设备关机 / 网络中断会让 russh handle 变为 closed。
/// 每 2 秒探测一次，意外掉线时回收会话并向前端推送 `ssh:session-lost`。
///
/// 主动断开（用户点击断开 / 重连替换旧会话）会先把条目从 manager 移除，
/// 此时 `get` 返回 None，监控静默退出，不会误报。
fn spawn_session_watchdog(
    app: tauri::AppHandle,
    session_id: Uuid,
    profile_id: Uuid,
    device_identity_id: Uuid,
    device_name: Option<String>,
    endpoint: String,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            let entry = {
                let state = app.state::<AppState>();
                let found = state.sessions.get(&session_id);
                if found.is_none() {
                    state.session_windows.lock().unwrap().remove(&session_id);
                }
                found
            };
            let Some(entry) = entry else {
                // 会话已被主动移除（用户断开 / 重连替换 / 应用退出）
                break;
            };

            if !entry.is_alive().await {
                let prompt_window_label = {
                    let state = app.state::<AppState>();
                    // 确保后端关联的 LSP 与 SSH 终端同步回收
                    crate::app_services::lsp::close_by_session(&state.lsp, &session_id).await;
                    crate::app_services::terminal::close_by_session(&state.terminals, &session_id);
                    state.sessions.disconnect(&session_id).await;
                    let initiator_label = state.session_windows.lock().unwrap().remove(&session_id);
                    let window_devices = state.window_devices.lock().unwrap().clone();
                    let last_focused = state.last_focused_window.lock().unwrap().clone();
                    let webview_windows = app.webview_windows();
                    let open_windows: Vec<(String, bool)> = webview_windows
                        .iter()
                        .map(|(label, win)| (label.clone(), win.is_focused().unwrap_or(false)))
                        .collect();
                    let open_refs: Vec<(&str, bool)> = open_windows
                        .iter()
                        .map(|(l, f)| (l.as_str(), *f))
                        .collect();
                    select_prompt_window_label(
                        device_identity_id,
                        &open_refs,
                        &window_devices,
                        last_focused.as_deref(),
                        initiator_label.as_deref(),
                    )
                };

                let _ = app.emit(
                    "ssh:session-lost",
                    serde_json::json!({
                        "sessionId": session_id,
                        "profileId": profile_id,
                        "deviceIdentityId": device_identity_id,
                        "deviceName": device_name,
                        "endpoint": endpoint,
                        "promptWindowLabel": prompt_window_label,
                    }),
                );
                break;
            }

            let notify = entry.check_notify();
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
                _ = notify.notified() => {}
            }
        }
    });
}

#[tauri::command]
pub async fn connect_profile(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<ConnectOutcomeDto, CmdError> {
    let pid = parse_uuid(&profile_id, "profile_id")?;
    let row = connection_profiles::get_profile(&state.db, pid)?
        .ok_or_else(|| CmdError::validation("连接配置不存在"))?;
    let pool = connection_profiles::pool_for_profile(&state.db, pid)?;

    let auth = build_auth(&state, &row)?;
    let params = ConnectParams {
        host: row.host.clone(),
        port: row.port,
        username: row.username.clone(),
        auth,
        pool: pool.clone(),
    };

    let outcome = match client::connect_and_auth(params).await {
        ConnectStep::Connected { handle, device_identity_id, device_name } => {
            let _ = connection_profiles::touch_last_seen(&state.db, device_identity_id);
            let endpoint = format!("{}:{}", row.host, row.port);
            // 替换语义（新握手成功后才清旧）：同配置旧会话（含僵尸）一并回收，
            // 避免「再次连接」只增不减、文件操作路由到死会话
            state.sessions.disconnect_profile_sessions(&pid).await;
            let session_id = Uuid::new_v4();
            let window_label = window.label().to_string();
            state.sessions.insert(
                session_id,
                pid,
                device_identity_id,
                device_name.clone(),
                endpoint.clone(),
                chrono::Utc::now().timestamp_millis(),
                handle,
            );
            state
                .session_windows
                .lock()
                .unwrap()
                .insert(session_id, window_label.clone());
            // 启动掉线监控（设备关机/网络中断时通知前端弹窗）
            spawn_session_watchdog(
                app.clone(),
                session_id,
                pid,
                device_identity_id,
                device_name.clone(),
                endpoint,
            );
            let _ = app.emit(
                "ssh:session-connected",
                serde_json::json!({
                    "sessionId": session_id,
                    "profileId": pid,
                    "deviceIdentityId": device_identity_id,
                    "initiatorWindowLabel": window_label,
                }),
            );
            ConnectOutcomeDto::Connected { session_id, device_identity_id, device_name }
        }
        ConnectStep::UnknownIdentity { observed } => {
            cache_pending_key(&state, &observed);
            ConnectOutcomeDto::UnknownIdentity {
                key_algorithm: observed.algorithm,
                fingerprint: observed.fingerprint,
            }
        }
        ConnectStep::IdentityChanged { observed, expected } => {
            cache_pending_key(&state, &observed);
            ConnectOutcomeDto::IdentityChanged {
                key_algorithm: observed.algorithm,
                fingerprint: observed.fingerprint,
                expected,
            }
        }
        ConnectStep::AuthFailed { message } => ConnectOutcomeDto::AuthFailed { message },
        ConnectStep::NetworkError { message } => ConnectOutcomeDto::NetworkError { message },
    };
    Ok(outcome)
}

fn build_auth(state: &State<'_, AppState>, row: &connection_profiles::ProfileRow) -> Result<AuthKind, CmdError> {
    match row.auth_method.as_str() {
        "password" => {
            let cred_ref = row
                .credential_ref
                .clone()
                .ok_or_else(|| CmdError::secret("凭据引用缺失，请重新保存密码"))?;
            let password = state
                .secrets
                .get_secret(&cred_ref)?
                .ok_or_else(|| CmdError::secret("凭据未找到，请重新保存密码"))?;
            Ok(AuthKind::Password(password))
        }
        "public_key" => {
            let key_path = row
                .key_path
                .clone()
                .ok_or_else(|| CmdError::validation("缺少私钥文件路径"))?;
            let passphrase = match &row.credential_ref {
                Some(r) => state.secrets.get_secret(r)?.filter(|s| !s.is_empty()),
                None => None,
            };
            Ok(AuthKind::PrivateKey { key_path: PathBuf::from(key_path), passphrase })
        }
        other => Err(CmdError::validation(format!("暂不支持的认证方式: {other}"))),
    }
}

fn cache_pending_key(state: &State<'_, AppState>, key: &ObservedServerKey) {
    state
        .pending_keys
        .lock()
        .unwrap()
        .insert(key.fingerprint.clone(), key.clone());
}

/// 获取会话的远程主目录（用于打开远程工作区）
#[tauri::command]
pub async fn remote_home(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, CmdError> {
    let sid = parse_uuid(&session_id, "session_id")?;
    let entry = state
        .sessions
        .get(&sid)
        .ok_or_else(|| CmdError::validation("会话不存在"))?;
    let sftp = entry.ensure_sftp().await.map_err(CmdError::validation)?;
    let home = sftp
        .expand_path(".")
        .await
        .map_err(|e| CmdError::validation(e.to_string()))?;
    Ok(home)
}

// ---------- 会话 ----------

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionDto>, CmdError> {
    // 仅过滤返回存活会话并唤醒 watchdog 清理僵尸，避免在此直接删表项导致漏报 ssh:session-lost
    Ok(state
        .sessions
        .list_alive()
        .await
        .into_iter()
        .map(|e| SessionDto {
            session_id: e.session_id,
            profile_id: e.profile_id,
            device_identity_id: e.device_identity_id,
            device_name: e.device_name.clone(),
            endpoint: e.endpoint.clone(),
            connected_at: e.connected_at,
        })
        .collect())
}

/// 记录当前窗口关联的远程设备身份 UUID（本地/空白工作区传 None），用于 SSH 断线弹窗只路由到相关窗口。
#[tauri::command]
pub fn set_window_remote_device(
    window: tauri::Window,
    state: State<'_, AppState>,
    device_identity_id: Option<String>,
) -> Result<(), CmdError> {
    let parsed = match device_identity_id.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(raw) => Some(parse_uuid(raw, "device_identity_id")?),
        None => None,
    };
    state
        .window_devices
        .lock()
        .unwrap()
        .insert(window.label().to_string(), parsed);
    Ok(())
}

#[tauri::command]
pub async fn disconnect_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, CmdError> {
    let sid = parse_uuid(&session_id, "session_id")?;
    state.session_windows.lock().unwrap().remove(&sid);
    // 先回收本会话关联的 LSP 与 SSH 终端通道
    crate::app_services::lsp::close_by_session(&state.lsp, &sid).await;
    crate::app_services::terminal::close_by_session(&state.terminals, &sid);
    Ok(state.sessions.disconnect(&sid).await)
}

/// 供 lib.rs 在应用退出时清理全部会话
pub async fn disconnect_all(sessions: &SessionManager) {
    for entry in sessions.list() {
        let _ = sessions.disconnect(&entry.session_id).await;
    }
}

/// pending_keys 类型别名（AppState 使用）
pub type PendingKeyMap = HashMap<String, ObservedServerKey>;

#[cfg(test)]
mod tests {
    use super::*;

    /// 防回归：枚举变体字段必须序列化为 camelCase（前端契约）。
    /// rename_all 不覆盖变体字段，漏掉 rename_all_fields 会静默断链。
    #[test]
    fn connect_outcome_serializes_camel_case() {
        let out = ConnectOutcomeDto::UnknownIdentity {
            key_algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:x".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&out).unwrap();
        assert_eq!(v["status"], "unknownIdentity");
        assert!(v.get("keyAlgorithm").is_some(), "字段应为 camelCase: {v}");
        assert!(v.get("key_algorithm").is_none());

        let out2 = ConnectOutcomeDto::Connected {
            session_id: Uuid::new_v4(),
            device_identity_id: Uuid::new_v4(),
            device_name: None,
        };
        let v2: serde_json::Value = serde_json::to_value(&out2).unwrap();
        assert!(v2.get("sessionId").is_some(), "Connected 字段应为 camelCase: {v2}");
        assert!(v2.get("deviceIdentityId").is_some());
    }

    #[test]
    fn prompt_window_prefers_active_remote_window_and_skips_unrelated_windows() {
        let dev_a = Uuid::new_v4();
        let dev_b = Uuid::new_v4();
        let open = [("main", false), ("win-2", true), ("win-3", false)];

        // win-2 打开了 dev_a 且聚焦；main 为本地；win-3 打开了 dev_b
        let mut devs = HashMap::new();
        devs.insert("main".into(), None);
        devs.insert("win-2".into(), Some(dev_a));
        devs.insert("win-3".into(), Some(dev_b));

        assert_eq!(
            select_prompt_window_label(dev_a, &open, &devs, Some("win-2"), Some("main")).as_deref(),
            Some("win-2")
        );

        // 两个窗口都在同一台 dev_a 时，只选聚焦（或最近聚焦）的那一个
        devs.insert("win-3".into(), Some(dev_a));
        assert_eq!(
            select_prompt_window_label(dev_a, &[("main", false), ("win-2", false), ("win-3", false)], &devs, Some("win-3"), Some("main")).as_deref(),
            Some("win-3")
        );

        // 无远程工作区使用 dev_a 时，仅当发起窗口仍在且未切到其他设备才兜底
        let mut local_devs = HashMap::new();
        local_devs.insert("main".into(), None);
        local_devs.insert("win-2".into(), Some(dev_b));
        assert_eq!(
            select_prompt_window_label(dev_a, &[("main", false), ("win-2", true)], &local_devs, Some("win-2"), Some("main")).as_deref(),
            Some("main")
        );
        // 若发起窗口已切到 dev_b 或已关闭，不向无关窗口弹窗
        assert_eq!(
            select_prompt_window_label(dev_a, &[("main", false), ("win-2", true)], &local_devs, Some("win-2"), Some("win-2")),
            None
        );
        assert_eq!(
            select_prompt_window_label(dev_a, &[("win-2", true)], &local_devs, Some("win-2"), Some("main")),
            None
        );
    }
}
