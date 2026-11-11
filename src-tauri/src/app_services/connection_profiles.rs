//! 连接配置与设备身份数据服务。
//! - Profile 描述「如何连接」，不等于设备身份（ADR-003）
//! - 一个 Profile 通过 profile_identity_bindings 授权多条设备身份（设备池，ADR-004）
//! - fingerprint 全局唯一；不以 (host, port) 识别设备

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

use crate::ssh::device_pool::{validate_pool, TrustedDevice};
use crate::storage::database::Database;

#[derive(Debug, thiserror::Error)]
pub enum RepoError {
    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("ID 解析失败: {0}")]
    Id(String),
}

pub type RepoResult<T> = Result<T, RepoError>;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn parse_id(s: &str) -> RepoResult<Uuid> {
    Uuid::parse_str(s).map_err(|e| RepoError::Id(format!("{s}: {e}")))
}

// ---------- DTO ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentityDto {
    pub id: Uuid,
    pub key_algorithm: String,
    pub fingerprint: String,
    pub display_name: Option<String>,
    pub trust_status: String,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfileDto {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// password | public_key | agent
    pub auth_method: String,
    /// single | device_pool
    pub identity_mode: String,
    pub key_path: Option<String>,
    pub identities: Vec<DeviceIdentityDto>,
}

/// 连接所需的完整行（含凭据引用，禁止直接下发给前端）
#[derive(Debug, Clone)]
pub struct ProfileRow {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub credential_ref: Option<String>,
    pub key_path: Option<String>,
    pub identity_mode: String,
}

#[derive(Debug, Clone)]
pub struct ProfileFields {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub identity_mode: String,
    pub key_path: Option<String>,
    pub credential_ref: Option<String>,
}

// ---------- 行映射 ----------

fn row_to_identity(row: &rusqlite::Row) -> rusqlite::Result<DeviceIdentityDto> {
    Ok(DeviceIdentityDto {
        id: parse_id(&row.get::<_, String>(0)?).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?,
        key_algorithm: row.get(1)?,
        fingerprint: row.get(2)?,
        display_name: row.get(3)?,
        trust_status: row.get(4)?,
        last_seen_at: row.get(5)?,
    })
}

const IDENTITY_COLS: &str =
    "id, key_algorithm, fingerprint, display_name, trust_status, last_seen_at";

// ---------- Profile CRUD ----------

pub fn get_profile(db: &Database, id: Uuid) -> RepoResult<Option<ProfileRow>> {
    Ok(db
        .with(|conn| {
            conn.query_row(
                "SELECT id, name, host, port, username, auth_method, credential_ref, key_path, identity_mode
                 FROM connection_profiles WHERE id = ?1",
                params![id.to_string()],
                |row| {
                    Ok(ProfileRow {
                        id: parse_id(&row.get::<_, String>(0)?)
                            .map_err(|_e| rusqlite::Error::InvalidColumnType(0, "id".into(), rusqlite::types::Type::Text))?,
                        name: row.get(1)?,
                        host: row.get(2)?,
                        port: row.get::<_, i64>(3)? as u16,
                        username: row.get(4)?,
                        auth_method: row.get(5)?,
                        credential_ref: row.get(6)?,
                        key_path: row.get(7)?,
                        identity_mode: row.get(8)?,
                    })
                },
            )
            .optional()
        })?)
}

pub fn list_profiles(db: &Database) -> RepoResult<Vec<ConnectionProfileDto>> {
    let profiles: Vec<ConnectionProfileDto> = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, host, port, username, auth_method, identity_mode, key_path
             FROM connection_profiles ORDER BY created_at ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ConnectionProfileDto {
                    id: parse_id(&row.get::<_, String>(0)?).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get::<_, i64>(3)? as u16,
                    username: row.get(4)?,
                    auth_method: row.get(5)?,
                    identity_mode: row.get(6)?,
                    key_path: row.get(7)?,
                    identities: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    let bindings: Vec<(Uuid, DeviceIdentityDto)> = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT b.profile_id, d.id, d.key_algorithm, d.fingerprint, d.display_name,
                    d.trust_status, d.last_seen_at
             FROM profile_identity_bindings b
             JOIN device_identities d ON d.id = b.device_identity_id
             WHERE b.status = 'trusted' AND d.trust_status != 'revoked'
             ORDER BY b.approved_at ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let profile_id = parse_id(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                let identity = row_to_identity_by_index(row, 1)?;
                Ok((profile_id, identity))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    let mut result = profiles;
    for (profile_id, identity) in bindings {
        if let Some(p) = result.iter_mut().find(|p| p.id == profile_id) {
            p.identities.push(identity);
        }
    }
    Ok(result)
}

fn row_to_identity_by_index(row: &rusqlite::Row<'_>, start: usize) -> rusqlite::Result<DeviceIdentityDto> {
    Ok(DeviceIdentityDto {
        id: parse_id(&row.get::<_, String>(start)?).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(start, rusqlite::types::Type::Text, Box::new(e))
        })?,
        key_algorithm: row.get(start + 1)?,
        fingerprint: row.get(start + 2)?,
        display_name: row.get(start + 3)?,
        trust_status: row.get(start + 4)?,
        last_seen_at: row.get(start + 5)?,
    })
}

