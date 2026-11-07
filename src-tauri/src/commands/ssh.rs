//! SSH 连接配置、设备身份登记与连接编排 Commands（M2 任务 2.2/2.5/2.6）。
//! 安全基线：未知/变化 Host Key 阻断（ADR-007）；密码只进 OS 凭据库（§9.2）。

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;
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

fn validate_profile_input(
    name: &str,
    host: &str,
    port: u16,
    username: &str,
    auth_method: &str,
    password: &Option<String>,
    key_path: &Option<String>,
    identity_mode: &str,
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
            if password.as_deref().unwrap_or("").is_empty() {
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
    validate_profile_input(&name, &host, port, &username, &auth_method, &password, &key_path, &identity_mode)?;

    let id = Uuid::new_v4();
    // 凭据只存 OS 凭据库（§9.2）：密码与私钥口令分别使用独立引用
    let credential_ref = match auth_method.as_str() {
        "password" => {
            let r = format!("glance://profile/{id}");
            state.secrets.set_secret(&r, password.as_deref().unwrap_or(""))?;
            Some(r)
        }
        "public_key" => match key_passphrase.as_deref().filter(|s| !s.is_empty()) {
            Some(pass) => {
                let r = format!("glance://keypass/{id}");
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
        credential_ref,
    };
    let id = connection_profiles::create_profile(&state.db, &fields)?;
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
    validate_profile_input(&name, &host, port, &username, &auth_method, &password, &key_path, &identity_mode)?;

    let existing = connection_profiles::get_profile(&state.db, id)?
        .ok_or_else(|| CmdError::validation("连接配置不存在"))?;

    // 凭据更新：仅在用户提供了新值时覆写；密码与口令引用保持原有形态
    let credential_ref = match auth_method.as_str() {
        "password" => {
            let r = existing
                .credential_ref
                .clone()
                .unwrap_or_else(|| format!("glance://profile/{id}"));
            if let Some(pass) = password.as_deref().filter(|s| !s.is_empty()) {
                state.secrets.set_secret(&r, pass)?;
            }
            Some(r)
        }
        "public_key" => {
            let has_pass = key_passphrase.as_deref().filter(|s| !s.is_empty());
            match has_pass {
                Some(pass) => {
                    let r = existing
                        .credential_ref
                        .clone()
                        .unwrap_or_else(|| format!("glance://keypass/{id}"));
                    state.secrets.set_secret(&r, pass)?;
                    Some(r)
                }
                None => existing.credential_ref.clone(),
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
    Ok(profile_by_id(&state, id).await?)
}

#[tauri::command]
pub async fn delete_profile(state: State<'_, AppState>, profile_id: String) -> Result<(), CmdError> {
    let id = parse_uuid(&profile_id, "profile_id")?;
    if let Some(cred_ref) = connection_profiles::delete_profile(&state.db, id)? {
        // 删除 Profile 时清理其独占的系统凭据（§9.4：删除需分别确认，UI 已确认）
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

#[tauri::command]
pub async fn connect_profile(
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
            let session_id = Uuid::new_v4();
            state.sessions.insert(
                session_id,
                pid,
                device_identity_id,
                device_name.clone(),
                endpoint,
                chrono::Utc::now().timestamp_millis(),
                handle,
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
    Ok(state
        .sessions
        .list()
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

#[tauri::command]
pub async fn disconnect_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, CmdError> {
    let sid = parse_uuid(&session_id, "session_id")?;
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
}
