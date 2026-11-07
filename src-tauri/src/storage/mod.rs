//! SQLite 存储层（路线图 §9）。
//! schema_version 使用 PRAGMA user_version 管理，迁移前自动备份（§9.4）。

pub mod database;
pub mod secret_store;
