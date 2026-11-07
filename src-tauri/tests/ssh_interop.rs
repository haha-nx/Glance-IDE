//! SSH 互操作集成测试（路线图 M2 任务 2.8 的本地预演）。
//!
//! 依赖外部测试服务器：Node ssh2 脚本（/tmp/glance-e2e/server/server.js），
//! 监听 127.0.0.1，账号 pi / raspberry，ed25519 Host Key。
//! 未设置环境变量时自动跳过，不影响常规 `cargo test`。

use glance_ide_lib::ssh::client::{connect_and_auth, AuthKind, ConnectParams, ConnectStep};
use glance_ide_lib::ssh::device_pool::TrustedDevice;
use glance_ide_lib::ssh::host_key_verifier::parse_public_key_line;
use uuid::Uuid;

struct TestCtx {
    port: u16,
    username: String,
    password: String,
    fingerprint: String,
    key_algorithm: String,
}

fn test_ctx() -> Option<TestCtx> {
    let port = std::env::var("GLANCE_SSH_TEST_PORT").ok()?;
    let hostkey_pub = std::env::var("GLANCE_SSH_TEST_HOSTKEY_PUB").ok()?;
    let line = std::fs::read_to_string(&hostkey_pub).expect("读取 hostkey.pub 失败");
    let (key_algorithm, fingerprint, _) = parse_public_key_line(&line).expect("解析 hostkey 公钥失败");
    Some(TestCtx {
        port: port.parse().expect("端口无效"),
        username: std::env::var("GLANCE_SSH_TEST_USER").unwrap_or_else(|_| "pi".into()),
        password: std::env::var("GLANCE_SSH_TEST_PASS").unwrap_or_else(|_| "raspberry".into()),
        fingerprint,
        key_algorithm,
    })
}

fn params(ctx: &TestCtx, pool: Vec<TrustedDevice>, password: &str) -> ConnectParams {
    ConnectParams {
        host: "127.0.0.1".into(),
        port: ctx.port,
        username: ctx.username.clone(),
        auth: AuthKind::Password(password.to_string()),
        pool,
    }
}

fn step_name(step: &ConnectStep) -> &'static str {
    match step {
        ConnectStep::Connected { .. } => "Connected",
        ConnectStep::UnknownIdentity { .. } => "UnknownIdentity",
        ConnectStep::IdentityChanged { .. } => "IdentityChanged",
        ConnectStep::AuthFailed { .. } => "AuthFailed",
        ConnectStep::NetworkError { .. } => "NetworkError",
    }
}

/// §12.2 设备池专项验收的自动化预演：
/// 1. 空设备池 → UnknownIdentity（首次登记，展示的指纹与服务器实际一致）
/// 2. 指纹入池 + 正确密码 → Connected
/// 3. 指纹入池 + 错误密码 → AuthFailed（身份通过≠凭据正确）
#[tokio::test]
async fn interop_pool_rotation_and_auth() {
    let Some(ctx) = test_ctx() else {
        eprintln!("跳过：未设置 GLANCE_SSH_TEST_PORT / GLANCE_SSH_TEST_HOSTKEY_PUB");
        return;
    };

    // 1. 空池 → 未知身份阻断
    let step = connect_and_auth(params(&ctx, vec![], &ctx.password)).await;
    match step {
        ConnectStep::UnknownIdentity { observed } => {
            assert_eq!(observed.fingerprint, ctx.fingerprint, "观测指纹应与服务器一致");
            assert_eq!(observed.algorithm, ctx.key_algorithm);
        }
        other => panic!("空设备池应返回 UnknownIdentity，实际: {}", step_name(&other)),
    }

    // 2. 登记指纹（模拟 approve_identity 后重连）→ 认证成功
    let pool = vec![TrustedDevice {
        device_identity_id: Uuid::new_v4(),
        fingerprint: ctx.fingerprint.clone(),
        display_name: "测试设备".into(),
    }];
    let step = connect_and_auth(params(&ctx, pool.clone(), &ctx.password)).await;
    match step {
        ConnectStep::Connected { device_identity_id, .. } => {
            assert_eq!(device_identity_id, pool[0].device_identity_id);
        }
        other => panic!("池内指纹 + 正确密码应 Connected，实际: {}", step_name(&other)),
    }

    // 3. 身份通过但凭据错误 → AuthFailed
    let step = connect_and_auth(params(&ctx, pool, "wrong-password")).await;
    match step {
        ConnectStep::AuthFailed { .. } => {}
        other => panic!("错误密码应返回 AuthFailed，实际: {}", step_name(&other)),
    }
}

