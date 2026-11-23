//! 运行时 SSH 会话管理：
//! 每个会话绑定 profile_id + device_identity_id + endpoint + session_id。
//! 权威连接状态在 Rust 侧；前端仅持有会话列表视图。
//!
//! handle 与 SFTP 槽位均用 tokio::sync::Mutex：需要持锁跨 await，
//! std MutexGuard 非 Send 会污染 async command 的 Future。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{oneshot, Mutex as AsyncMutex, Notify};
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
    /// 懒初始化的 SFTP Provider（一个会话一个 SFTP Channel）
    sftp: AsyncMutex<Option<Arc<SftpFileSystem>>>,
    /// 供 find_by_device / list_sessions 在发现僵尸连接时立即唤醒 watchdog
    check_notify: Arc<Notify>,
}

impl SessionEntry {
    pub fn check_notify(&self) -> Arc<Notify> {
        self.check_notify.clone()
    }

    pub fn trigger_check(&self) {
        self.check_notify.notify_waiters();
    }

    /// 清除缓存的 SFTP Provider（传输异常断开时触发重建）
    pub async fn invalidate_sftp(&self) {
        *self.sftp.lock().await = None;
    }

    /// 获取（或创建）本会话的 SFTP Provider。
    pub async fn ensure_sftp(&self) -> Result<Arc<SftpFileSystem>, String> {
        let mut slot = self.sftp.lock().await;
        if let Some(existing) = slot.as_ref() {
            if self.is_alive().await {
                return Ok(existing.clone());
            }
            *slot = None;
            self.trigger_check();
            return Err("SSH 连接已断开，请重新连接".into());
        }
        let channel = {
            let handle = self.handle.lock().await;
            if handle.is_closed() {
                self.trigger_check();
                return Err("SSH 连接已断开，请重新连接".into());
            }
            let ch = tokio::time::timeout(
                std::time::Duration::from_secs(15),
                handle.channel_open_session(),
            )
            .await
            .map_err(|_| "打开 SFTP 通道超时 (15s)".to_string())?
            .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
            tokio::time::timeout(
                std::time::Duration::from_secs(15),
                ch.request_subsystem(true, "sftp"),
            )
            .await
            .map_err(|_| "请求 sftp subsystem 超时 (15s)".to_string())?
            .map_err(|e| format!("请求 sftp subsystem 失败: {e}"))?;
            ch
        };
        let session = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            SftpSession::new(channel.into_stream()),
        )
        .await
        .map_err(|_| "SFTP 初始化超时 (15s)".to_string())?
        .map_err(|e| format!("SFTP 初始化失败: {e}"))?;
        let provider = Arc::new(SftpFileSystem::new(session));
        *slot = Some(provider.clone());
        Ok(provider)
    }

    /// 为文件传输打开独立的 SFTP 会话通道（与目录/编辑器通道隔离，避免大文件传输阻塞界面）。
    pub async fn open_transfer_sftp(&self) -> Result<SftpSession, String> {
        let handle = self.handle.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开传输 SFTP 通道失败: {e}"))?;
        drop(handle);
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("请求传输 sftp subsystem 失败: {e}"))?;
        let config = russh_sftp::client::Config {
            request_timeout_secs: 60,
            max_concurrent_reads: 64,
            max_concurrent_writes: 64,
            ..Default::default()
        };
        SftpSession::new_with_config(channel.into_stream(), config)
            .await
            .map_err(|e| format!("传输 SFTP 初始化失败: {e}"))
    }

    /// 传输是否仍存活（僵尸会话判定：对端关闭/网络中断后 handle 置 closed）
    pub async fn is_alive(&self) -> bool {
        !self.handle.lock().await.is_closed()
    }
}