pub fn create_profile(db: &Database, fields: &ProfileFields) -> RepoResult<Uuid> {
    let id = Uuid::new_v4();
    let ts = now_ms();
    db.with(|conn| {
        conn.execute(
            "INSERT INTO connection_profiles
             (id, name, host, port, username, auth_method, credential_ref, identity_mode, created_at, updated_at, key_path)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10)",
            params![
                id.to_string(),
                fields.name,
                fields.host,
                fields.port as i64,
                fields.username,
                fields.auth_method,
                fields.credential_ref,
                fields.identity_mode,
                ts,
                fields.key_path,
            ],
        )?;
        Ok(())
    })?;
    Ok(id)
}

pub fn update_profile(db: &Database, id: Uuid, fields: &ProfileFields) -> RepoResult<()> {
    db.with(|conn| {
        let changed = conn.execute(
            "UPDATE connection_profiles
             SET name=?2, host=?3, port=?4, username=?5, auth_method=?6, identity_mode=?7, key_path=?8, credential_ref=?9, updated_at=?10
             WHERE id=?1",
            params![
                id.to_string(),
                fields.name,
                fields.host,
                fields.port as i64,
                fields.username,
                fields.auth_method,
                fields.identity_mode,
                fields.key_path,
                fields.credential_ref,
                now_ms(),
            ],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    })?;
    Ok(())
}

pub fn delete_profile(db: &Database, id: Uuid) -> RepoResult<Option<String>> {
    // 返回被删除 Profile 的 credential_ref，供命令层清理 OS 凭据（其他 Profile 不受影响：
    // 引用按 Profile 生成，天然独占）
    let cred = db.with(|conn| {
        let cred: Option<Option<String>> = conn
            .query_row(
                "SELECT credential_ref FROM connection_profiles WHERE id=?1",
                params![id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        conn.execute("DELETE FROM connection_profiles WHERE id=?1", params![id.to_string()])?;
        Ok(cred.flatten())
    })?;
    Ok(cred)
}

// ---------- 设备池 ----------

/// Profile 的已授权设备池（binding trusted + identity 未吊销）
pub fn pool_for_profile(db: &Database, profile_id: Uuid) -> RepoResult<Vec<TrustedDevice>> {
    let pool = db.with(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT d.id, d.fingerprint, d.display_name
             FROM profile_identity_bindings b
             JOIN device_identities d ON d.id = b.device_identity_id
             WHERE b.profile_id = ?1 AND b.status = 'trusted' AND d.trust_status = 'trusted'"
        ))?;
        let rows = stmt
            .query_map(params![profile_id.to_string()], |row| {
                Ok(TrustedDevice {
                    device_identity_id: parse_id(&row.get::<_, String>(0)?).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    fingerprint: row.get(1)?,
                    display_name: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    // 克隆镜像指纹防御（「克隆 Host Key」）
    validate_pool(&pool).map_err(|e| RepoError::Id(e.to_string()))?;
    Ok(pool)
}

/// 登记并绑定设备身份（第 5 步之后）：指纹已存在则复用并更新，否则新建。
/// `blob` 来自握手观测；补登记场景允许为空。
pub fn approve_identity(
    db: &Database,
    profile_id: Uuid,
    key_algorithm: &str,
    fingerprint: &str,
    display_name: Option<&str>,
    blob: Vec<u8>,
) -> RepoResult<DeviceIdentityDto> {
    let ts = now_ms();
    let identity_id = db.with(|conn| {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM device_identities WHERE fingerprint = ?1",
                params![fingerprint],
                |row| row.get(0),
            )
            .optional()?;
        match existing {
            Some(id) => {
                conn.execute(
                    "UPDATE device_identities
                     SET trust_status='trusted', display_name=COALESCE(?2, display_name)
                     WHERE id=?1",
                    params![id, display_name],
                )?;
                Ok(id)
            }
            None => {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO device_identities
                     (id, key_algorithm, public_key_blob, fingerprint, display_name, trust_status, first_seen_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'trusted', ?6)",
                    params![id, key_algorithm, blob, fingerprint, display_name, ts],
                )?;
                Ok(id)
            }
        }
    })?;

    db.with(|conn| {
        conn.execute(
            "INSERT INTO profile_identity_bindings (profile_id, device_identity_id, approved_at, status)
             VALUES (?1, ?2, ?3, 'trusted')
             ON CONFLICT(profile_id, device_identity_id) DO UPDATE SET status='trusted'",
            params![profile_id.to_string(), identity_id, ts],
        )?;
        Ok(())
    })?;

    get_identity(db, &identity_id)?.ok_or_else(|| RepoError::Id(identity_id))
}

pub fn get_identity(db: &Database, identity_id: &str) -> RepoResult<Option<DeviceIdentityDto>> {
    Ok(db.with(|conn| {
        conn.query_row(
            &format!("SELECT {IDENTITY_COLS} FROM device_identities WHERE id = ?1"),
            params![identity_id],
            row_to_identity,
        )
        .optional()
    })?)
}

pub fn unbind_identity(db: &Database, profile_id: Uuid, device_identity_id: Uuid) -> RepoResult<()> {
    db.with(|conn| {
        conn.execute(
            "DELETE FROM profile_identity_bindings WHERE profile_id=?1 AND device_identity_id=?2",
            params![profile_id.to_string(), device_identity_id.to_string()],
        )?;
        Ok(())
    })?;
    Ok(())
}

pub fn touch_last_seen(db: &Database, device_identity_id: Uuid) -> RepoResult<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE device_identities SET last_seen_at=?2 WHERE id=?1",
            params![device_identity_id.to_string(), now_ms()],
        )?;
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db(tag: &str) -> (Database, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "glance-profiles-{tag}-{}.sqlite",
            Uuid::new_v4().simple()
        ));
        (Database::open(&path).unwrap(), path)
    }

    fn fields(name: &str) -> ProfileFields {
        ProfileFields {
            name: name.into(),
            host: "192.168.1.100".into(),
            port: 22,
            username: "pi".into(),
            auth_method: "password".into(),
            identity_mode: "device_pool".into(),
            key_path: None,
            credential_ref: Some(format!("glance://profile/{name}")),
        }
    }

    const FP_A: &str = "SHA256:HpUczoNY+jguIUZ5UjeX8i8+jSxQ66W426ODXc21FoQ";

    #[test]
    fn approve_creates_and_reuses_identity() {
        let (db, path) = test_db("approve");
        let pid = create_profile(&db, &fields("树莓派通用连接")).unwrap();

        let first = approve_identity(&db, pid, "ssh-ed25519", FP_A, Some("Pi A"), vec![1, 2, 3]).unwrap();
        assert_eq!(first.fingerprint, FP_A);
        assert_eq!(first.trust_status, "trusted");

        // 同指纹再次登记（另一 Profile）→ 复用同一身份
        let pid2 = create_profile(&db, &fields("第二个配置")).unwrap();
        let second = approve_identity(&db, pid2, "ssh-ed25519", FP_A, None, vec![]).unwrap();
        assert_eq!(first.id, second.id);

        // 设备池包含两个 Profile 的绑定
        let pool = pool_for_profile(&db, pid).unwrap();
        assert_eq!(pool.len(), 1);
        assert_eq!(pool[0].fingerprint, FP_A);

        // 解绑后设备池为空
        unbind_identity(&db, pid, first.id).unwrap();
        assert!(pool_for_profile(&db, pid).unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn list_profiles_includes_bound_identities() {
        let (db, path) = test_db("list");
        let pid = create_profile(&db, &fields("树莓派通用连接")).unwrap();
        approve_identity(&db, pid, "ssh-ed25519", FP_A, Some("Pi A"), vec![9]).unwrap();
        // 未绑定的第二个 Profile 不应有身份
        let pid2 = create_profile(&db, &fields("空配置")).unwrap();
        let _ = pid2;

        let profiles = list_profiles(&db).unwrap();
        assert_eq!(profiles.len(), 2);
        let bound = profiles.iter().find(|p| p.id == pid).unwrap();
        assert_eq!(bound.identities.len(), 1, "绑定的身份应随 Profile 一起返回");
        assert_eq!(bound.identities[0].fingerprint, FP_A);
        assert_eq!(bound.identities[0].display_name.as_deref(), Some("Pi A"));
        let empty = profiles.iter().find(|p| p.id == pid2).unwrap();
        assert!(empty.identities.is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn update_missing_profile_fails() {
        let (db, path) = test_db("update");
        assert!(update_profile(&db, Uuid::new_v4(), &fields("x")).is_err());
        let _ = std::fs::remove_file(path);
    }
}
