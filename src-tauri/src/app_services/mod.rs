//! 应用服务层（路线图 §3.2）。
//! - connection_profiles：连接配置 CRUD + 设备池查询
//! - ssh_sessions：运行时会话生命周期（session_id 绑定 profile+identity+endpoint，§11.4）
//! - terminal：PTY 终端与构建任务执行器（§7）
//! - discovery：局域网发现（mDNS + 受控 TCP 扫描，§8）
//! - search：全局文本搜索

pub mod connection_profiles;
pub mod discovery;
pub mod lsp;
pub mod search;
pub mod ssh_sessions;
pub mod terminal;

