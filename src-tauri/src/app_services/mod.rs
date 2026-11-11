//! 应用服务层。
//! - connection_profiles：连接配置 CRUD + 设备池查询
//! - ssh_sessions：运行时会话生命周期（session_id 绑定 profile+identity+endpoint）
//! - terminal：PTY 终端与构建任务执行器
//! - discovery：局域网发现（mDNS + 受控 TCP 扫描）
//! - search：全局文本搜索
//! - wsl：WSL 发行版探测与环境调度

pub mod connection_profiles;
pub mod discovery;
pub mod lsp;
pub mod search;
pub mod ssh_sessions;
pub mod terminal;
pub mod wsl;
