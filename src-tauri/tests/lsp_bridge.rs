//! M6 LSP 传输桥真机集成测试（§6.4 Spike + §12.4 第 13 条的自动化）。
//!
//! 对局域网真实设备（REAL_SSH_*，需预装 clangd）验证：
//! SSH exec（无 PTY）→ clangd stdio → Rust 组帧 → JSON-RPC 完整握手：
//! initialize → initialized → textDocument/didOpen → textDocument/hover → shutdown → exit。
//! 同时输出关键 RTT（Spike 报告数据）。
//!
//! 未设置环境变量时自动跳过。

use glance_ide_lib::app_services::lsp::{LspEvent, LspRegistry};
use glance_ide_lib::app_services::ssh_sessions::SessionManager;
use glance_ide_lib::ssh::client::{connect_and_auth, AuthKind, ConnectParams, ConnectStep};
use glance_ide_lib::ssh::device_pool::TrustedDevice;
use glance_ide_lib::ssh::host_key_verifier::parse_public_key_line;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

struct Ctx {
    host: String,
    port: u16,
    username: String,
    password: String,
    fingerprint: String,
}

fn ctx() -> Option<Ctx> {
    let host = std::env::var("REAL_SSH_HOST").ok()?;
    let port = std::env::var("REAL_SSH_PORT").ok()?.parse().ok()?;
    let text = std::fs::read_to_string(std::env::var("REAL_SSH_HOSTKEY_PUB").ok()?).ok()?;
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))?;
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let normalized = format!("{} {}", tokens[tokens.len() - 2], tokens[tokens.len() - 1]);
    let (algo, fingerprint, _) = parse_public_key_line(&normalized).ok()?;
    Some(Ctx {
        host,
        port,
        username: std::env::var("REAL_SSH_USER").unwrap_or_else(|_| "ub".into()),
        password: std::env::var("REAL_SSH_PASS").unwrap_or_else(|_| "123".into()),
        fingerprint,
    })
}

/// 收集 LSP 事件的测试汇：message 入队
struct EventCollector {
    messages: Mutex<mpsc::Receiver<Value>>,
    closed: Mutex<mpsc::Receiver<()>>,
}

async fn connect_session(ctx: &Ctx) -> (SessionManager, Uuid) {
    let pool = vec![TrustedDevice {
        device_identity_id: Uuid::new_v4(),
        fingerprint: ctx.fingerprint.clone(),
        display_name: "LSP 桥测试".into(),
    }];
    let step = connect_and_auth(
        ConnectParams {
            host: ctx.host.clone(),
            port: ctx.port,
            username: ctx.username.clone(),
            auth: AuthKind::Password(ctx.password.clone()),
            pool,
        },
    )
    .await;
    let ConnectStep::Connected { handle, .. } = step else {
        panic!("连接失败");
    };
    let sessions = SessionManager::default();
    let sid = Uuid::new_v4();
    sessions.insert(sid, Uuid::new_v4(), Uuid::new_v4(), None, ctx.host.clone(), 0, handle);
    (sessions, sid)
}

/// 请求-响应辅助：发送 {id} 请求，等待对应 id 的响应（跳过通知）
async fn request(collector: &EventCollector, registry: &LspRegistry, lsp_id: &Uuid, id: i64, method: &str, params: Value) -> Value {
    glance_ide_lib::app_services::lsp::send_message(
        registry,
        lsp_id,
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    );
    wait_response(collector, id, method, std::time::Duration::from_secs(30))
        .await
        .expect("等待响应超时")
}

async fn wait_response(collector: &EventCollector, id: i64, method: &str, timeout: std::time::Duration) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut messages = collector.messages.lock().await;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, messages.recv()).await {
            Ok(Some(msg)) => {
                if msg.get("id").and_then(|i| i.as_i64()) == Some(id) {
                    if msg.get("error").is_some() {
                        panic!("{method} 返回错误: {msg}");
                    }
                    return Some(msg["result"].clone());
                }
                // 非目标响应/通知：丢弃（publishDiagnostics 等由其它用例消费）
            }
            Ok(None) => return None,
            Err(_) => return None,
        }
    }
}