/// M3：SFTP 文件系统互操作——经 SftpFileSystem 对真实 sftp-server 做列目录/写/读/删。
#[tokio::test]
async fn interop_sftp_filesystem() {
    use glance_ide_lib::filesystem::sftp::SftpFileSystem;
    use glance_ide_lib::filesystem::FileSystemProvider;
    use russh_sftp::client::SftpSession;

    let Some(ctx) = test_ctx() else {
        eprintln!("跳过：未设置 GLANCE_SSH_TEST_PORT / GLANCE_SSH_TEST_HOSTKEY_PUB");
        return;
    };
    let pool = vec![TrustedDevice {
        device_identity_id: Uuid::new_v4(),
        fingerprint: ctx.fingerprint.clone(),
        display_name: "SFTP 测试".into(),
    }];
    let step = connect_and_auth(params(&ctx, pool, &ctx.password)).await;
    let ConnectStep::Connected { handle, .. } = step else {
        panic!("前置连接失败: {}", step_name(&step));
    };

    let channel = handle.channel_open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    let session = SftpSession::new(channel.into_stream()).await.unwrap();
    let fs = SftpFileSystem::new(session);

    // 列目录（服务器根目录 = 运行 node 的机器根目录）
    let entries = fs.list_dir("/tmp/glance-e2e").await.unwrap();
    assert!(entries.iter().any(|e| e.name == "keys"), "应能列出 keys 目录");

    // 写 + 读回
    let file = "/tmp/glance-e2e/sftp-roundtrip.txt";
    let written = fs.write_file(file, "glance-sftp-你好", None).await.unwrap();
    assert!(written.modified_ms > 0);
    let content = fs.read_file(file).await.unwrap();
    assert_eq!(content.text.as_deref(), Some("glance-sftp-你好"));

    // 冲突检测
    let conflict = fs.write_file(file, "x", Some(written.modified_ms - 1)).await;
    assert!(conflict.is_err());

    // mkdir / rename / delete
    fs.create_dir("/tmp/glance-e2e/sftp-test-dir").await.unwrap();
    fs.rename(file, "/tmp/glance-e2e/sftp-test-dir/renamed.txt").await.unwrap();
    let sub = fs.list_dir("/tmp/glance-e2e/sftp-test-dir").await.unwrap();
    assert_eq!(sub.len(), 1);
    assert_eq!(sub[0].name, "renamed.txt");
    fs.delete("/tmp/glance-e2e/sftp-test-dir", true).await.unwrap();
    assert!(!std::path::Path::new("/tmp/glance-e2e/sftp-test-dir").exists());
}

/// M4：exec（stdout/stderr 分离 + 退出码）与 PTY shell 互操作。
#[tokio::test]
async fn interop_exec_and_pty() {
    use glance_ide_lib::app_services::ssh_sessions::SessionManager;
    use glance_ide_lib::app_services::terminal::{self, TerminalCommand, TerminalRegistry};
    use std::sync::Arc;

    let Some(ctx) = test_ctx() else {
        eprintln!("跳过：未设置 GLANCE_SSH_TEST_PORT / GLANCE_SSH_TEST_HOSTKEY_PUB");
        return;
    };
    let pool = vec![TrustedDevice {
        device_identity_id: Uuid::new_v4(),
        fingerprint: ctx.fingerprint.clone(),
        display_name: "M4 测试".into(),
    }];
    let step = connect_and_auth(params(&ctx, pool, &ctx.password)).await;
    let ConnectStep::Connected { handle, .. } = step else {
        panic!("前置连接失败: {}", step_name(&step));
    };

    let sessions = SessionManager::default();
    sessions.insert(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), None, "127.0.0.1".into(), 0, handle);

    let sid = sessions.list()[0].session_id;
    let collect = |sink_events: Arc<std::sync::Mutex<Vec<serde_json::Value>>>| {
        move |v: serde_json::Value| {
            sink_events.lock().unwrap().push(v);
        }
    };


    use base64::Engine as _;
    fn decode_events(events: &std::sync::Mutex<Vec<serde_json::Value>>, kind: Option<&str>) -> String {
        use base64::Engine as _;
        let mut bytes: Vec<u8> = Vec::new();
        for v in events.lock().unwrap().iter() {
            if let Some(kind_name) = kind {
                if v.get("type").and_then(|t| t.as_str()) != Some(kind_name) {
                    continue;
                }
            }
            if let Some(b) = v.get("bytes").and_then(|b| b.as_str()) {
                if let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b) {
                    bytes.extend_from_slice(&raw);
                }
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    // 1. exec stdout + exit 0
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: terminal::EventSink = Arc::new(collect(events.clone()));
    let code = terminal::run_exec(&sessions, sid, "", "echo glance-exec-ok", sink).await.unwrap();
    assert_eq!(code, 0);
    let out = decode_events(&events, Some("stdout"));
    assert!(out.contains("exec:echo glance-exec-ok"), "stdout 应包含回显: {out}");

    // 2. exec stderr 通道
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: terminal::EventSink = Arc::new(collect(events.clone()));
    let code = terminal::run_exec(&sessions, sid, "", "stderr:oops", sink).await.unwrap();
    assert_eq!(code, 3);
    let stderr = decode_events(&events, Some("stderr"));
    assert!(stderr.contains("oops"), "stderr 应包含 oops: {stderr}");

    // 3. exec 退出码传递
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: terminal::EventSink = Arc::new(collect(events.clone()));
    let code = terminal::run_exec(&sessions, sid, "", "exit 7", sink).await.unwrap();
    assert_eq!(code, 7);

    // 4. PTY shell：提示符出现 + 回显 + 关闭
    let registry = Arc::new(TerminalRegistry::default());
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: terminal::EventSink = Arc::new(collect(events.clone()));
    let info = terminal::open_pty(registry.clone(), &sessions, sid, 80, 24, sink).await.unwrap();
    // 等待提示符
    let mut saw_prompt = false;
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let text = decode_events(&events, None);
        if text.contains("glance-test$") {
            saw_prompt = true;
            break;
        }
    }
    assert!(saw_prompt, "PTY 应收到提示符");
    registry.send(&info.channel_id, TerminalCommand::Write(b"hello\n".to_vec()));
    let mut saw_echo = false;
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let text = decode_events(&events, None);
        if text.contains("echo:hello") {
            saw_echo = true;
            break;
        }
    }
    assert!(saw_echo, "PTY 应回显输入");
    registry.send(&info.channel_id, TerminalCommand::Close);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(registry.list().is_empty(), "关闭后注册表应清空");
}
