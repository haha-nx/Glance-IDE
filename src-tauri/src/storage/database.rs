//! 数据库打开、迁移与访问封装。
//! 表结构对应路线图 §9.1 的核心表。fingerprint 全局唯一；
//! 不以 (host, port) 作为设备身份键（§9.1 底部说明）。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

const SCHEMA_VERSION: i32 = 2;

/// 每个版本一条迁移。MIGRATIONS[0] 把 user_version 0 → 1。
/// v1：核心表（路线图 §9.1）
const MIGRATION_V1: &str = r#"
CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    auth_method TEXT NOT NULL CHECK (auth_method IN ('password','public_key','agent')),
    credential_ref TEXT,
    identity_mode TEXT NOT NULL DEFAULT 'single' CHECK (identity_mode IN ('single','device_pool')),
    auto_reconnect INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE device_identities (
    id TEXT PRIMARY KEY,
    key_algorithm TEXT NOT NULL,
    public_key_blob BLOB NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    display_name TEXT,
    trust_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (trust_status IN ('pending','trusted','revoked')),
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER
);

CREATE TABLE profile_identity_bindings (
    profile_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE,
    device_identity_id TEXT NOT NULL REFERENCES device_identities(id) ON DELETE CASCADE,
    approved_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'trusted' CHECK (status IN ('trusted','revoked')),
    PRIMARY KEY (profile_id, device_identity_id)
);

CREATE TABLE remote_environments (
    id TEXT PRIMARY KEY,
    device_identity_id TEXT NOT NULL REFERENCES device_identities(id) ON DELETE CASCADE,
    workspace_root TEXT NOT NULL,
    os TEXT,
    arch TEXT,
    ros_distro TEXT,
    shell TEXT,
    tool_versions TEXT,
    compile_db_path TEXT,
    updated_at INTEGER,
    UNIQUE (device_identity_id, workspace_root)
);

CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('local','remote')),
    device_identity_id TEXT REFERENCES device_identities(id) ON DELETE CASCADE,
    root_uri TEXT NOT NULL,
    name TEXT NOT NULL,
    last_opened_at INTEGER NOT NULL
);

CREATE TABLE remote_file_metadata (
    device_identity_id TEXT NOT NULL,
    path TEXT NOT NULL,
    mtime_ms INTEGER,
    size INTEGER,
    hash TEXT,
    checked_at INTEGER,
    PRIMARY KEY (device_identity_id, path)
);

CREATE TABLE remote_cache_entries (
    device_identity_id TEXT NOT NULL,
    path TEXT NOT NULL,
    local_cache_path TEXT NOT NULL,
    content_hash TEXT,
    last_used_at INTEGER,
    PRIMARY KEY (device_identity_id, path)
);

CREATE TABLE recent_resources (
    resource_uri TEXT NOT NULL,
    workspace_id TEXT,
    opened_at INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (resource_uri, workspace_id)
);

CREATE TABLE ui_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE task_history (
    id TEXT PRIMARY KEY,
    device_identity_id TEXT,
    workspace_id TEXT,
    command_label TEXT NOT NULL,
    command TEXT NOT NULL,
    cwd TEXT,
    exit_code INTEGER,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
);

CREATE INDEX idx_bindings_profile ON profile_identity_bindings(profile_id);
CREATE INDEX idx_workspaces_device ON workspaces(device_identity_id);
CREATE INDEX idx_tasks_device ON task_history(device_identity_id);
"#;

/// v2：公钥认证所需的私钥文件路径（口令仍存 OS 凭据库，§9.2）
const MIGRATION_V2: &str = "ALTER TABLE connection_profiles ADD COLUMN key_path TEXT;";

const MIGRATIONS: &[&str] = &[MIGRATION_V1, MIGRATION_V2];

