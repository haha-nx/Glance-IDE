//! 设备池匹配逻辑（ADR-004/007）。
//!
//! 连接流程中的身份判定顺序：
//! 1. SSH 握手取得服务器 Host Key → 指纹
//! 2. 在当前 Profile 的已授权设备池中查找（`match_fingerprint`）
//! 3. 命中 → 放行进入用户认证；未命中 → 阻断，进入登记/核验流程
//! 4. 登记流程中结合「该端点上一次出现的身份」区分首次新设备与密钥变化
//!    （`classify_registration` 的 identityChanged 语义）
//!
//! 本模块为纯逻辑，无网络依赖；russh 接入层（M2 client.rs）只负责把握手
//! 得到的 blob 送入 `host_key_verifier::fingerprint_from_blob`。

use std::collections::HashSet;

use uuid::Uuid;

use super::host_key_verifier::normalize_fingerprint;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedDevice {
    pub device_identity_id: Uuid,
    /// 已规范化的 SHA256 指纹
    pub fingerprint: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PoolError {
    #[error("设备池中存在重复指纹（疑似克隆镜像），无法区分设备身份")]
    DuplicateFingerprint(String),
    #[error("设备池中的指纹无效: {0}")]
    InvalidFingerprint(String),
}

/// 池内一致性校验：指纹必须合法且互不相同（「克隆 Host Key」验收项）。
pub fn validate_pool(pool: &[TrustedDevice]) -> Result<(), PoolError> {
    let mut seen = HashSet::new();
    for device in pool {
        let normalized = normalize_fingerprint(&device.fingerprint)
            .map_err(|_| PoolError::InvalidFingerprint(device.fingerprint.clone()))?;
        if !seen.insert(normalized) {
            return Err(PoolError::DuplicateFingerprint(device.fingerprint.clone()));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchOutcome {
    /// 指纹属于本 Profile 设备池：放行进入用户认证
    InPool { device_identity_id: Uuid, display_name: String },
    /// 未知/未授权指纹：阻断自动连接（不因 IP、用户名、密码相同而放行）
    NotInPool,
}

/// 在设备池中查找指纹。池为空或未命中一律 NotInPool。
pub fn match_fingerprint(pool: &[TrustedDevice], fingerprint: &str) -> MatchOutcome {
    let Ok(actual) = normalize_fingerprint(fingerprint) else {
        return MatchOutcome::NotInPool;
    };
    pool.iter()
        .find(|d| d.fingerprint == actual)
        .map(|d| MatchOutcome::InPool {
            device_identity_id: d.device_identity_id,
            display_name: d.display_name.clone(),
        })
        .unwrap_or(MatchOutcome::NotInPool)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationContext {
    /// 首次发现的新设备身份（带外核对后登记， 第 5 步）
    FirstRegistration,
    /// 该端点此前出现过的池内身份，本次指纹不同 → 疑似重装/密钥轮换
    KeyChange {
        previous_device_identity_id: Uuid,
        previous_display_name: String,
    },
}

/// 分类登记场景：`last_identity_at_endpoint` 是该 Profile 在当前端点
/// 上一次成功验证的池内身份（由调用方持久化提供；None 表示端点无历史）。
pub fn classify_registration(
    pool: &[TrustedDevice],
    actual_fingerprint: &str,
    last_identity_at_endpoint: Option<&TrustedDevice>,
) -> RegistrationContext {
    match last_identity_at_endpoint {
        Some(previous) if match_fingerprint(pool, actual_fingerprint) == MatchOutcome::NotInPool => {
            RegistrationContext::KeyChange {
                previous_device_identity_id: previous.device_identity_id,
                previous_display_name: previous.display_name.clone(),
            }
        }
        _ => RegistrationContext::FirstRegistration,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, fingerprint: &str, name: &str) -> TrustedDevice {
        TrustedDevice {
            device_identity_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, id.as_bytes()),
            fingerprint: fingerprint.to_string(),
            display_name: name.to_string(),
        }
    }

    // 与 host_key_verifier 测试一致的固定向量；再派生一个不同指纹
    const FP_A: &str = "SHA256:HpUczoNY+jguIUZ5UjeX8i8+jSxQ66W426ODXc21FoQ";

    fn fp_b() -> String {
        // 另一个合法 32 字节摘要（全 0x01）
        let digest = [0x01u8; 32];
        use base64::Engine as _;
        format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD
                .encode(digest)
                .trim_end_matches('=')
        )
    }

    #[test]
    fn rotation_a_b_a_matches_pool() {
        // 「A/B/A 轮换」：池含 A、B，三次连接均自动命中
        let pool = vec![device("a", FP_A, "Raspberry Pi A"), device("b", &fp_b(), "Raspberry Pi B")];
        validate_pool(&pool).unwrap();

        assert_eq!(
            match_fingerprint(&pool, FP_A),
            MatchOutcome::InPool { device_identity_id: pool[0].device_identity_id, display_name: "Raspberry Pi A".into() }
        );
        assert_eq!(
            match_fingerprint(&pool, &fp_b()),
            MatchOutcome::InPool { device_identity_id: pool[1].device_identity_id, display_name: "Raspberry Pi B".into() }
        );
        assert_eq!(match_fingerprint(&pool, FP_A), match_fingerprint(&pool, FP_A));
    }

    #[test]
    fn unknown_device_c_blocked() {
        // 「未登记 C」：同 IP 同账号密码，但指纹不在池 → 阻断
        let pool = vec![device("a", FP_A, "Raspberry Pi A")];
        assert_eq!(match_fingerprint(&pool, &fp_b()), MatchOutcome::NotInPool);
        assert_eq!(match_fingerprint(&[], FP_A), MatchOutcome::NotInPool);
        assert_eq!(match_fingerprint(&pool, "garbage"), MatchOutcome::NotInPool);
    }

    #[test]
    fn fingerprint_normalization_is_transparent() {
        // 带填充的指纹应与无填充形式命中同一设备
        use super::super::host_key_verifier::decode_lenient;
        use base64::Engine as _;
        let bare = &FP_A[7..];
        let digest = decode_lenient(bare).expect("测试向量应可解码");
        let padded = format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD.encode(digest) // 保留 '=' 填充
        );
        let pool = vec![device("a", FP_A, "Raspberry Pi A")];
        assert_ne!(padded, FP_A, "测试前提：填充形式与规范形式字符串不同");
        match normalize_fingerprint(&padded) {
            Ok(n) => assert_eq!(match_fingerprint(&pool, &n), match_fingerprint(&pool, FP_A)),
            Err(e) => panic!("规范化失败: {e:?}"),
        }
    }

    #[test]
    fn key_change_detected_with_history() {
        // 「A 密钥变化」：端点上次是 A，这次指纹不同 → KeyChange
        let device_a = device("a", FP_A, "Raspberry Pi A");
        let pool = vec![device_a.clone()];
        let context = classify_registration(&pool, &fp_b(), Some(&device_a));
        assert_eq!(
            context,
            RegistrationContext::KeyChange {
                previous_device_identity_id: device_a.device_identity_id,
                previous_display_name: "Raspberry Pi A".into(),
            }
        );
    }

    #[test]
    fn first_registration_without_history() {
        // 「B 首次登记」：A 断开、B 接入同 IP；无端点历史记录时按首次登记处理
        let device_a = device("a", FP_A, "Raspberry Pi A");
        let pool = vec![device_a.clone()];
        let context = classify_registration(&pool, &fp_b(), None);
        assert_eq!(context, RegistrationContext::FirstRegistration);
    }

    #[test]
    fn duplicate_fingerprint_rejected() {
        // 「克隆 Host Key」：两台设备同指纹 → 明确报错
        let pool = vec![device("a", FP_A, "A"), device("b", FP_A, "B")];
        let err = validate_pool(&pool).unwrap_err();
        assert!(matches!(err, PoolError::DuplicateFingerprint(_)));
    }

    #[test]
    fn invalid_fingerprint_rejected() {
        let pool = vec![device("a", "not-a-fingerprint", "A")];
        assert!(validate_pool(&pool).is_err());
    }
}
