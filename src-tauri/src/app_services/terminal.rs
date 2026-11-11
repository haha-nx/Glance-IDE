//! 终端（PTY）与构建任务（exec）通道层。
//! - PTY：交互式 shell，独立通道（PTY 与 LSP/exec 严格分离）
//! - exec：无 PTY 执行构建命令；stdout/stderr 经 ExtendedData 原生分离；
//!   exit code 经 ChannelMsg::ExitStatus 获得
//! - 数据经 Tauri Channel 流式推送（长输出用 Channel 而非逐条 Event）
//! - 支持远程 SSH PTY、本机终端（PowerShell/Bash）以及 WSL 终端

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use russh::ChannelMsg;
use serde::Serialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::app_services::ssh_sessions::SessionManager;

/// 事件汇：终端/任务输出统一走此回调（命令层用 Tauri Channel 实现，测试用闭包）
pub type EventSink = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

#[derive(Debug)]
pub enum TerminalCommand {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

struct TerminalEntry {
    commands: mpsc::Sender<TerminalCommand>,
    #[allow(dead_code)]
    session_id: Uuid,
    /// 关联设备（错误跳转解析远程路径用）
    device_identity_id: Uuid,
}

#[derive(Default)]
pub struct TerminalRegistry {
    terminals: StdMutex<HashMap<Uuid, TerminalEntry>>,
}

impl TerminalRegistry {
    fn insert(&self, channel_id: Uuid, entry: TerminalEntry) {
        self.terminals.lock().unwrap().insert(channel_id, entry);
    }

    fn remove(&self, channel_id: &Uuid) -> Option<TerminalEntry> {
        self.terminals.lock().unwrap().remove(channel_id)
    }

    pub fn send(&self, channel_id: &Uuid, cmd: TerminalCommand) -> bool {
        let guard = self.terminals.lock().unwrap();
        match guard.get(channel_id) {
            Some(entry) => {
                let _ = entry.commands.try_send(cmd);
                true
            }
            None => false,
        }
    }

    pub fn device_of(&self, channel_id: &Uuid) -> Option<Uuid> {
        self.terminals
            .lock()
            .unwrap()
            .get(channel_id)
            .map(|e| e.device_identity_id)
    }

    pub fn list(&self) -> Vec<Uuid> {
        self.terminals.lock().unwrap().keys().copied().collect()
    }

    pub fn remove_pub(&self, channel_id: &Uuid) {
        self.terminals.lock().unwrap().remove(channel_id);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub channel_id: Uuid,
    pub session_id: Uuid,
}

fn encode_payload(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn send_data(output: &EventSink, kind: &str, bytes: &[u8]) {
    output(serde_json::json!({ "type": kind, "bytes": encode_payload(bytes) }));
}

/// 打开交互式 PTY 终端（远程 shell）。
pub async fn open_pty(
    registry: Arc<TerminalRegistry>,
    sessions: &SessionManager,
    session_id: Uuid,
    cols: u32,
    rows: u32,
    output: EventSink,
) -> Result<TerminalInfo, String> {
    let entry = sessions
        .get(&session_id)
        .ok_or_else(|| "会话不存在".to_string())?;
    let device_identity_id = entry.device_identity_id;

    let handle = entry.handle.lock().await;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开会话通道失败: {e}"))?;
    channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("请求 PTY 失败: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("请求 shell 失败: {e}"))?;
    let (mut read_half, write_half) = channel.split();
    drop(handle);

    let channel_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::channel::<TerminalCommand>(64);
    registry.insert(
        channel_id,
        TerminalEntry { commands: tx, session_id, device_identity_id },
    );

    // 读循环：PTY 数据 → 前端 Channel（wait 驱动）
    {
        let registry = registry.clone();
        let cid = channel_id;
        tauri::async_runtime::spawn(async move {
            loop {
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        send_data(&output, "data", &data);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        send_data(&output, "data", &data);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            registry.remove(&cid);
            output(serde_json::json!({ "type": "closed" }));
        });
    }

    // 命令循环：写 / resize / 关闭
    {
        let registry = registry.clone();
        let cid = channel_id;
        tauri::async_runtime::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    TerminalCommand::Write(data) => {
                        if write_half.data_bytes(data).await.is_err() {
                            break;
                        }
                    }
                    TerminalCommand::Resize { cols, rows } => {
                        let _ = write_half.window_change(cols, rows, 0, 0).await;
                    }
                    TerminalCommand::Close => {
                        let _ = write_half.eof().await;
                        let _ = write_half.close().await;
                        break;
                    }
                }
            }
            registry.remove(&cid);
        });
    }

