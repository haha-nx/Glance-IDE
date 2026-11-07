//! 秘密存储抽象（路线图 §9.2）。
//! SQLite 只存 credential_ref，明文密码/私钥口令进入 OS 凭据库：
//! macOS Keychain / Windows Credential Manager（§10.1）。
//! 本模块在 M2 由 ConnectionProfileManager 调用；先落地实现以提前验证 keyring 兼容性。

use keyring::Entry;

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("凭据服务错误: {0}")]
    Backend(String),
}

impl From<keyring::Error> for SecretError {
    fn from(e: keyring::Error) -> Self {
        SecretError::Backend(e.to_string())
    }
}

pub trait SecretStore: Send + Sync {
    fn set_secret(&self, ref_name: &str, secret: &str) -> Result<(), SecretError>;
    fn get_secret(&self, ref_name: &str) -> Result<Option<String>, SecretError>;
    fn delete_secret(&self, ref_name: &str) -> Result<(), SecretError>;
}

/// 基于 keyring crate 的跨平台实现。
/// credential_ref 形如 `glance://<profile-id>`；service 固定，user 存引用名。
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new("com.glance.ide")
    }
}

impl SecretStore for KeyringStore {
    fn set_secret(&self, ref_name: &str, secret: &str) -> Result<(), SecretError> {
        let entry = Entry::new(&self.service, ref_name)?;
        entry.set_password(secret)?;
        Ok(())
    }

    fn get_secret(&self, ref_name: &str) -> Result<Option<String>, SecretError> {
        let entry = Entry::new(&self.service, ref_name)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn delete_secret(&self, ref_name: &str) -> Result<(), SecretError> {
        let entry = Entry::new(&self.service, ref_name)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
