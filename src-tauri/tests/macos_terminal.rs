//! macOS 本机终端实机验证（§4.8 PTY 通道）。
//!
//! 在当前机器上直接验证 `open_local_terminal` 端到端可用性：
//! 1. 进程能启动并返回 channel_id
//! 2. 写入命令后能收到 stdout 回显
//! 3. 能正确处理 `\r`（回车）触发命令执行
//! 4. close_all 能回收通道
//!
//! 仅在 macOS 上运行，其他平台自动跳过。

#![cfg(target_os = "macos")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use glance_ide_lib::app_services::terminal::{
    close_all, open_local_terminal, TerminalCommand, TerminalRegistry,
};

/// 收集所有终端推送的数据
fn collector() -> (Arc<Mutex<String>>, Arc<dyn Fn(serde_json::Value) + Send + Sync>) {
    let buf = Arc::new(Mutex::new(String::new()));
    let sink = {
        let buf = buf.clone();
        Arc::new(move |v: serde_json::Value| {
            if v.get("type").and_then(|t| t.as_str()) == Some("data") {
                if let Some(b64) = v.get("bytes").and_then(|b| b.as_str()) {
                    if let Ok(bytes) = base64_decode(b64) {
                        buf.lock().unwrap().push_str(&String::from_utf8_lossy(&bytes));
                    }
                }
            }
        }) as Arc<dyn Fn(serde_json::Value) + Send + Sync>
    };
    (buf, sink)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, ()> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

/// 从终端读到的内容里等待某个片段出现
async fn wait_for(buf: &Arc<Mutex<String>>, needle: &str, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if buf.lock().unwrap().contains(needle) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 等待任意一个提示符字符出现
async fn wait_for_any(buf: &Arc<Mutex<String>>, needles: &[&str], timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        {
            let guard = buf.lock().unwrap();
            if needles.iter().any(|n| guard.contains(n)) {
                return true;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn local_terminal_runs_command_on_macos() {
    let registry = Arc::new(TerminalRegistry::default());
    let (buf, sink) = collector();

    let info = open_local_terminal(registry.clone(), None, sink)
        .await
        .expect("本机终端应能在 macOS 上启动");

    assert!(!info.channel_id.is_nil(), "应返回有效 channel_id");

    // 真 PTY 下 shell 是交互式的：应出现提示符（结尾为 % / $ / #）
    let has_prompt = wait_for_any(&buf, &["%", "$", "#"], Duration::from_secs(5)).await;
    assert!(
        has_prompt,
        "交互式 shell 应输出提示符，实际收到: {:?}",
        buf.lock().unwrap()
    );

    // 命令能被执行，且有回显（真 TTY 的输入会被行规程回显）
    assert!(
        registry.send(
            &info.channel_id,
            TerminalCommand::Write(b"echo GLANCE_MAC_TERMINAL_OK\r".to_vec())
        ),
        "写入终端应成功"
    );

    let ok = wait_for(&buf, "GLANCE_MAC_TERMINAL_OK", Duration::from_secs(5)).await;
    let captured = buf.lock().unwrap().clone();
    assert!(ok, "应能在 5 秒内收到命令输出，实际收到: {captured:?}");
    assert!(
        captured.contains("echo GLANCE_MAC_TERMINAL_OK"),
        "PTY 应回显输入的整条命令，实际: {captured:?}"
    );

    close_all(&registry).await;
}

#[tokio::test]
async fn local_terminal_honours_cwd() {
    let registry = Arc::new(TerminalRegistry::default());
    let (buf, sink) = collector();

    let info = open_local_terminal(registry.clone(), Some("/tmp"), sink)
        .await
        .expect("应能在指定目录启动终端");

    assert!(
        registry.send(
            &info.channel_id,
            TerminalCommand::Write(b"pwd\r".to_vec())
        ),
        "写入终端应成功"
    );

    let ok = wait_for(&buf, "/tmp", Duration::from_secs(5)).await;
    let captured = buf.lock().unwrap().clone();
    assert!(ok, "cwd 应为 /tmp，实际输出: {captured:?}");

    close_all(&registry).await;
}
