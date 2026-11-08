//! 真实设备端到端互操作测试（§12 真机验收的自动化部分）。
//!
//! 针对局域网真实 Linux 设备（如 Ubuntu/树莓派）验证：
//! 空池阻断 → 指纹一致 → 密码认证 → exec(stdout/stderr/退出码) → SFTP 全流程 → PTY shell。
//!
//! 环境变量（未设置时跳过）：
//!   REAL_SSH_HOST / REAL_SSH_PORT / REAL_SSH_USER / REAL_SSH_PASS / REAL_SSH_HOSTKEY_PUB

use glance_ide_lib::app_services::ssh_sessions::SessionManager;
use glance_ide_lib::app_services::terminal::{self, TerminalCommand, TerminalRegistry};
use glance_ide_lib::filesystem::sftp::SftpFileSystem;
use glance_ide_lib::filesystem::FileSystemProvider;
use glance_ide_lib::ssh::client::{connect_and_auth, AuthKind, ConnectParams, ConnectStep};
use glance_ide_lib::ssh::device_pool::TrustedDevice;
use glance_ide_lib::ssh::host_key_verifier::parse_public_key_line;
use russh_sftp::client::SftpSession;
use std::sync::Arc;
use uuid::Uuid;

struct RealCtx {
    host: String,
    port: u16,
    username: String,
    password: String,
    fingerprint: String,
    key_algorithm: String,
}

