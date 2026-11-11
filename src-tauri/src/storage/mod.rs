//! SQLite 存储层。
//! schema_version 使用 PRAGMA user_version 管理，迁移前自动备份。

pub mod database;
pub mod secret_store;