#[tokio::test]
async fn lsp_bridge_clangd_handshake_and_hover() {
    let Some(ctx) = ctx() else {
        eprintln!("跳过：未设置 REAL_SSH_*");
        return;
    };
    let (sessions, sid) = connect_session(&ctx).await;
    let registry = Arc::new(LspRegistry::default());

    let (msg_tx, msg_rx) = mpsc::channel::<Value>(4096);
    let (closed_tx, closed_rx) = mpsc::channel::<()>(4);
    let sink = Arc::new(move |e: LspEvent| match e {
        LspEvent::Message { message } => {
            let _ = msg_tx.try_send(message);
        }
        LspEvent::Stderr { text } => {
            eprintln!("[clangd stderr] {}", text.trim_end());
        }
        LspEvent::Closed { .. } => {
            let _ = closed_tx.try_send(());
        }
    });

    // 工作区：/tmp（clangd 无 compile_commands 时仍可提供基本 hover/补全）
    let started = std::time::Instant::now();
    let lsp_id = glance_ide_lib::app_services::lsp::open_lsp(
        registry.clone(),
        &sessions,
        sid,
        "/tmp",
        "cpp",
        "clangd",
        &[],
        sink,
    )
    .await
    .expect("打开 clangd 通道");
    let open_ms = started.elapsed().as_millis();
    println!("[Spike] lsp_open(exec 启动) 耗时: {open_ms}ms");

    // 1) initialize（Spike 主测量点：握手 RTT）
    let started = std::time::Instant::now();
    let collector = EventCollector {
        messages: Mutex::new(msg_rx),
        closed: Mutex::new(closed_rx),
    };
    let result = request(
        &collector,
        &registry,
        &lsp_id,
        1,
        "initialize",
        json!({
            "processId": serde_json::Value::Null,
            "rootUri": "file:///tmp",
            "capabilities": {
                "textDocument": {
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "completion": { "completionItem": { "snippetSupport": true } }
                }
            }
        }),
    )
    .await;
    let init_ms = started.elapsed().as_millis();
    println!("[Spike] initialize RTT: {init_ms}ms（含 clangd 冷启动）");
    assert!(
        result["capabilities"].is_object(),
        "initialize 应返回 capabilities: {result}"
    );

    // 2) initialized 通知 → didOpen 一个带类型信息的 C++ 文档
    glance_ide_lib::app_services::lsp::send_message(
        &registry,
        &lsp_id,
        &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    );
    let code = "int glance_added(int a, int b) {\n    return a + b;\n}\nint main() {\n    return glance_added(1, 2);\n}\n";
    glance_ide_lib::app_services::lsp::send_message(
        &registry,
        &lsp_id,
        &json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": "file:///tmp/glance-lsp-bridge.cpp",
                    "languageId": "cpp", "version": 1, "text": code
                }
            }
        }),
    );

    // 3) hover（在 glance_added 调用上悬停）——验证双向流 + 语义响应
    //    等待 clangd 索引文档后重试若干次
    let mut hover_ok = false;
    for attempt in 0..15 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        glance_ide_lib::app_services::lsp::send_message(
            &registry,
            &lsp_id,
            &json!({
                "jsonrpc": "2.0", "id": 100 + attempt, "method": "textDocument/hover",
                "params": {
                    "textDocument": { "uri": "file:///tmp/glance-lsp-bridge.cpp" },
                    "position": { "line": 4, "character": 13 }
                }
            }),
        );
        if let Some(resp) = wait_response(&collector, 100 + attempt, "hover", std::time::Duration::from_secs(10)).await {
            if !resp.is_null() {
                let contents = &resp["contents"];
                let text = contents["value"].as_str().unwrap_or("");
                println!("[Spike] hover 响应: {}…", text.chars().take(80).collect::<String>());
                assert!(text.contains("glance_added"), "hover 应包含函数签名: {text}");
                hover_ok = true;
                break;
            }
        }
    }
    assert!(hover_ok, "clangd hover 应返回非空结果");

    // 4) shutdown → exit → 通道关闭
    let result = request(&collector, &registry, &lsp_id, 9999, "shutdown", json!(null)).await;
    let _ = result;
    glance_ide_lib::app_services::lsp::send_message(
        &registry,
        &lsp_id,
        &json!({ "jsonrpc": "2.0", "method": "exit" }),
    );
    // 通道随远程进程退出而关闭
    let mut closed = collector.closed.lock().await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), closed.recv()).await;
    assert!(registry.list().is_empty(), "通道关闭后注册表应清空");


}

/// §6.5：LSP 上下文按设备身份隔离——两个并发会话（同一设备）各开一条 clangd，
/// 互不串扰（各自 initialize 独立成功）
#[tokio::test]
async fn lsp_bridge_two_channels_isolated() {
    let Some(ctx) = ctx() else {
        eprintln!("跳过：未设置 REAL_SSH_*");
        return;
    };
    let (sessions, sid) = connect_session(&ctx).await;
    let registry = Arc::new(LspRegistry::default());

    let make_sink = |tx: mpsc::Sender<Value>| -> Arc<dyn Fn(LspEvent) + Send + Sync> {
        Arc::new(move |e: LspEvent| {
            if let LspEvent::Message { message } = e {
                let _ = tx.try_send(message);
            }
        })
    };

    let (tx1, mut rx1) = mpsc::channel::<Value>(1024);
    let (tx2, rx2) = mpsc::channel::<Value>(1024);
    let id1 = glance_ide_lib::app_services::lsp::open_lsp(
        registry.clone(), &sessions, sid, "/tmp", "cpp", "clangd", &[], make_sink(tx1),
    ).await.unwrap();
    let id2 = glance_ide_lib::app_services::lsp::open_lsp(
        registry.clone(), &sessions, sid, "/tmp", "cpp", "clangd", &[], make_sink(tx2),
    ).await.unwrap();
    assert_ne!(id1, id2);
    assert_eq!(registry.list().len(), 2, "两条独立通道");

    for (id, mut rx) in [(id1, rx1), (id2, rx2)] {
        glance_ide_lib::app_services::lsp::send_message(
            &registry, &id,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": { "processId": null, "rootUri": "file:///tmp", "capabilities": {} } }),
        );
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut got = false;
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(deadline.saturating_duration_since(tokio::time::Instant::now()), rx.recv()).await {
                Ok(Some(msg)) => {
                    if msg.get("id").and_then(|i| i.as_i64()) == Some(1) {
                        assert!(msg["result"]["capabilities"].is_object());
                        got = true;
                        break;
                    }
                }
                _ => break,
            }
        }
        assert!(got, "每条通道应独立完成 initialize");
    }

    glance_ide_lib::app_services::lsp::close_all(&registry);
    assert!(registry.list().is_empty());
}