    Ok(TerminalInfo { channel_id, session_id })
}

/// 打开通用本地进程终端
async fn open_process_terminal(
    registry: Arc<TerminalRegistry>,
    program: &str,
    args: &[&str],
    cwd: Option<&str>,
    output: EventSink,
) -> Result<TerminalInfo, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动终端进程失败 ({program}): {e}"))?;

    let mut stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
    let mut stderr = child.stderr.take().ok_or("无法捕获 stderr")?;
    let mut stdin = child.stdin.take().ok_or("无法捕获 stdin")?;

    let channel_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::channel::<TerminalCommand>(64);
    registry.insert(
        channel_id,
        TerminalEntry {
            commands: tx,
            session_id: Uuid::nil(),
            device_identity_id: Uuid::nil(),
        },
    );

    // Stdout 读取
    {
        let output = output.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = vec![0u8; 4096];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        send_data(&output, "data", &buf[..n]);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Stderr 读取
    {
        let output = output.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = vec![0u8; 4096];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        send_data(&output, "data", &buf[..n]);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Stdin 写入与生命周期
    {
        let registry = registry.clone();
        let cid = channel_id;
        let output = output.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    TerminalCommand::Write(mut data) => {
                        #[cfg(windows)]
                        if data == b"\r" {
                            data = b"\r\n".to_vec();
                        }
                        if stdin.write_all(&data).await.is_err() {
                            break;
                        }
                        let _ = stdin.flush().await;
                    }
                    TerminalCommand::Resize { .. } => {}
                    TerminalCommand::Close => {
                        let _ = child.kill().await;
                        break;
                    }
                }
            }
            registry.remove(&cid);
            output(serde_json::json!({ "type": "closed" }));
        });
    }

    Ok(TerminalInfo {
        channel_id,
        session_id: Uuid::nil(),
    })
}

/// 打开本机终端（Windows: powershell.exe；Unix: 用户默认 shell，经真实 PTY）
pub async fn open_local_terminal(
    registry: Arc<TerminalRegistry>,
    cwd: Option<&str>,
    output: EventSink,
) -> Result<TerminalInfo, String> {
    #[cfg(windows)]
    {
        open_process_terminal(registry, "powershell.exe", &["-NoLogo"], cwd, output).await
    }
    #[cfg(unix)]
    {
        open_unix_pty_terminal(registry, cwd, output).await
    }
}