#[derive(Default, Clone)]
pub struct SessionManager {
    sessions: Arc<StdMutex<HashMap<Uuid, Arc<SessionEntry>>>>,
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
            check_notify: Arc::new(Notify::new()),
        });
        self.sessions.lock().unwrap().insert(session_id, entry.clone());
        entry
    }

    pub fn get(&self, session_id: &Uuid) -> Option<Arc<SessionEntry>> {
        self.sessions.lock().unwrap().get(session_id).cloned()
    }

    /// 清理传输已断开的僵尸会话（供测试及显式维护使用）。
    /// 返回被移除的会话 id。
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

    /// 列出所有当前传输仍存活的会话（遇到僵尸条目则唤醒 watchdog 回收，而不直接静默删掉导致漏报掉线弹窗）。
    pub async fn list_alive(&self) -> Vec<Arc<SessionEntry>> {
        let entries = self.list();
        let mut alive = Vec::with_capacity(entries.len());
        for entry in entries {
            if entry.is_alive().await {
                alive.push(entry);
            } else {
                entry.trigger_check();
            }
        }
        alive
    }

    /// 按设备身份查找活跃会话（远程文件操作以 device_identity_id 路由）。
    /// 按连接时间倒序优先返回最新存活会话；不在此处删表项，以免抢在 watchdog 之前吞掉 `ssh:session-lost` 事件。
    pub async fn find_by_device(&self, device_identity_id: &Uuid) -> Option<Arc<SessionEntry>> {
        let mut candidates: Vec<Arc<SessionEntry>> = {
            let guard = self.sessions.lock().unwrap();
            guard
                .values()
                .filter(|e| e.device_identity_id == *device_identity_id)
                .cloned()
                .collect()
        };
        candidates.sort_by(|a, b| b.connected_at.cmp(&a.connected_at));
        for entry in candidates {
            if entry.is_alive().await {
                return Some(entry);
            }
            entry.trigger_check();
        }
        None
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

const MAX_RECENTLY_CANCELLED: usize = 32;

#[derive(Default)]
struct PendingConnectInner {
    active: HashMap<String, oneshot::Sender<()>>,
    recently_cancelled: VecDeque<String>,
}

/// 待完成 SSH 连接尝试注册表：支持前端打开本地文件/文件夹时立即取消握手，
/// 并在前端先于后端注册到达取消请求时通过有界 `recently_cancelled` 捕获竞态。
#[derive(Default)]
pub struct PendingConnectRegistry {
    inner: StdMutex<PendingConnectInner>,
}

pub struct ConnectAttemptGuard {
    registry: Arc<PendingConnectRegistry>,
    attempt_id: String,
}

impl Drop for ConnectAttemptGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.registry.inner.lock() {
            guard.active.remove(&self.attempt_id);
        }
    }
}

impl PendingConnectRegistry {
    pub fn register(
        self: &Arc<Self>,
        attempt_id: String,
    ) -> Option<(oneshot::Receiver<()>, ConnectAttemptGuard)> {
        let mut guard = self.inner.lock().unwrap();
        if let Some(pos) = guard.recently_cancelled.iter().position(|id| id == &attempt_id) {
            guard.recently_cancelled.remove(pos);
            return None;
        }
        let (tx, rx) = oneshot::channel();
        guard.active.insert(attempt_id.clone(), tx);
        let attempt_guard = ConnectAttemptGuard {
            registry: self.clone(),
            attempt_id,
        };
        Some((rx, attempt_guard))
    }

    pub fn cancel(&self, attempt_id: &str) -> bool {
        let sender = {
            let mut guard = self.inner.lock().unwrap();
            if let Some(tx) = guard.active.remove(attempt_id) {
                Some(tx)
            } else {
                if !guard.recently_cancelled.iter().any(|id| id == attempt_id) {
                    if guard.recently_cancelled.len() >= MAX_RECENTLY_CANCELLED {
                        guard.recently_cancelled.pop_front();
                    }
                    guard.recently_cancelled.push_back(attempt_id.to_string());
                }
                None
            }
        };
        if let Some(tx) = sender {
            let _ = tx.send(());
            true
        } else {
            false
        }
    }

    pub fn cancel_all(&self) {
        let senders: Vec<oneshot::Sender<()>> = {
            let mut guard = self.inner.lock().unwrap();
            guard.active.drain().map(|(_, tx)| tx).collect()
        };
        for tx in senders {
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_cancel_wakes_receiver_and_returns_true() {
        let reg = Arc::new(PendingConnectRegistry::default());
        let (mut rx, _guard) = reg.register("a1".into()).expect("should register");
        assert!(reg.cancel("a1"));
        assert_eq!(rx.try_recv(), Ok(()));
        assert!(!reg.cancel("a1"));
    }

    #[test]
    fn pre_cancel_causes_register_to_return_none() {
        let reg = Arc::new(PendingConnectRegistry::default());
        assert!(!reg.cancel("early-1"));
        assert!(reg.register("early-1".into()).is_none());
        // 第二次同 ID 注册不应被旧的 pre-cancel 重复消费
        assert!(reg.register("early-1".into()).is_some());
    }

    #[test]
    fn guard_drop_cleans_up_active_entry() {
        let reg = Arc::new(PendingConnectRegistry::default());
        {
            let (_rx, _guard) = reg.register("drop-1".into()).expect("should register");
            assert!(reg.inner.lock().unwrap().active.contains_key("drop-1"));
        }
        assert!(!reg.inner.lock().unwrap().active.contains_key("drop-1"));
        assert!(!reg.cancel("drop-1"));
    }

    #[test]
    fn cancel_all_wakes_all_registered_waiters() {
        let reg = Arc::new(PendingConnectRegistry::default());
        let (mut rx1, _g1) = reg.register("k1".into()).unwrap();
        let (mut rx2, _g2) = reg.register("k2".into()).unwrap();
        reg.cancel_all();
        assert_eq!(rx1.try_recv(), Ok(()));
        assert_eq!(rx2.try_recv(), Ok(()));
        assert!(reg.inner.lock().unwrap().active.is_empty());
    }
}
