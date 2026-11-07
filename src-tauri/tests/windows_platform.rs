//! Windows 平台差异验证（Handoff 遗留 #3：keyring/Windows Credential Manager、网卡枚举）。
//! 这些是纯后端能力，cargo test 直接验证；未在 Windows 上运行时自动跳过。

use glance_ide_lib::storage::secret_store::{KeyringStore, SecretStore};

/// Windows Credential Manager 往返：写入 → 读取 → 更新 → 删除
/// credential_ref 形如 glance://profile/<uuid>（§9.2：SQLite 只存引用）
#[test]
fn windows_credential_manager_roundtrip() {
    if !cfg!(windows) {
        eprintln!("跳过：非 Windows");
        return;
    }
    let store = KeyringStore::default();
    let cred_ref = format!("glance://profile/{}", uuid::Uuid::new_v4());

    // 无凭据时返回 None（不panic）
    assert!(store.get_secret(&cred_ref).unwrap().is_none());

    // 写入 → 读取
    store.set_secret(&cred_ref, "glance-win-pass-123").unwrap();
    assert_eq!(store.get_secret(&cred_ref).unwrap().as_deref(), Some("glance-win-pass-123"));

    // 更新（覆盖写）
    store.set_secret(&cred_ref, "updated-pass").unwrap();
    assert_eq!(store.get_secret(&cred_ref).unwrap().as_deref(), Some("updated-pass"));

    // 删除 → 读取为 None
    store.delete_secret(&cred_ref).unwrap();
    assert!(store.get_secret(&cred_ref).unwrap().is_none());
    // 二次删除不报错
    store.delete_secret(&cred_ref).unwrap();
}

/// 中文/特殊字符密码往返（凭据内容的 UTF-16 转换正确性）
#[test]
fn windows_credential_unicode_secret() {
    if !cfg!(windows) {
        eprintln!("跳过：非 Windows");
        return;
    }
    let store = KeyringStore::default();
    let cred_ref = format!("glance://profile/{}", uuid::Uuid::new_v4());
    let secret = "密码-🔐-p@ss wörd";
    store.set_secret(&cred_ref, secret).unwrap();
    assert_eq!(store.get_secret(&cred_ref).unwrap().as_deref(), Some(secret));
    store.delete_secret(&cred_ref).unwrap();
}

/// 网卡枚举（M5 发现的第一步，discovery_interfaces 同源）：至少一个非回环 IPv4 地址
#[test]
fn network_interfaces_enumerable() {
    let ifaces = if_addrs::get_if_addrs().expect("枚举网卡失败");
    assert!(
        ifaces.iter().any(|i| matches!(i.addr, if_addrs::IfAddr::V4(_))
            && !i.ip().to_string().starts_with("127.")),
        "应枚举到非回环 IPv4 接口"
    );
}
