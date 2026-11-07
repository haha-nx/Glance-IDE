//! 局域网发现 Commands（M5）。
//! 扫描结果经 Channel 实时推送；扫描不建立信任、不认证（§8.2）。
//! 取消模型：每次扫描持有独立取消句柄，启动新扫描/显式取消时置位旧句柄。

use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use tauri::State;

use crate::app_services::discovery::{self, DiscoveryCandidate};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceInfo {
    pub name: String,
    pub ipv4: String,
    /// 建议扫描的 CIDR（/24）
    pub suggested_cidr: String,
}

/// 枚举本机 IPv4 网卡并推算建议扫描范围（§8.2 第 1 步：用户确认后才开始）
#[tauri::command]
pub fn discovery_interfaces() -> Vec<InterfaceInfo> {
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if let if_addrs::IfAddr::V4(v4) = iface.addr {
                let ip = v4.ip;
                if ip.is_loopback() || ip.is_unspecified() {
                    continue;
                }
                let net = u32::from(ip) & 0xFFFF_FF00;
                let cidr = format!("{}/24", std::net::Ipv4Addr::from(net));
                let key = (iface.name.clone(), cidr.clone());
                if seen.insert(key) {
                    result.push(InterfaceInfo {
                        name: iface.name,
                        ipv4: ip.to_string(),
                        suggested_cidr: cidr,
                    });
                }
            }
        }
    }
    result
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultRouteInfo {
    /// 默认出站 IPv4（UDP connect 技巧，无需真实连通；离线时可能为空）
    pub local_ip: Option<String>,
}

#[tauri::command]
pub fn discovery_default_route() -> DefaultRouteInfo {
    let local_ip = (|| -> Option<String> {
        let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
        socket.connect("8.8.8.8:80").ok()?;
        Some(socket.local_addr().ok()?.ip().to_string())
    })();
    DefaultRouteInfo { local_ip }
}

#[derive(Default)]
pub struct DiscoveryState {
    scan_cancel: StdMutex<Option<Arc<AtomicBool>>>,
    mdns_cancel: StdMutex<Option<Arc<AtomicBool>>>,
    dedup: Arc<StdMutex<std::collections::HashSet<String>>>,
}

fn dedup_key(c: &DiscoveryCandidate) -> String {
    format!("{}:{}:{}", c.ip, c.port, c.source)
}

fn cancel_previous(slot: &StdMutex<Option<Arc<AtomicBool>>>, new: Arc<AtomicBool>) {
    let mut guard = slot.lock().unwrap();
    if let Some(old) = guard.take() {
        old.store(true, Ordering::Relaxed);
    }
    *guard = Some(new);
}

#[tauri::command]
pub async fn discovery_scan(
    state: State<'_, DiscoveryState>,
    cidr: String,
    ports: Vec<u16>,
    on_result: tauri::ipc::Channel<DiscoveryCandidate>,
) -> Result<usize, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    cancel_previous(&state.scan_cancel, cancel.clone());
    state.dedup.lock().unwrap().clear();

    let dedup = state.dedup.clone();
    discovery::scan_cidr(&cidr, &ports, cancel, move |c| {
        let key = dedup_key(&c);
        let mut seen = dedup.lock().unwrap();
        if seen.insert(key) {
            let _ = on_result.send(c);
        }
    })
    .await
}

#[tauri::command]
pub async fn discovery_cancel(state: State<'_, DiscoveryState>) -> Result<(), String> {
    if let Some(c) = state.scan_cancel.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn discovery_mdns_start(
    state: State<'_, DiscoveryState>,
    on_result: tauri::ipc::Channel<DiscoveryCandidate>,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    cancel_previous(&state.mdns_cancel, cancel.clone());
    let dedup = state.dedup.clone();
    discovery::browse_mdns(cancel, move |c| {
        let key = dedup_key(&c);
        let mut seen = dedup.lock().unwrap();
        if seen.insert(key) {
            let _ = on_result.send(c);
        }
    })
    .await
}

#[tauri::command]
pub async fn discovery_mdns_cancel(state: State<'_, DiscoveryState>) -> Result<(), String> {
    if let Some(c) = state.mdns_cancel.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
    Ok(())
}
