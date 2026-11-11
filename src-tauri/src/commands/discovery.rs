//! 局域网发现 Commands（M5）。
//! 扫描结果经 Channel 实时推送；扫描不建立信任、不认证。
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
    pub is_virtual: bool,
}

/// 判断 IP 是否属于回环、链路本地、代理 TUN 专用网段或 CGNAT 网段
pub fn is_virtual_or_proxy_ip(ip: std::net::Ipv4Addr) -> bool {
    let oct = ip.octets();
    // 回环地址 127.0.0.0/8
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    // 自动私有 IP (APIPA) / 链路本地 169.254.0.0/16 (网卡未连接物理网络或 DHCP 失败)
    if ip.is_link_local() || (oct[0] == 169 && oct[1] == 254) {
        return true;
    }
    // RFC 2544 基准测试专用网段 198.18.0.0/15 (198.18.0.0 ~ 198.19.255.255)
    // 被 Clash / Mihomo / Sing-box / Xray 等代理软件的 TUN 模式作为标准虚拟 IP
    if oct[0] == 198 && (oct[1] == 18 || oct[1] == 19) {
        return true;
    }
    // 运营商级 NAT (CGNAT) 100.64.0.0/10 (Tailscale / VPN 等使用)
    if oct[0] == 100 && (oct[1] >= 64 && oct[1] <= 127) {
        return true;
    }
    // 文档测试网段
    if (oct[0] == 192 && oct[1] == 0 && oct[2] == 2)
        || (oct[0] == 198 && oct[1] == 51 && oct[2] == 100)
        || (oct[0] == 203 && oct[1] == 0 && oct[2] == 113)
    {
        return true;
    }
    false
}

/// 判断网卡名称是否属于虚拟机、代理、容器、蓝牙等虚拟设备
pub fn is_virtual_or_proxy_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    let keywords = [
        "vmnet", "vmware", "virtualbox", "vbox", "vethernet", "hyper-v",
        "wsl", "docker", "container", "cni", "flannel",
        "tun", "tap", "wintun", "meta", "clash", "sing-box", "mihomo", "v2ray", "xray",
        "tailscale", "zerotier", "wireguard", "openvpn", "nord", "proton", "anyconnect", "fortinet",
        "bluetooth", "蓝牙", "pseudo", "loopback", "teredo", "isatap", "wan miniport",
    ];
    keywords.iter().any(|&kw| lower.contains(kw))
}

#[cfg(windows)]
fn get_windows_physical_default_route() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("route");
    cmd.args(["print", "0.0.0.0"]);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut candidate_interfaces: Vec<(String, u32)> = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 && parts[0] == "0.0.0.0" && parts[1] == "0.0.0.0" {
            let gateway = parts[2];
            let iface_ip = parts[3];
            let metric: u32 = parts[4].parse().unwrap_or(9999);

            if let Ok(ip) = iface_ip.parse::<std::net::Ipv4Addr>() {
                if !is_virtual_or_proxy_ip(ip) {
                    if let Ok(gw_ip) = gateway.parse::<std::net::Ipv4Addr>() {
                        if !is_virtual_or_proxy_ip(gw_ip) {
                            candidate_interfaces.push((iface_ip.to_string(), metric));
                        }
                    }
                }
            }
        }
    }
    candidate_interfaces.sort_by_key(|(_, m)| *m);
    candidate_interfaces.into_iter().map(|(ip, _)| ip).next()
}

/// 枚举本机 IPv4 网卡并推算建议扫描范围（第 1 步：用户确认后才开始）
#[tauri::command]
pub fn discovery_interfaces() -> Vec<InterfaceInfo> {
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if let if_addrs::IfAddr::V4(v4) = iface.addr {
                let ip = v4.ip;
                if is_virtual_or_proxy_ip(ip) {
                    continue;
                }
                let net = u32::from(ip) & 0xFFFF_FF00;
                let cidr = format!("{}/24", std::net::Ipv4Addr::from(net));
                let is_virt = is_virtual_or_proxy_name(&iface.name);
                let key = (iface.name.clone(), cidr.clone());
                if seen.insert(key) {
                    result.push(InterfaceInfo {
                        name: iface.name,
                        ipv4: ip.to_string(),
                        suggested_cidr: cidr,
                        is_virtual: is_virt,
                    });
                }
            }
        }
    }
    // 物理真实网卡排在最前（按权重降序排列）
    result.sort_by_key(|i| {
        let mut score = 0i32;
        if i.is_virtual {
            score -= 1000;
        } else {
            score += 100;
            let lower = i.name.to_lowercase();
            if lower.contains("wlan") || lower.contains("wi-fi") || lower.contains("wifi") || lower.contains("无线") {
                score += 50;
            } else if lower.contains("以太网") || lower.contains("ethernet") || lower.contains("lan") || lower.contains("本地连接") {
                score += 40;
            }
        }
        -score
    });
    result
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultRouteInfo {
    /// 默认出站 IPv4（优先物理默认网关，自动剔除 TUN/代理/虚拟机）
    pub local_ip: Option<String>,
}

