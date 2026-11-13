//! 局域网设备发现。
//! 双通道：mDNS/DNS-SD + 受控 TCP 端口探测（并发上限、超时、可取消）。
//! 安全边界：扫描不输密码、不试默认账号、不建立信任；
//! 仅 TCP 可达 → 「端口开放，协议未确认」；读到 SSH banner 才标「确认 SSH」。

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

/// 扫描并发上限（初始值经实测确定，避免打满网络）
const SCAN_CONCURRENCY: usize = 128;
/// 单目标 TCP 连接超时
const TCP_TIMEOUT: Duration = Duration::from_millis(600);
/// SSH banner 读取超时
const BANNER_TIMEOUT: Duration = Duration::from_millis(1200);
/// banner 读取上限
const BANNER_MAX: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryCandidate {
    pub ip: String,
    pub port: u16,
    /// open（端口开放未确认）| ssh（已确认 SSH banner）
    pub kind: String,
    /// SSH banner（如 SSH-2.0-OpenSSH_9.6）
    pub banner: Option<String>,
    /// mDNS 主机名（来自 mDNS 通道时存在）
    pub hostname: Option<String>,
    pub source: String, // mdns | tcp
}

// ---------- CIDR ----------

/// 解析 IPv4 CIDR（如 192.168.1.0/24）→ (网络地址, 主机数)。
/// 非 /24 也支持；主机位全 0（网络地址）与全 1（广播）跳过。
pub fn parse_cidr(cidr: &str) -> Result<(Ipv4Addr, u32), String> {
    let (addr_part, len_part) = cidr
        .split_once('/')
        .ok_or_else(|| format!("CIDR 格式无效: {cidr}"))?;
    let addr: Ipv4Addr = addr_part
        .trim()
        .parse()
        .map_err(|e| format!("IP 无效: {e}"))?;
    let len: u32 = len_part
        .trim()
        .parse()
        .map_err(|e| format!("前缀长度无效: {e}"))?;
    if len > 32 {
        return Err(format!("前缀长度超出范围: {len}"));
    }
    Ok((addr, len))
}

/// 枚举 CIDR 内的主机地址（跳过网络地址与广播地址）。
pub fn cidr_hosts(cidr: &str) -> Result<Vec<Ipv4Addr>, String> {
    let (addr, len) = parse_cidr(cidr)?;
    let bits = u32::from(addr);
    let host_bits = 32 - len;
    let count = 1u64 << host_bits.min(16); // 上限保护：最多枚举 65536
    let mask = if host_bits == 0 {
        0u32
    } else if host_bits >= 32 {
        u32::MAX
    } else {
        (1u32 << host_bits) - 1
    };
    let network = bits & !mask;

    let mut hosts = Vec::new();
    for i in 0..count {
        if i == 0 && host_bits > 0 {
            continue; // 网络地址
        }
        if host_bits > 0 && i == count - 1 {
            continue; // 广播地址
        }
        if hosts.len() >= 65534 {
            break;
        }
        hosts.push(Ipv4Addr::from(network | (i as u32 & mask)));
    }
    Ok(hosts)
}

// ---------- TCP 探测 ----------

/// 读 SSH banner（带超时；非 SSH 服务返回 None）
async fn read_ssh_banner(addr: SocketAddr) -> Option<String> {
    let mut stream = tokio::time::timeout(TCP_TIMEOUT, tokio::net::TcpStream::connect(addr))
        .await
        .ok()?
        .ok()?;
    let mut buf = vec![0u8; BANNER_MAX];
    let n = tokio::time::timeout(BANNER_TIMEOUT, {
        use tokio::io::AsyncReadExt;
        stream.read(&mut buf)
    })
    .await
    .ok()?
    .ok()?;
    if n == 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
    if text.starts_with("SSH-") {
        Some(text.lines().next().unwrap_or("").to_string())
    } else {
        None
    }
}

/// TCP 连接探测（不开 banner）
async fn tcp_probe(addr: SocketAddr) -> bool {
    tokio::time::timeout(TCP_TIMEOUT, tokio::net::TcpStream::connect(addr))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
}