#[derive(Debug)]
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// 打开（或创建）数据库并执行迁移。迁移前对旧库做一次备份（§9.4）。
    pub fn open(path: &Path) -> Result<Self, rusqlite::Error> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let current: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current < SCHEMA_VERSION {
            Self::backup_before_migrate(path, current);
            for (i, migration) in MIGRATIONS.iter().enumerate() {
                let target = (i + 1) as i32;
                if current < target {
                    conn.execute_batch(migration)?;
                    conn.pragma_update(None, "user_version", target)?;
                }
            }
        }

        Ok(Self { conn: Mutex::new(conn) })
    }

    fn backup_before_migrate(path: &Path, from_version: i32) {
        if !path.exists() {
            return;
        }
        let backup = path.with_extension(format!(
            "db.bak-v{}-{}",
            from_version,
            chrono::Utc::now().format("%Y%m%d%H%M%S")
        ));
        if let Err(e) = std::fs::copy(path, &backup) {
            log::warn!("迁移前备份失败（继续迁移）: {e}");
        }
    }

    /// 在独占连接上执行一段数据库操作。
    pub fn with<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    ) -> Result<T, rusqlite::Error> {
        let guard = self.conn.lock().map_err(|_| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                Some("数据库连接互斥锁已损坏".into()),
            )
        })?;
        f(&guard)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "glance-db-{tag}-{}.sqlite",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn migrations_create_core_tables() {
        let path = temp_db("migrate");
        let db = Database::open(&path).unwrap();
        let version: i32 = db
            .with(|c| c.query_row("PRAGMA user_version", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let tables: Vec<String> = db
            .with(|c| {
                let mut stmt = c.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                )?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .unwrap();
        for expected in [
            "connection_profiles",
            "device_identities",
            "profile_identity_bindings",
            "remote_environments",
            "workspaces",
            "remote_file_metadata",
            "remote_cache_entries",
            "recent_resources",
            "ui_state",
            "task_history",
        ] {
            assert!(tables.contains(&expected.to_string()), "缺少表 {expected}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn fingerprint_unique_enforced() {
        let path = temp_db("unique");
        let db = Database::open(&path).unwrap();
        let insert = |fp: &str| {
            db.with(|c| {
                c.execute(
                    "INSERT INTO device_identities (id, key_algorithm, public_key_blob, fingerprint, first_seen_at)
                     VALUES (?1, 'ssh-ed25519', x'00', ?2, 0)",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(), fp],
                )
            })
        };
        insert("SHA256:aaa").unwrap();
        assert!(insert("SHA256:aaa").is_err(), "重复指纹应被 UNIQUE 约束拒绝");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn migration_v2_adds_key_path_column() {
        // 先建 v1 库（直接跑 MIGRATION_V1），再打开验证自动迁移到 v2
        let path = temp_db("v2migration");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        let db = Database::open(&path).unwrap();
        let version: i32 = db
            .with(|c| c.query_row("PRAGMA user_version", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(version, 2);
        let has_column: bool = db
            .with(|c| {
                let mut stmt = c.prepare("PRAGMA table_info(connection_profiles)")?;
                let names = stmt
                    .query_map([], |r| r.get::<_, String>(1))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(names.iter().any(|n| n == "key_path"))
            })
            .unwrap();
        assert!(has_column, "v2 应新增 key_path 列");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn binding_cascade_on_profile_delete() {
        let path = temp_db("cascade");
        let db = Database::open(&path).unwrap();
        db.with(|c| {
            c.execute(
                "INSERT INTO connection_profiles (id, name, host, port, username, auth_method, created_at, updated_at)
                 VALUES ('p1','测试','192.168.1.100',22,'pi','password',0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO device_identities (id, key_algorithm, public_key_blob, fingerprint, first_seen_at)
                 VALUES ('d1','ssh-ed25519', x'00', 'SHA256:bbb', 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO profile_identity_bindings (profile_id, device_identity_id, approved_at)
                 VALUES ('p1','d1',0)",
                [],
            )?;
            c.execute("DELETE FROM connection_profiles WHERE id='p1'", [])?;
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM profile_identity_bindings WHERE profile_id='p1'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(n, 0, "删除 Profile 后绑定应级联删除");
            Ok(())
        })
        .unwrap();
        let _ = std::fs::remove_file(&path);
    }
}