/// Unix 本机终端：用 openpty 启动真正的交互式 shell。
///
/// 直接对 bash 使用管道（Stdio::piped）时内核不分配 TTY：shell 退回非交互模式，
/// 没有提示符、不回显输入、行编辑/颜色/^C 失效，且 `\r` 不会被行规程转成换行导致命令不执行。
#[cfg(unix)]
async fn open_unix_pty_terminal(
    registry: Arc<TerminalRegistry>,
    cwd: Option<&str>,
    output: EventSink,
) -> Result<TerminalInfo, String> {
    use std::os::fd::{FromRawFd, OwnedFd};

    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    // openpty 的初始窗口尺寸交给前端 resize 覆盖
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if rc != 0 {
        return Err(format!(
            "创建 PTY 失败: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: openpty 成功返回的两个 fd 由我们独占
    let master_fd = unsafe { OwnedFd::from_raw_fd(master) };
    let slave_fd = unsafe { OwnedFd::from_raw_fd(slave) };

    // 子进程的 stdin/stdout/stderr 都接到 slave 端
    let slave_for_stdin = slave_fd
        .try_clone()
        .map_err(|e| format!("复制 PTY 从端 fd 失败: {e}"))?;
    let slave_for_stdout = slave_fd
        .try_clone()
        .map_err(|e| format!("复制 PTY 从端 fd 失败: {e}"))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = tokio::process::Command::new(&shell);
    cmd.stdin(std::process::Stdio::from(slave_for_stdin))
        .stdout(std::process::Stdio::from(slave_for_stdout))
        .stderr(std::process::Stdio::from(slave_fd))
        .env("TERM", "xterm-256color");

    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }

    // setsid + TIOCSCTTY：让 shell 成为会话首进程并取得控制终端（交互模式的必要条件）
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as libc::c_ulong, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动终端进程失败 ({shell}): {e}"))?;

    // master 端转成 tokio File：读写分两个句柄
    let master_reader = tokio::fs::File::from_std(unsafe {
        std::fs::File::from_raw_fd(std::os::fd::IntoRawFd::into_raw_fd(
            master_fd
                .try_clone()
                .map_err(|e| format!("复制 PTY 主端 fd 失败: {e}"))?,
        ))
    });
    let master_writer = tokio::fs::File::from_std(unsafe {
        std::fs::File::from_raw_fd(std::os::fd::IntoRawFd::into_raw_fd(master_fd))
    });

    let channel_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::channel::<TerminalCommand>(64);
    registry.insert(
        channel_id,
        TerminalEntry {
            commands: tx,
            session_id: Uuid::nil(),
            device_identity_id: Uuid::nil(),
        },
    );

    // 读循环：PTY 输出 → 前端 Channel
    {
        use tokio::io::AsyncReadExt;
        let registry = registry.clone();
        let cid = channel_id;
        let output = output.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = master_reader;
            let mut buf = vec![0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => send_data(&output, "data", &buf[..n]),
                    // 子进程退出后读 master 会返回 EIO，视作正常结束
                    Err(_) => break,
                }
            }
            registry.remove(&cid);
            output(serde_json::json!({ "type": "closed" }));
        });
    }

    // 写循环：键盘输入 / resize / 关闭
    {
        use tokio::io::AsyncWriteExt;
        let registry = registry.clone();
        let cid = channel_id;
        let mut child = child;
        tauri::async_runtime::spawn(async move {
            let mut writer = master_writer;
            let mut master_raw = -1i32;
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    TerminalCommand::Write(data) => {
                        if writer.write_all(&data).await.is_err() {
                            break;
                        }
                        let _ = writer.flush().await;
                    }
                    TerminalCommand::Resize { cols, rows } => {
                        if master_raw < 0 {
                            master_raw = std::os::fd::AsRawFd::as_raw_fd(&writer);
                        }
                        resize_pty_fd(master_raw, cols, rows);
                    }
                    TerminalCommand::Close => {
                        // 先给 shell 一个退出机会，再兜底 kill
                        let _ = writer.write_all(b"exit\n").await;
                        let _ = writer.flush().await;
                        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                        let _ = child.start_kill();
                        break;
                    }
                }
            }
            let _ = child.wait().await;
            registry.remove(&cid);
        });
    }

    Ok(TerminalInfo {
        channel_id,
        session_id: Uuid::nil(),
    })
}

/// 向 PTY master fd 下发窗口尺寸（TIOCSWINSZ）。
#[cfg(unix)]
fn resize_pty_fd(fd: i32, cols: u32, rows: u32) {
    if fd < 0 || cols == 0 || rows == 0 {
        return;
    }
    let ws = libc::winsize {
        ws_row: rows.min(u16::MAX as u32) as u16,
        ws_col: cols.min(u16::MAX as u32) as u16,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(fd, libc::TIOCSWINSZ as libc::c_ulong, &ws);
    }
}

/// 打开指定 WSL 发行版的终端
pub async fn open_wsl_terminal(
    registry: Arc<TerminalRegistry>,
    distro: &str,
    cwd: Option<&str>,
    output: EventSink,
) -> Result<TerminalInfo, String> {
    #[cfg(windows)]
    {
        let mut args = vec!["-d", distro];
        if let Some(dir) = cwd {
            if !dir.is_empty() {
                args.push("--cd");
                args.push(dir);
            }
        }
        open_process_terminal(registry, "wsl.exe", &args, None, output).await
    }
    #[cfg(not(windows))]
    {
        let _ = (registry, distro, cwd, output);
        Err("WSL 终端仅在 Windows 环境下可用".into())
    }
}

