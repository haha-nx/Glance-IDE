//! 远程语言智能（路线图 M6，§06）。
//! - 语言服务器检测：可执行路径 / 版本 / 架构（§6.6：不静默安装，缺失则降级提示）
//! - 工程识别：ROS 2 / CMake / Python 工作区与 compile_commands.json 指纹（§6.3/§6.5）
//! - LSP 传输桥（§6.4 Spike 冻结方案）：SSH exec（无 PTY）字节透传 +
//!   Rust 侧 JSON-RPC Content-Length 组帧/解帧；前端经 Tauri Channel 收发 JSON 消息。
//!   决策记录见 docs/Handoff.md「M6 LSP Spike 结论」。

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::app_services::ssh_sessions::SessionManager;
use crate::app_services::terminal::exec_capture;

const DETECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerInfo {
    pub language: String,
    pub server: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub arch: Option<String>,
    pub available: bool,
}

/// 版本输出首行（clangd：`clangd version 18.1.3`；pyright：`pyright 1.1.3xx`）
fn first_meaningful_line(text: &str) -> Option<String> {
    text.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(120).collect())
}

/// 检测目标设备上预装的语言服务器（§6.6：不得联网下载）
pub async fn detect_servers(
    sessions: &SessionManager,
    session_id: Uuid,
) -> Result<Vec<LspServerInfo>, String> {
    let mut out = Vec::new();
    for (language, server) in [("c/cpp", "clangd"), ("python", "pyright-langserver"), ("python", "pylsp")] {
        let (path_out, _, code) = exec_capture(
            sessions,
            session_id,
            &format!("command -v {server} || true"),
            DETECT_TIMEOUT,
        )
        .await?;
        let path = path_out.trim().to_string();
        let available = code == 0 && !path.is_empty();
        let version = if available {
            let (vout, _, _) = exec_capture(
                sessions,
                session_id,
                &format!("{server} --version"),
                DETECT_TIMEOUT,
            )
            .await?;
            first_meaningful_line(&vout)
        } else {
            None
        };
        let arch = if available {
            let (arch_out, _, _) = exec_capture(sessions, session_id, "uname -m", DETECT_TIMEOUT)
                .await
                .unwrap_or_default();
            let a = arch_out.trim().to_string();
            (!a.is_empty()).then_some(a)
        } else {
            None
        };
        out.push(LspServerInfo {
            language: language.to_string(),
            server: server.to_string(),
            path: available.then_some(path),
            version,
            arch,
            available,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub workspace_root: String,
    pub kind: String, // ros2 | cmake | python | unknown
    pub details: Vec<String>,
    /// compile_commands.json 是否存在（clangd 必需，§6.3）
    pub has_compile_commands: bool,
    /// compile_commands.json 摘要指纹（sha256 前 16 位；缓存键组成部分 §6.5）
    pub compile_db_fingerprint: Option<String>,
}

/// 识别远程工程结构（只读探测，不执行构建脚本 §3.2 Project Service 边界）
pub async fn detect_project(
    sessions: &SessionManager,
    session_id: Uuid,
    workspace_root: &str,
) -> Result<ProjectInfo, String> {
    let root = workspace_root.trim().trim_end_matches('/').to_string();
    let mut details = Vec::new();

    let (probe, _, code) = exec_capture(
        sessions,
        session_id,
        &format!(
            "test -d '{root}/src' && ls '{root}/src' | head -50 || true; \
             test -f '{root}/CMakeLists.txt' && echo CMAKE_ROOT || true; \
             test -f '{root}/package.xml' && echo ROS_ROOT || true; \
             test -f '{root}/pyproject.toml' && echo PYPROJECT || true; \
             test -f '{root}/setup.py' && echo SETUP || true; \
             find '{root}/build' -maxdepth 2 -name compile_commands.json 2>/dev/null | head -3; \
             test -f '{root}/compile_commands.json' && echo '{root}/compile_commands.json'"
        ),
        DETECT_TIMEOUT,
    )
    .await?;

    let mut has_compile_commands = false;
    let mut compile_db_path: Option<String> = None;
    let mut kind = "unknown";

    for line in probe.lines() {
        let line = line.trim();
        if line.ends_with("compile_commands.json") {
            has_compile_commands = true;
            compile_db_path = Some(line.to_string());
        } else {
            match line {
                "CMAKE_ROOT" => details.push("CMakeLists.txt（CMake 工程）".into()),
                "ROS_ROOT" => {
                    kind = "ros2";
                    details.push("package.xml（ROS 2 工作区）".into());
                }
                "PYPROJECT" | "SETUP" => {
                    if kind == "unknown" {
                        kind = "python";
                    }
                    details.push("Python 打包配置".into());
                }
                other if !other.is_empty() => details.push(format!("src/{other}")),
                _ => {}
            }
        }
    }
    if code != 0 && details.is_empty() {
        details.push("远程探测未完成（会话异常？）".into());
    }

    // compile_commands 指纹（§6.5 缓存键：device+workspace+clangd_version+compile_db_hash）
    let compile_db_fingerprint = if let Some(path) = compile_db_path {
        let (hash, _, hcode) = exec_capture(
            sessions,
            session_id,
            &format!("sha256sum '{path}' | cut -c1-16"),
            DETECT_TIMEOUT,
        )
        .await
        .unwrap_or_default();
        (hcode == 0).then(|| hash.trim().to_string()).filter(|s| !s.is_empty())
    } else {
        None
    };

    Ok(ProjectInfo {
        workspace_root: root,
        kind: kind.to_string(),
        details,
        has_compile_commands,
        compile_db_fingerprint,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// LSP 传输桥（§6.4）：SSH exec（无 PTY）↔ JSON-RPC Content-Length 组帧 ↔ 前端 Channel
//
// 安全（§6.4 硬性要求）：
// - 不监听任何本机端口（Tauri Channel 方案的天然优势，无攻击面）
// - 远程命令参数分离构造 + 白名单字符校验；工作区路径安全转义，绝不拼接进 shell
// - 通道生命周期与会话绑定：会话断开 / 应用退出即关闭
// ─────────────────────────────────────────────────────────────────────────────

/// JSON-RPC 单帧上限：clangd/pylsp 响应（含补全列表）实际远小于此
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
/// 读缓冲上限（防异常远端无限膨胀）
const MAX_BUFFER_BYTES: usize = MAX_FRAME_BYTES + 4096;

/// 校验服务器可执行名：仅字母/数字/`.`/`_`/`-`/`/`，禁止元字符与 `..` 穿越
pub fn validate_server_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("服务器名为空".into());
    }
    if name.contains("..") {
        return Err("服务器名含路径穿越".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
    {
        return Err(format!("服务器名含非法字符: {name}"));
    }
    Ok(())
}

/// 校验单个命令行参数：仅保守字符集（shlex 安全类），禁止引号/元字符/变量展开
pub fn validate_server_arg(arg: &str) -> Result<(), String> {
    if arg.is_empty() {
        return Err("参数为空".into());
    }
    if !arg
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '%' | '+' | '=' | '_' | ':' | ',' | '.' | '/' | '-'))
    {
        return Err(format!("参数含非法字符: {arg}"));
    }
    Ok(())
}

/// 工作区路径安全转义（与 terminal.rs run_exec 同法：单引号包裹 + '\'' 穿透）
fn quote_remote_path(path: &str) -> String {
    path.replace('\'', r"'\''")
}

/// 构造远程启动命令：`cd 'root' || exit 126` + `exec server args...`（exec 使信号直达进程）
fn build_lsp_command(root: &str, server: &str, args: &[String]) -> String {
    let mut cmd = format!("cd '{}' || exit 126\nexec {}", quote_remote_path(root), server);
    for a in args {
        cmd.push(' ');
        cmd.push_str(a);
    }
    cmd
}

/// JSON-RPC stdio 组帧（LSP over stdio 标准：Content-Length 头 + \r\n\r\n + 正文）
pub fn frame_message(msg: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(msg).expect("JSON-RPC 消息序列化");
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = header.into_bytes();
    out.extend_from_slice(&body);
    out
}

/// Content-Length 帧解析器：容忍分片/粘帧/前导噪声（clangd 启动横幅等）
#[derive(Default)]
pub struct FrameParser {
    buffer: Vec<u8>,
    /// 解析失败（超长声明等）后置位；置位后丢弃后续输入
    pub broken: bool,
}

impl FrameParser {
    /// 喂入新字节，返回解出的完整 JSON 消息
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Value> {
        if self.broken {
            return Vec::new();
        }
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > MAX_BUFFER_BYTES {
            self.broken = true;
            self.buffer.clear();
            return Vec::new();
        }
        let mut messages = Vec::new();
        loop {
            match self.parse_one() {
                FrameStep::NeedMore => break,
                FrameStep::Message(v) => messages.push(v),
                FrameStep::Broken => {
                    self.broken = true;
                    self.buffer.clear();
                    break;
                }
            }
        }
        messages
    }

    fn parse_one(&mut self) -> FrameStep {
        // 跳过前导噪声（服务器启动横幅、 \r\n 等），直到出现头字段
        let header_end = match find_header_end(&self.buffer) {
            Some(idx) => idx,
            None => {
                // 无完整头：若缓冲已 >4KB 且仍找不到头，认为全是噪声，保留尾部防截断
                if self.buffer.len() > 4096 {
                    let keep = self.buffer.split_off(self.buffer.len() - 4096);
                    self.buffer = keep;
                }
                return FrameStep::NeedMore;
            }
        };
        let header = String::from_utf8_lossy(&self.buffer[..header_end]);
        let mut content_length: Option<usize> = None;
        for line in header.split("\r\n") {
            if let Some((k, v)) = line.split_once(':') {
                if k.trim().eq_ignore_ascii_case("content-length") {
                    content_length = v.trim().parse::<usize>().ok();
                }
            }
        }
        let Some(len) = content_length else {
            // 头内无 Content-Length：丢弃这段头继续找
            self.buffer.drain(..header_end + 4);
            return FrameStep::NeedMore;
        };
        if len > MAX_FRAME_BYTES {
            return FrameStep::Broken;
        }
        let body_start = header_end + 4;
        let body_end = body_start + len;
        if self.buffer.len() < body_end {
            return FrameStep::NeedMore;
        }
        let body: Vec<u8> = self.buffer[body_start..body_end].to_vec();
        self.buffer.drain(..body_end);
        match serde_json::from_slice::<Value>(&body) {
            Ok(v) => FrameStep::Message(v),
            Err(_) => FrameStep::NeedMore, // 坏帧：丢弃，不毒化通道
        }
    }
}

enum FrameStep {
    NeedMore,
    Message(Value),
    Broken,
}

/// 在缓冲中找 `\r\n\r\n` 头结束位置（返回头结束索引，正文从 idx+4 开始）
fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// 前端事件（Channel 推送）：message=完整 JSON-RPC 消息；stderr=服务器诊断文本；closed=通道结束
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LspEvent {
    Message { message: Value },
    Stderr { text: String },
    Closed { reason: Option<String> },
}

pub(crate) enum LspCommand {
    Write(Vec<u8>),
    Close,
}

struct LspChannelEntry {
    lsp_id: Uuid,
    session_id: Uuid,
    /// 所属设备身份（§6.5：LSP 上下文按设备隔离，不以 IP 为键）
    pub device_identity_id: Uuid,
    /// 工作区/语言/服务器（§6.5 缓存键，诊断与展示用）
    #[allow(dead_code)]
    pub workspace_root: String,
    #[allow(dead_code)]
    pub language: String,
    #[allow(dead_code)]
    pub server: String,
    commands: mpsc::Sender<LspCommand>,
}

/// LSP 通道注册表（M6）：lsp_id → 通道；会话断开时统一回收
#[derive(Default)]
pub struct LspRegistry {
    channels: StdMutex<HashMap<Uuid, LspChannelEntry>>,
}

impl LspRegistry {
    fn insert(&self, entry: LspChannelEntry) {
        self.channels.lock().unwrap().insert(entry.lsp_id, entry);
    }

    fn remove(&self, lsp_id: &Uuid) -> Option<LspChannelEntry> {
        self.channels.lock().unwrap().remove(lsp_id)
    }

    pub(crate) fn send(&self, lsp_id: &Uuid, cmd: LspCommand) -> bool {
        match self.channels.lock().unwrap().get(lsp_id) {
            Some(entry) => entry.commands.try_send(cmd).is_ok(),
            None => false,
        }
    }

    pub fn device_of(&self, lsp_id: &Uuid) -> Option<Uuid> {
        self.channels
            .lock()
            .unwrap()
            .get(lsp_id)
            .map(|e| e.device_identity_id)
    }

    pub fn list_by_device(&self, device_identity_id: &Uuid) -> Vec<Uuid> {
        self.channels
            .lock()
            .unwrap()
            .values()
            .filter(|e| &e.device_identity_id == device_identity_id)
            .map(|e| e.lsp_id)
            .collect()
    }

    pub fn list(&self) -> Vec<Uuid> {
        self.channels.lock().unwrap().keys().copied().collect()
    }

    pub fn remove_pub(&self, lsp_id: &Uuid) {
        self.channels.lock().unwrap().remove(lsp_id);
    }
}

/// 打开远程语言服务器（exec 无 PTY，§4.8 PTY/exec 严格分离）。
/// stdout=JSON-RPC 帧；stderr=服务器日志（推给前端展示，不污染协议流）。
#[allow(clippy::too_many_arguments)]
pub async fn open_lsp(
    registry: Arc<LspRegistry>,
    sessions: &SessionManager,
    session_id: Uuid,
    workspace_root: &str,
    language: &str,
    server: &str,
    args: &[String],
    sink: Arc<dyn Fn(LspEvent) + Send + Sync>,
) -> Result<Uuid, String> {
    validate_server_name(server)?;
    for a in args {
        validate_server_arg(a)?;
    }
    let root = workspace_root.trim().trim_end_matches('/');
    if root.is_empty() || root.contains("..") {
        return Err("工作区路径无效".into());
    }
    let entry = sessions
        .get(&session_id)
        .ok_or_else(|| "会话不存在".to_string())?;

    let handle = entry.handle.lock().await;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 LSP 通道失败: {e}"))?;
    channel
        .exec(false, build_lsp_command(root, server, args))
        .await
        .map_err(|e| format!("启动语言服务器失败: {e}"))?;
    let (mut read_half, write_half) = channel.split();
    drop(handle);

    let lsp_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::channel::<LspCommand>(64);
    registry.insert(LspChannelEntry {
        lsp_id,
        session_id,
        device_identity_id: entry.device_identity_id,
        workspace_root: root.to_string(),
        language: language.to_string(),
        server: server.to_string(),
        commands: tx,
    });

    // 读循环：stdout 帧 → JSON 消息；stderr → 文本事件
    {
        let registry = registry.clone();
        let id = lsp_id;
        tauri::async_runtime::spawn(async move {
            let mut parser = FrameParser::default();
            loop {
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        for msg in parser.feed(&data) {
                            sink(LspEvent::Message { message: msg });
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        sink(LspEvent::Stderr {
                            text: String::from_utf8_lossy(&data).into_owned(),
                        });
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            registry.remove(&id);
            sink(LspEvent::Closed { reason: None });
        });
    }

    // 命令循环：写帧 / 关闭
    {
        let registry = registry.clone();
        let id = lsp_id;
        tauri::async_runtime::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    LspCommand::Write(bytes) => {
                        if write_half.data_bytes(bytes).await.is_err() {
                            break;
                        }
                    }
                    LspCommand::Close => {
                        let _ = write_half.eof().await;
                        let _ = write_half.close().await;
                        break;
                    }
                }
            }
            registry.remove(&id);
        });
    }

    Ok(lsp_id)
}

/// 发送一条 JSON-RPC 消息（组帧后写入远程 stdin）
pub fn send_message(registry: &LspRegistry, lsp_id: &Uuid, msg: &Value) -> bool {
    registry.send(lsp_id, LspCommand::Write(frame_message(msg)))
}

/// 关闭 LSP 通道
pub fn close(registry: &LspRegistry, lsp_id: &Uuid) {
    registry.send(lsp_id, LspCommand::Close);
    registry.remove_pub(lsp_id);
}

/// 会话断开时回收其全部 LSP 通道
pub async fn close_by_session(registry: &LspRegistry, session_id: &Uuid) {
    let ids: Vec<Uuid> = registry
        .channels
        .lock()
        .unwrap()
        .values()
        .filter(|e| &e.session_id == session_id)
        .map(|e| e.lsp_id)
        .collect();
    for id in ids {
        close(registry, &id);
    }
}

/// 应用退出时关闭全部
pub fn close_all(registry: &LspRegistry) {
    for id in registry.list() {
        registry.send(&id, LspCommand::Close);
        registry.remove_pub(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_extraction() {
        assert_eq!(
            first_meaningful_line("\nclangd version 18.1.3\nFeatures: x"),
            Some("clangd version 18.1.3".into())
        );
        assert_eq!(first_meaningful_line("   "), None);
    }

    #[test]
    fn rejects_shell_metachars_in_server_args() {
        assert!(validate_server_name("clangd").is_ok());
        assert!(validate_server_name("/usr/bin/clangd-12").is_ok());
        assert!(validate_server_name("clangd;rm -rf /").is_err());
        assert!(validate_server_name("clangd --version").is_err());
        assert!(validate_server_name("").is_err());
        assert!(validate_server_name("clangd/../evil").is_err());

        assert!(validate_server_arg("--stdio").is_ok());
        assert!(validate_server_arg("--log=verbose").is_ok());
        assert!(validate_server_arg("--compile-commands-dir=/tmp/a b").is_err());
        assert!(validate_server_arg("$(evil)").is_err());
        assert!(validate_server_arg("`id`").is_err());
        assert!(validate_server_arg("a;b").is_err());
    }

    #[test]
    fn quotes_remote_workspace_path_safely() {
        assert_eq!(quote_remote_path("/home/ub/ws"), "/home/ub/ws");
        assert_eq!(quote_remote_path("/tmp/o'bite"), "/tmp/o'\\''bite");
    }

    #[test]
    fn builds_cd_exec_command() {
        let cmd = build_lsp_command("/home/ub/ros2_ws", "clangd", &["--log=verbose".to_string()]);
        assert_eq!(
            cmd,
            "cd '/home/ub/ros2_ws' || exit 126\nexec clangd --log=verbose"
        );
    }

    #[test]
    fn frame_parser_handles_split_and_multiple_frames() {
        let msg = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "result": { "x": 1 } });
        let framed = frame_message(&msg);
        let mut parser = FrameParser::default();

        // 一半先喂、一半后喂
        let (a, b) = framed.split_at(framed.len() / 2);
        let mut out = parser.feed(a);
        assert!(out.is_empty());
        out.extend(parser.feed(b));
        assert_eq!(out, vec![msg.clone()]);

        // 一条缓冲内两个完整帧
        let mut both = frame_message(&msg);
        both.extend(frame_message(&serde_json::json!({"jsonrpc":"2.0","method":"exit"})));
        let out = parser.feed(&both);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], msg);

        // 垃圾前缀（非 ASCII 头）：丢弃到下一个合法头
        let mut garbage = b"\r\n junk \r\n".to_vec();
        garbage.extend(frame_message(&msg));
        let out = parser.feed(&garbage);
        assert_eq!(out, vec![msg]);
    }

    #[test]
    fn frame_parser_rejects_oversized_header() {
        let mut parser = FrameParser::default();
        let bad = b"Content-Length: 999999999999\r\n\r\n{}".to_vec();
        assert!(parser.feed(&bad).is_empty() || parser.buffer.is_empty());
        assert!(parser.broken, "超长声明应标记通道损坏");
    }
}