fn real_ctx() -> Option<RealCtx> {
    let host = std::env::var("REAL_SSH_HOST").ok()?;
    let port = std::env::var("REAL_SSH_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(22);
    let hostkey_pub = std::env::var("REAL_SSH_HOSTKEY_PUB").ok()?;
    let text = std::fs::read_to_string(&hostkey_pub).expect("读取 hostkey 公钥失败");
    // ssh-keyscan 输出含 `# 注释` 行且每行带主机前缀（host algo blob），
    // 取第一条真实密钥行并重组为标准 `algo blob` 两字段形式
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
        .expect("公钥文件无有效行");
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let normalized_line = format!("{} {}", tokens[tokens.len() - 2], tokens[tokens.len() - 1]);
    let line = normalized_line.as_str();
    let (key_algorithm, fingerprint, _) = parse_public_key_line(line).expect("解析公钥失败");
    Some(RealCtx {
        host,
        port,
        username: std::env::var("REAL_SSH_USER").unwrap_or_else(|_| "ub".into()),
        password: std::env::var("REAL_SSH_PASS").unwrap_or_else(|_| "123".into()),
        fingerprint,
        key_algorithm,
    })
}

fn params(ctx: &RealCtx, pool: Vec<TrustedDevice>, password: &str) -> ConnectParams {
    ConnectParams {
        host: ctx.host.clone(),
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

fn trusted_for(ctx: &RealCtx) -> Vec<TrustedDevice> {
    vec![TrustedDevice {
        device_identity_id: Uuid::new_v4(),
        fingerprint: ctx.fingerprint.clone(),
        display_name: "实机设备".into(),
    }]
}

/// #1 空池阻断 + 指纹一致 + 正确密码认证 + 错误密码拒绝（§12.2 前三行的自动化）
#[tokio::test]
async fn real_01_identity_and_auth() {
    let Some(ctx) = real_ctx() else {
        eprintln!("跳过：未设置 REAL_SSH_*");
        return;
    };

    // 空池 → UnknownIdentity，指纹必须与 ssh-keyscan 一致
    let step = connect_and_auth(params(&ctx, vec![], &ctx.password)).await;
    match step {
        ConnectStep::UnknownIdentity { observed } => {
            assert_eq!(observed.fingerprint, ctx.fingerprint, "观测指纹应与服务器一致");
        }
        ConnectStep::NetworkError { message } => {
            panic!("空池应返回 UnknownIdentity，实际 NetworkError: {message}")
        }
        other => panic!("空池应返回 UnknownIdentity，实际: {}", step_name(&other)),
    }

    // 池内 + 正确密码 → Connected
    let pool = trusted_for(&ctx);
    let expected_id = pool[0].device_identity_id;
    let step = connect_and_auth(params(&ctx, pool, &ctx.password)).await;
    match step {
        ConnectStep::Connected { device_identity_id, .. } => {
            assert_eq!(device_identity_id, expected_id, "应绑定池内设备身份");
        }
        other => panic!("池内+正确密码应 Connected，实际: {}", step_name(&other)),
    }

    // 池内 + 错误密码 → AuthFailed（身份通过≠凭据正确）
    let step = connect_and_auth(params(&ctx, trusted_for(&ctx), "wrong-pass")).await;
    match step {
        ConnectStep::AuthFailed { .. } => {}
        other => panic!("错误密码应 AuthFailed，实际: {}", step_name(&other)),
    }
}

fn decode_events(events: &std::sync::Mutex<Vec<serde_json::Value>>, kind: Option<&str>) -> String {
    use base64::Engine as _;
    let mut bytes: Vec<u8> = Vec::new();
    for v in events.lock().unwrap().iter() {
        if let Some(k) = kind {
            if v.get("type").and_then(|t| t.as_str()) != Some(k) {
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

/// #2 exec：stdout / stderr 分离 / 退出码（真实 OpenSSH）
#[tokio::test]
async fn real_02_exec_channels() {
    let Some(ctx) = real_ctx() else { return };
    let step = connect_and_auth(params(&ctx, trusted_for(&ctx), &ctx.password)).await;
    let ConnectStep::Connected { handle, .. } = step else {
        panic!("连接失败: {}", step_name(&step));
    };
    let sessions = SessionManager::default();
    sessions.insert(
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        None,
        format!("{}:{}", ctx.host, ctx.port),
        0,
        handle,
    );
    let sid = sessions.list()[0].session_id;

    // stdout + exit 0
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: terminal::EventSink = {
        let events = events.clone();
        Arc::new(move |v| events.lock().unwrap().push(v))
    };
    let code = terminal::run_exec(&sessions, sid, "", "echo glance-real-ok", sink).await.unwrap();
    assert_eq!(code, 0, "echo 退出码应为 0");
    let out = decode_events(&events, Some("stdout"));
    assert!(out.contains("glance-real-ok"), "stdout 应包含输出: {out}");

    // cwd 切换：写读临时文件
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: terminal::EventSink = {
        let events = events.clone();
        Arc::new(move |v| events.lock().unwrap().push(v))
    };
    let code = terminal::run_exec(&sessions, sid, "/tmp", "pwd", sink).await.unwrap();
    assert_eq!(code, 0);
    let out = decode_events(&events, Some("stdout"));
    assert!(out.contains("/tmp"), "cwd 切换应生效: {out}");

    // stderr 分离
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: terminal::EventSink = {
        let events = events.clone();
        Arc::new(move |v| events.lock().unwrap().push(v))
    };
    let code = terminal::run_exec(&sessions, sid, "", "echo to-stderr >&2; echo to-stdout", sink)
        .await
        .unwrap();
    assert_eq!(code, 0);
    let stderr = decode_events(&events, Some("stderr"));
    let stdout = decode_events(&events, Some("stdout"));
    assert!(stderr.contains("to-stderr"), "stderr 应包含错误输出: {stderr}");
    assert!(stdout.contains("to-stdout"), "stdout 应包含标准输出: {stdout}");

    // 退出码传递
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: terminal::EventSink = {
        let events = events.clone();
        Arc::new(move |v| events.lock().unwrap().push(v))
    };
    let code = terminal::run_exec(&sessions, sid, "", "exit 7", sink).await.unwrap();
    assert_eq!(code, 7, "exit 7 应原样传递");
}

/// #3 SFTP：真实 OpenSSH sftp-server 全流程（写/读/冲突/建删/重命名），含中文
#[tokio::test]
async fn real_03_sftp_filesystem() {
    let Some(ctx) = real_ctx() else { return };
    let step = connect_and_auth(params(&ctx, trusted_for(&ctx), &ctx.password)).await;
    let ConnectStep::Connected { handle, .. } = step else {
        panic!("连接失败: {}", step_name(&step));
    };
    let channel = handle.channel_open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    let session = SftpSession::new(channel.into_stream()).await.unwrap();
    let fs = SftpFileSystem::new(session);

    // 主目录可列
    let entries = fs.list_dir("/tmp").await.unwrap();
    assert!(!entries.is_empty(), "/tmp 不应为空目录");

    // 写读回（中文内容）
    let file = "/tmp/glance-real-roundtrip.txt";
    let written = fs.write_file(file, "实机测试-glance-你好", None).await.unwrap();
    assert!(written.modified_ms > 0, "写后应有 mtime");
    let content = fs.read_file(file).await.unwrap();
    assert_eq!(content.text.as_deref(), Some("实机测试-glance-你好"));

    // 保存冲突检测（expected mtime 不一致 → Conflict）
    let conflict = fs.write_file(file, "x", Some(written.modified_ms.wrapping_sub(1000))).await;
    assert!(conflict.is_err(), "陈旧 mtime 应触发冲突");

    // 目录操作 + 重命名 + 递归删除
    fs.create_dir("/tmp/glance-real-dir").await.unwrap();
    fs.rename(file, "/tmp/glance-real-dir/renamed.txt").await.unwrap();
    let sub = fs.list_dir("/tmp/glance-real-dir").await.unwrap();
    assert_eq!(sub.len(), 1);
    assert_eq!(sub[0].name, "renamed.txt");
    fs.delete("/tmp/glance-real-dir", true).await.unwrap();
    assert!(!std::path::Path::new("/tmp/glance-real-dir").exists());
}

/// #4 PTY shell：提示符数据到达 + 命令回显（真实 shell 算术求值）+ 关闭清理
#[tokio::test]
async fn real_04_pty_shell() {
    let Some(ctx) = real_ctx() else { return };
    let step = connect_and_auth(params(&ctx, trusted_for(&ctx), &ctx.password)).await;
    let ConnectStep::Connected { handle, .. } = step else {
        panic!("连接失败: {}", step_name(&step));
    };
    let sessions = SessionManager::default();
    sessions.insert(
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        None,
        format!("{}:{}", ctx.host, ctx.port),
        0,
        handle,
    );
    let sid = sessions.list()[0].session_id;

    let registry = Arc::new(TerminalRegistry::default());
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: terminal::EventSink = {
        let events = events.clone();
        Arc::new(move |v| events.lock().unwrap().push(v))
    };
    let info = terminal::open_pty(registry.clone(), &sessions, sid, 100, 30, sink).await.unwrap();

    // 真实 shell 会输出 motd/prompt 等，任何数据到达即视为 PTY 建立
    let mut got_data = false;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if !decode_events(&events, None).is_empty() {
            got_data = true;
            break;
        }
    }
    assert!(got_data, "PTY 应在超时前收到 shell 输出");

    // 命令回显（PTY 回显 + 算术求值双重验证）
    registry.send(
        &info.channel_id,
        TerminalCommand::Write(b"echo PTYREAL$((1+1))\n".to_vec()),
    );
    let mut ok = false;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if decode_events(&events, None).contains("PTYREAL2") {
            ok = true;
            break;
        }
    }
    assert!(ok, "PTY 应回显并执行 echo PTYREAL$((1+1)) → PTYREAL2");

    // resize 不应崩溃
    registry.send(&info.channel_id, TerminalCommand::Resize { cols: 120, rows: 40 });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    registry.send(&info.channel_id, TerminalCommand::Close);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(registry.list().is_empty(), "关闭后注册表应清空");
}

/// #5 工程识别与语言服务器检测（只读）
#[tokio::test]
async fn real_05_lsp_detect() {
    let Some(ctx) = real_ctx() else { return };
    let step = connect_and_auth(params(&ctx, trusted_for(&ctx), &ctx.password)).await;
    let ConnectStep::Connected { handle, .. } = step else {
        panic!("连接失败: {}", step_name(&step));
    };
    let sessions = SessionManager::default();
    sessions.insert(
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        None,
        format!("{}:{}", ctx.host, ctx.port),
        0,
        handle,
    );
    let sid = sessions.list()[0].session_id;

    let servers = glance_ide_lib::app_services::lsp::detect_servers(&sessions, sid)
        .await
        .unwrap();
    assert!(!servers.is_empty(), "应返回检测列表（无论是否安装）");
    for s in &servers {
        if s.available {
            assert!(s.version.is_some(), "可用服务器应有版本信息");
        }
    }
    let home = sessions.list()[0].endpoint.clone();
    let _ = home; // endpoint 仅记录
    let project = glance_ide_lib::app_services::lsp::detect_project(&sessions, sid, "/tmp")
        .await
        .unwrap();
    assert_eq!(project.workspace_root, "/tmp");
}

/// #6 会话生命周期（用户反馈修复的回归）：
/// 同设备多会话时 find_by_device 必须路由到**最新**会话；
/// 传输断开的僵尸会话必须被 prune；同配置替换语义（disconnect_profile_sessions）生效。
#[tokio::test]
async fn real_06_session_lifecycle() {
    let Some(ctx) = real_ctx() else { return };
    let pool = trusted_for(&ctx);

    // 两个"不同时刻"的会话（同一设备身份，模拟反复点击连接产生的堆积）
    let step1 = connect_and_auth(params(&ctx, pool.clone(), &ctx.password)).await;
    let ConnectStep::Connected { handle: h1, .. } = step1 else {
        panic!("第一次连接失败: {}", step_name(&step1));
    };
    let step2 = connect_and_auth(params(&ctx, pool.clone(), &ctx.password)).await;
    let ConnectStep::Connected { handle: h2, device_identity_id, .. } = step2 else {
        panic!("第二次连接失败: {}", step_name(&step2));
    };

    let sessions = SessionManager::default();
    let profile_id = Uuid::new_v4();
    let id1 = sessions.insert(Uuid::new_v4(), profile_id, device_identity_id, None, "s1".into(), 1000, h1).session_id;
    let id2 = sessions.insert(Uuid::new_v4(), profile_id, device_identity_id, None, "s2".into(), 2000, h2).session_id;

    // 1) 路由必须选最新（s2, connected_at=2000），而非 HashMap 随机序
    let found = sessions.find_by_device(&device_identity_id).await.expect("应有活跃会话");
    assert_eq!(found.endpoint, "s2", "find_by_device 应路由到最新会话");

    // 2) 僵尸清理：仅断开 s1 的传输（保留条目，模拟对端断开）→ prune 后仍返回 s2
    assert!(sessions.drop_transport(&id1).await);
    // 传输关闭是异步完成的（会话任务处理 Disconnect 后 sender 才置 closed）
    for _ in 0..50 {
        match sessions.get(&id1) {
            Some(e) if e.is_alive().await => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            _ => break,
        }
    }
    let found = sessions.find_by_device(&device_identity_id).await.expect("s2 仍应活跃");
    assert_eq!(found.endpoint, "s2");
    assert_eq!(sessions.list().len(), 1, "僵尸会话应被清理");

    // 3) 替换语义：同一 profile 的全部会话一并回收
    let removed = sessions.disconnect_profile_sessions(&profile_id).await;
    assert_eq!(removed.len(), 1, "应移除 s2（s1 已被 prune）");
    assert!(sessions.find_by_device(&device_identity_id).await.is_none());
}