#[tauri::command]
pub fn discovery_default_route() -> DefaultRouteInfo {
    #[cfg(windows)]
    if let Some(ip) = get_windows_physical_default_route() {
        return DefaultRouteInfo { local_ip: Some(ip) };
    }

    // 跨平台备选：UDP 探测出站网卡，但必须剔除代理和虚拟 IP
    let local_ip = (|| -> Option<String> {
        let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
        socket.connect("223.5.5.5:80").ok()?;
        let ip = match socket.local_addr().ok()?.ip() {
            std::net::IpAddr::V4(v4) => v4,
            _ => return None,
        };
        if !is_virtual_or_proxy_ip(ip) {
            Some(ip.to_string())
        } else {
            None
        }
    })();

    // 二级备选：从已排除虚拟网卡的物理网卡列表中取首个 IP
    let local_ip = local_ip.or_else(|| {
        discovery_interfaces()
            .into_iter()
            .find(|i| !i.is_virtual)
            .map(|i| i.ipv4)
    });

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn test_is_virtual_or_proxy_ip() {
        assert!(is_virtual_or_proxy_ip(std::net::Ipv4Addr::from_str("127.0.0.1").unwrap()));
        assert!(is_virtual_or_proxy_ip(std::net::Ipv4Addr::from_str("169.254.106.168").unwrap()));
        assert!(is_virtual_or_proxy_ip(std::net::Ipv4Addr::from_str("198.18.0.1").unwrap()));
        assert!(is_virtual_or_proxy_ip(std::net::Ipv4Addr::from_str("198.19.255.1").unwrap()));
        assert!(is_virtual_or_proxy_ip(std::net::Ipv4Addr::from_str("100.64.0.1").unwrap()));
        assert!(is_virtual_or_proxy_ip(std::net::Ipv4Addr::from_str("0.0.0.0").unwrap()));

        // 真实物理局域网 IP
        assert!(!is_virtual_or_proxy_ip(std::net::Ipv4Addr::from_str("192.168.1.195").unwrap()));
        assert!(!is_virtual_or_proxy_ip(std::net::Ipv4Addr::from_str("192.168.0.1").unwrap()));
        assert!(!is_virtual_or_proxy_ip(std::net::Ipv4Addr::from_str("10.0.0.1").unwrap()));
        assert!(!is_virtual_or_proxy_ip(std::net::Ipv4Addr::from_str("172.20.10.2").unwrap()));
    }

    #[test]
    fn test_is_virtual_or_proxy_name() {
        assert!(is_virtual_or_proxy_name("Meta"));
        assert!(is_virtual_or_proxy_name("Meta Tunnel"));
        assert!(is_virtual_or_proxy_name("VMware Network Adapter VMnet1"));
        assert!(is_virtual_or_proxy_name("VMware Network Adapter VMnet8"));
        assert!(is_virtual_or_proxy_name("vEthernet (WSL)"));
        assert!(is_virtual_or_proxy_name("vEthernet (Default Switch)"));
        assert!(is_virtual_or_proxy_name("蓝牙网络连接 2"));
        assert!(is_virtual_or_proxy_name("Tailscale"));
        assert!(is_virtual_or_proxy_name("wintun"));

        // 物理网卡名称
        assert!(!is_virtual_or_proxy_name("WLAN"));
        assert!(!is_virtual_or_proxy_name("以太网"));
        assert!(!is_virtual_or_proxy_name("Wi-Fi"));
        assert!(!is_virtual_or_proxy_name("Ethernet"));
        assert!(!is_virtual_or_proxy_name("Intel(R) Wireless-AC 9461"));
        assert!(!is_virtual_or_proxy_name("Realtek Gaming 2.5GbE Family Controller"));
    }
}