/// 执行远程命令（无 PTY，BuildTask 执行器）。
/// stdout/stderr 分离推送；exit code 来自 SSH ExitStatus 语义。
pub async fn run_exec(
    sessions: &SessionManager,
    session_id: Uuid,
    cwd: &str,
    command: &str,
    output: EventSink,
) -> Result<i32, String> {
    let entry = sessions
        .get(&session_id)
        .ok_or_else(|| "会话不存在".to_string())?;

    let cd = if cwd.trim().is_empty() {
        String::new()
    } else {
        let safe = cwd.trim().replace('\'', r"'\''");
        format!("cd '{safe}' || {{ echo 'cd 失败: {cwd}'; exit 127; }}\n")
    };
    let full_command = format!("{cd}{command}");

    let handle = entry.handle.lock().await;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开通道失败: {e}"))?;
    channel
        .exec(false, full_command)
        .await
        .map_err(|e| format!("执行失败: {e}"))?;
    let (mut read_half, write_half) = channel.split();
    drop(handle);

    let mut exit_code: Option<i32> = None;
    let mut saw_eof = false;
    // 远程构建任务超时设置为 30 分钟，避免大工程构建被过早中断
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1800);

    // 单一 wait 循环复用：Data→stdout，ExtendedData→stderr，ExitStatus→退出码
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        match tokio::time::timeout(
            std::time::Duration::from_millis(300),
            read_half.wait(),
        )
        .await
        {
            Err(_timeout) => {
                // 静默期：EOF + 退出码齐备则收尾，否则继续等
                if saw_eof && exit_code.is_some() {
                    break;
                }
            }
            Ok(Some(ChannelMsg::Data { data })) => {
                send_data(&output, "stdout", &data);
            }
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                send_data(&output, "stderr", &data);
            }
            Ok(Some(ChannelMsg::ExitStatus { exit_status })) => {
                exit_code = Some(exit_status as i32);
                if saw_eof {
                    break;
                }
            }
            Ok(Some(ChannelMsg::Eof)) => {
                saw_eof = true;
                if exit_code.is_some() {
                    break;
                }
            }
            Ok(Some(ChannelMsg::Close)) | Ok(None) => break,
            Ok(Some(_)) => {}
        }
    }

    let _ = write_half.close().await;
    let code = exit_code.unwrap_or(-1);
    output(serde_json::json!({ "type": "exit", "code": code }));
    Ok(code)
}

/// 断开时关闭全部终端
pub async fn close_all(registry: &TerminalRegistry) {
    for cid in registry.list() {
        registry.send(&cid, TerminalCommand::Close);
        registry.remove_pub(&cid);
    }
}

/// 执行远程命令并捕获输出（M6 检测类命令用：量小、无需流式）。
/// 返回 (stdout, stderr, exit_code)。
pub async fn exec_capture(
    sessions: &SessionManager,
    session_id: Uuid,
    command: &str,
    timeout: std::time::Duration,
) -> Result<(String, String, i32), String> {
    let entry = sessions
        .get(&session_id)
        .ok_or_else(|| "会话不存在".to_string())?;
    let handle = entry.handle.lock().await;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开通道失败: {e}"))?;
    channel
        .exec(false, command.to_string())
        .await
        .map_err(|e| format!("执行失败: {e}"))?;
    let (mut read_half, write_half) = channel.split();
    drop(handle);

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: Option<i32> = None;
    let mut saw_eof = false;
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        match tokio::time::timeout(std::time::Duration::from_millis(500), read_half.wait()).await {
            Err(_) => {
                if exit_code.is_some() && saw_eof {
                    break;
                }
            }
            Ok(Some(ChannelMsg::Data { data })) => stdout.extend_from_slice(&data),
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => stderr.extend_from_slice(&data),
            Ok(Some(ChannelMsg::ExitStatus { exit_status })) => {
                exit_code = Some(exit_status as i32);
            }
            Ok(Some(ChannelMsg::Eof)) => {
                saw_eof = true;
                if exit_code.is_some() {
                    break;
                }
            }
            Ok(Some(ChannelMsg::Close)) | Ok(None) => break,
            Ok(Some(_)) => {}
        }
    }
    let _ = write_half.close().await;
    Ok((
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
        exit_code.unwrap_or(-1),
    ))
}
