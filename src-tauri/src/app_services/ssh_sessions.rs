//! 运行时 SSH 会话管理（路线图 §11.4）：
//! 每个会话绑定 profile_id + device_identity_id + endpoint + session_id。
//! 权威连接状态在 Rust 侧；前端仅持有会话列表视图。
//!
//! handle 与 SFTP 槽位均用 tokio::sync::Mutex：需要持锁跨 await，
//! std MutexGuard 非 Send 会污染 async command 的 Future。

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::filesystem::sftp::SftpFileSystem;
use crate::ssh::client::{ClientHandler, SshHandle};
use russh_sftp::client::SftpSession;

pub struct SessionEntry {
    pub session_id: Uuid,
    pub profile_id: Uuid,
    pub device_identity_id: Uuid,
    pub device_name: Option<String>,
    pub endpoint: String,
    pub connected_at: i64,
    pub(crate) handle: AsyncMutex<SshHandle<ClientHandler>>,
    /// 懒初始化的 SFTP Provider（一个会话一个 SFTP Channel，§4.8）
    sftp: AsyncMutex<Option<Arc<SftpFileSystem>>>,
}

impl SessionEntry {
    /// 获取（或创建）本会话的 SFTP Provider。
    pub async fn ensure_sftp(&self) -> Result<Arc<SftpFileSystem>, String> {
        let mut slot = self.sftp.lock().await;
        if let Some(existing) = slot.as_ref() {
            return Ok(existing.clone());
        }
        let handle = self.handle.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("请求 sftp subsystem 失败: {e}"))?;
        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("SFTP 初始化失败: {e}"))?;
        let provider = Arc::new(SftpFileSystem::new(session));
        *slot = Some(provider.clone());
        Ok(provider)
    }

    /// 传输是否仍存活（僵尸会话判定：对端关闭/网络中断后 handle 置 closed）
    pub async fn is_alive(&self) -> bool {
        !self.handle.lock().await.is_closed()
    }
}

#[derive(Default)]
pub struct SessionManager {
    sessions: StdMutex<HashMap<Uuid, Arc<SessionEntry>>>,
}

impl SessionManager {
    #[allow(clippy::too_many_arguments)]
    pub fn insert(
        &self,
        session_id: Uuid,
        profile_id: Uuid,
        device_identity_id: Uuid,
        device_name: Option<String>,
        endpoint: String,
        connected_at: i64,
        handle: SshHandle<ClientHandler>,
    ) -> Arc<SessionEntry> {
        let entry = Arc::new(SessionEntry {
            session_id,
            profile_id,
            device_identity_id,
            device_name,
            endpoint,
            connected_at,
            handle: AsyncMutex::new(handle),
            sftp: AsyncMutex::new(None),
        });
        self.sessions.lock().unwrap().insert(session_id, entry.clone());
        entry
    }

    pub fn get(&self, session_id: &Uuid) -> Option<Arc<SessionEntry>> {
        self.sessions.lock().unwrap().get(session_id).cloned()
    }

    /// 清理传输已断开的僵尸会话（设备重启/网络切换后 handle 置 closed）。
    /// 返回被移除的会话 id。会话条目此前永不回收，导致文件操作路由到死会话。
    pub async fn prune_dead(&self) -> Vec<Uuid> {
        let entries = self.list();
        let mut dead = Vec::new();
        for e in entries {
            let closed = e.handle.lock().await.is_closed();
            if closed {
                dead.push(e.session_id);
            }
        }
        if !dead.is_empty() {
            let mut guard = self.sessions.lock().unwrap();
            for id in &dead {
                guard.remove(id);
            }
        }
        dead
    }

    /// 按设备身份查找活跃会话（远程文件操作以 device_identity_id 路由，§9.3）。
    /// 先清理僵尸会话，再取**最新**一条——同设备多会话时 HashMap 遍历序随机，
    /// 旧死会话可能被选中导致文件操作全部失败。
    pub async fn find_by_device(&self, device_identity_id: &Uuid) -> Option<Arc<SessionEntry>> {
        self.prune_dead().await;
        let guard = self.sessions.lock().unwrap();
        guard
            .values()
            .filter(|e| e.device_identity_id == *device_identity_id)
            .max_by_key(|e| e.connected_at)
            .cloned()
    }

    /// 断开并移除某连接配置下的全部会话（connect_profile 替换语义：
    /// 新握手成功后清旧会话，避免僵尸堆积与随机路由）。
    pub async fn disconnect_profile_sessions(&self, profile_id: &Uuid) -> Vec<Uuid> {
        let ids: Vec<Uuid> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.profile_id == *profile_id)
            .map(|e| e.session_id)
            .collect();
        for id in &ids {
            self.disconnect(id).await;
        }
        ids
    }

    /// 仅关闭传输、不移除条目（模拟对端断开/网络中断形成的僵尸会话；
    /// prune_dead 应当回收它）。
    pub async fn drop_transport(&self, session_id: &Uuid) -> bool {
        let Some(entry) = self.get(session_id) else {
            return false;
        };
        let handle = entry.handle.lock().await;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "transport dropped", "en")
            .await;
        true
    }

    pub fn list(&self) -> Vec<Arc<SessionEntry>> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    /// 断开并移除会话。返回是否存在该会话。
    pub async fn disconnect(&self, session_id: &Uuid) -> bool {
        let entry = {
            let mut guard = self.sessions.lock().unwrap();
            guard.remove(session_id)
        };
        let Some(entry) = entry else {
            return false;
        };
        // SFTP Channel 随 transport 断开一起回收
        *entry.sftp.lock().await = None;
        let handle = entry.handle.lock().await;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "user disconnect", "en")
            .await;
        true
    }
}
