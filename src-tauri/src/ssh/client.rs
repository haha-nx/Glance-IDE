//! russh 客户端集成（路线图 M2 任务 2.4/2.5）。
//!
//! 连接编排（§4.4 流程）：
//! 1. TCP + SSH 握手；`check_server_key` 中取得服务器 Host Key
//! 2. 计算指纹 → 与 Profile 设备池匹配；未命中 → 拒绝该密钥（握手终止），
//!    返回 UnknownIdentity / IdentityChanged（§11.2 ConnectOutcome 三态）
//! 3. 命中 → 用户认证（密码 / 私钥）→ 会话建立
//!
//! 该模块不含数据库与 UI 依赖，可独立用于互操作测试。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyBase64};
use uuid::Uuid;

use super::device_pool::{match_fingerprint, TrustedDevice};
use super::host_key_verifier::fingerprint_from_blob;

pub use russh::client::Handle as SshHandle;

/// 连接与握手超时（M2 初始值，后续按实测网络调整，§8.3）
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct ObservedServerKey {
    pub algorithm: String,
    /// 已规范化的 SHA256 指纹（SHA256:<unpadded>）
    pub fingerprint: String,
    /// 服务器公钥 wire blob（用于 device_identities.public_key_blob 持久化）
    pub blob: Vec<u8>,
}

type ObservedSlot = Arc<StdMutex<Option<ObservedServerKey>>>;

/// SSH 客户端 Handler：唯一职责是记录观测到的服务器密钥并按设备池决策放行。
pub struct ClientHandler {
    trusted: Arc<HashSet<String>>,
    observed: ObservedSlot,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        let blob = key.public_key_bytes();
        // blob 指纹与 OpenSSH `ssh-keygen -lf` 一致（§4.3 fingerprint_sha256）
        let Ok(fingerprint) = fingerprint_from_blob(&blob) else {
            return Err(russh::Error::UnknownKey);
        };
        *self.observed.lock().unwrap() = Some(ObservedServerKey {
            algorithm: key.algorithm().to_string(),
            fingerprint: fingerprint.clone(),
            blob,
        });
        Ok(self.trusted.contains(&fingerprint))
    }
}

#[derive(Debug, Clone)]
pub enum AuthKind {
    Password(String),
    PrivateKey { key_path: PathBuf, passphrase: Option<String> },
}

pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthKind,
    /// 当前 Profile 的已授权设备池（已规范化的指纹）
    pub pool: Vec<TrustedDevice>,
}

pub enum ConnectStep {
    Connected {
        handle: Handle<ClientHandler>,
        device_identity_id: Uuid,
        device_name: Option<String>,
    },
    /// 设备池为空时的首次新设备（§12.2「A 首次登记」）
    UnknownIdentity { observed: ObservedServerKey },
    /// 设备池非空但指纹未命中：设备轮换未登记或密钥变化（§11.2 identityChanged）
    IdentityChanged {
        observed: ObservedServerKey,
        expected: Vec<String>,
    },
    AuthFailed { message: String },
    NetworkError { message: String },
}

/// 完整连接编排：握手 → 指纹判定 → 用户认证。
pub async fn connect_and_auth(params: ConnectParams) -> ConnectStep {
    let observed: ObservedSlot = Arc::new(StdMutex::new(None));
    let trusted: Arc<HashSet<String>> = Arc::new(
        params
            .pool
            .iter()
            .map(|d| d.fingerprint.clone())
            .collect(),
    );
    let pool_empty = params.pool.is_empty();
    let expected: Vec<String> = params.pool.iter().map(|d| d.fingerprint.clone()).collect();

    let handler = ClientHandler { trusted, observed: observed.clone() };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    let connect_fut = client::connect(config, (params.host.as_str(), params.port), handler);
    let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connect_fut).await {
        Err(_elapsed) => {
            return ConnectStep::NetworkError {
                message: format!("连接超时（{}秒）：{}", CONNECT_TIMEOUT.as_secs(), params.host),
            }
        }
        Ok(Err(e)) => {
            // 若 Host Key 已被观测到，说明握手进入过身份校验并被我们拒绝 → 身份流程而非网络错误
            if let Some(key) = observed.lock().unwrap().clone() {
                return if pool_empty {
                    ConnectStep::UnknownIdentity { observed: key }
                } else {
                    ConnectStep::IdentityChanged { observed: key, expected }
                };
            }
            let raw = e.to_string();
            let message = if raw.contains("No route to host") || raw.contains("os error 65") {
                format!(
                    "{raw} —— 可能被 macOS 本地网络权限拦截：系统设置 → 隐私与安全性 → 本地网络，允许 Glance IDE 后重试"
                )
            } else {
                raw
            };
            return ConnectStep::NetworkError { message };
        }
        Ok(Ok(h)) => h,
    };

    // 走到这里说明 check_server_key 放行 → 指纹必在池内；取回匹配的设备身份
    let matched = observed
        .lock()
        .unwrap()
        .clone()
        .and_then(|key| match match_fingerprint(&params.pool, &key.fingerprint) {
            super::device_pool::MatchOutcome::InPool { device_identity_id, display_name } => {
                Some((device_identity_id, Some(display_name)))
            }
            super::device_pool::MatchOutcome::NotInPool => None,
        });

    let Some((device_identity_id, device_name)) = matched else {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "identity mismatch", "en")
            .await;
        return ConnectStep::NetworkError {
            message: "内部状态错误：指纹匹配信息缺失".into(),
        };
    };

    match authenticate(&mut handle, &params.username, &params.auth).await {
        Ok(true) => ConnectStep::Connected { handle, device_identity_id, device_name },
        Ok(false) => ConnectStep::AuthFailed {
            message: "认证被服务器拒绝：用户名或凭据不正确".into(),
        },
        Err(e) => ConnectStep::AuthFailed { message: e },
    }
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    auth: &AuthKind,
) -> Result<bool, String> {
    match auth {
        AuthKind::Password(password) => handle
            .authenticate_password(username, password.clone())
            .await
            .map_err(|e| format!("认证过程出错: {e}"))
            .map(|r| r.success()),
        AuthKind::PrivateKey { key_path, passphrase } => {
            let key = russh::keys::load_secret_key(key_path, passphrase.as_deref())
                .map_err(|e| format!("读取私钥失败: {e}"))?;
            let with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle
                .authenticate_publickey(username, with_hash)
                .await
                .map_err(|e| format!("认证过程出错: {e}"))
                .map(|r| r.success())
        }
    }
}
