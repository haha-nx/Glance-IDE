//! Tauri Commands 薄层：只做输入校验与服务调用，不承载业务逻辑。

pub mod app;
pub mod discovery;
pub mod fs;
pub mod git;
pub mod lsp;
pub mod ssh;
pub mod terminal;
pub mod transfer;
pub mod updater;
pub mod workspace;
pub mod wsl;

/// 命令层错误（序列化为 { code, message }）
#[derive(Debug, thiserror::Error)]
pub enum CmdError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Storage(String),
    #[error("{0}")]
    Secret(String),
}

impl CmdError {
    pub fn validation(msg: impl Into<String>) -> Self {
        CmdError::Validation(msg.into())
    }

    pub fn secret(msg: impl Into<String>) -> Self {
        CmdError::Secret(msg.into())
    }

    pub fn code(&self) -> &'static str {
        match self {
            CmdError::Validation(_) => "validation",
            CmdError::Storage(_) => "storage",
            CmdError::Secret(_) => "secret",
        }
    }
}

impl serde::Serialize for CmdError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("CmdError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<rusqlite::Error> for CmdError {
    fn from(e: rusqlite::Error) -> Self {
        CmdError::Storage(e.to_string())
    }
}

impl From<crate::app_services::connection_profiles::RepoError> for CmdError {
    fn from(e: crate::app_services::connection_profiles::RepoError) -> Self {
        match e {
            crate::app_services::connection_profiles::RepoError::Db(db) => CmdError::Storage(db.to_string()),
            other => CmdError::Storage(other.to_string()),
        }
    }
}

impl From<crate::storage::secret_store::SecretError> for CmdError {
    fn from(e: crate::storage::secret_store::SecretError) -> Self {
        CmdError::Secret(e.to_string())
    }
}