/// 扫描 CIDR 的指定端口。结果经 sink 实时推送；cancel 置 true 即中止。
pub async fn scan_cidr(
    cidr: &str,
    ports: &[u16],
    cancel: Arc<AtomicBool>,
    mut sink: impl FnMut(DiscoveryCandidate) + Send,
) -> Result<usize, String> {
    let hosts = cidr_hosts(cidr)?;
    let mut scanned: usize = 0;

    for chunk in hosts.chunks(SCAN_CONCURRENCY) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let mut joins = Vec::with_capacity(chunk.len() * ports.len());
        for host in chunk {
            for port in ports {
                let addr = SocketAddr::new((*host).into(), *port);
                joins.push(tokio::spawn(async move {
                    if !tcp_probe(addr).await {
                        return None;
                    }
                    // 端口开放：尝试识别 SSH banner
                    let banner = read_ssh_banner(addr).await;
                    let kind = if banner.is_some() { "ssh" } else { "open" };
                    Some(DiscoveryCandidate {
                        ip: addr.ip().to_string(),
                        port: addr.port(),
                        kind: kind.to_string(),
                        banner,
                        hostname: None,
                        source: "tcp".to_string(),
                    })
                }));
            }
        }
        for join in joins {
            if let Ok(Some(candidate)) = join.await {
                scanned += 1;
                sink(candidate);
            }
        }
    }
    Ok(scanned)
}

// ---------- mDNS ----------

/// mDNS 浏览 SSH 服务（_ssh._tcp.local.）。
/// 事件经 sink 推送；cancel 置 true 即及时响应停止并关闭 mDNS 守护。
pub async fn browse_mdns(
    cancel: Arc<AtomicBool>,
    mut sink: impl FnMut(DiscoveryCandidate) + Send,
) -> Result<(), String> {
    let mdns = mdns_sd::ServiceDaemon::new().map_err(|e| format!("mDNS 启动失败: {e}"))?;
    let receiver = mdns
        .browse("_ssh._tcp.local.")
        .map_err(|e| {
            let _ = mdns.shutdown();
            format!("mDNS 浏览失败: {e}")
        })?;

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(recv_res) = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            receiver.recv_async(),
        )
        .await
        else {
            continue;
        };
        let Ok(event) = recv_res else {
            break;
        };
        if let mdns_sd::ServiceEvent::ServiceResolved(info) = event {
            let resolved = info.as_resolved_service();
            let port = resolved.port;
            let hostname = resolved.host.clone();
            for ip in &resolved.addresses {
                if ip.is_ipv4() {
                    sink(DiscoveryCandidate {
                        ip: ip.to_string(),
                        port,
                        kind: "mdns".to_string(),
                        banner: None,
                        hostname: Some(hostname.clone()),
                        source: "mdns".to_string(),
                    });
                }
            }
        }
    }
    let _ = mdns.stop_browse("_ssh._tcp.local.");
    let _ = mdns.shutdown();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cidr_parsing_and_hosts() {
        assert!(parse_cidr("192.168.1.0/24").is_ok());
        assert!(parse_cidr("192.168.1.0").is_err());
        assert!(parse_cidr("10.0.0.0/33").is_err());
        assert!(parse_cidr("not-an-ip/24").is_err());

        let hosts = cidr_hosts("10.0.0.4/30").unwrap();
        // /30：4 个地址 - 网络 - 广播 = 2 个主机
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0], "10.0.0.5".parse::<Ipv4Addr>().unwrap());
        assert_eq!(hosts[1], "10.0.0.6".parse::<Ipv4Addr>().unwrap());
    }

    #[test]
    fn cidr_host_count_is_capped() {
        // 大网段不会生成爆炸列表（上限 65534）
        let hosts = cidr_hosts("10.0.0.0/8").unwrap();
        assert_eq!(hosts.len(), 65534);
    }

    #[test]
    fn cidr_zero_prefix_does_not_overflow() {
        let hosts = cidr_hosts("0.0.0.0/0").unwrap();
        assert_eq!(hosts.len(), 65534);
    }

    #[tokio::test]
    async fn scan_reports_ssh_banner_on_test_server() {
        // 若互操作测试服务器在跑，验证扫描能发现它并读出 banner
        let port: u16 = match std::env::var("GLANCE_SSH_TEST_PORT") {
            Ok(p) => p.parse().unwrap_or(0),
            Err(_) => return,
        };
        let candidates = Arc::new(std::sync::Mutex::new(Vec::new()));
        let cancel = Arc::new(AtomicBool::new(false));
        let cl = candidates.clone();
        // 只扫回环 /32 段内的 127.0.0.1
        let _ = scan_cidr("127.0.0.1/32", &[port], cancel, move |c| {
            cl.lock().unwrap().push(c);
        })
        .await;
        let found = candidates.lock().unwrap();
        assert!(
            found.iter().any(|c| c.port == port && c.kind == "ssh"),
            "应发现 SSH 服务: {found:?}"
        );
    }
}
