//! SSH 身份与设备池模块（路线图 §04）。
//! 本模块沉淀四层分离模型中的核心逻辑（ADR-003/004/007）：
//! - host_key_verifier：Host Key 指纹计算与规范化（§4.3）
//! - device_pool：Profile 设备池匹配、未知身份与密钥变化分类（§4.4/§4.5）
//! - client / channels：M2 接入 russh 握手、认证与 Channel

pub mod client;
pub mod device_pool;
pub mod host_key_verifier;
