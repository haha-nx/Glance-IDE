//! Host Key 指纹计算与规范化（路线图 §4.3）。
//!
//! SSH 指纹 = `SHA256:` + Base64(SHA-256(公钥 wire blob))（OpenSSH 风格，无填充）。
//! authorized_keys / known_hosts 行中的 Base64 主体本身就是 SSH wire 格式公钥 blob，
//! 因此无需解析具体算法即可计算指纹（与 `ssh-keygen -lf` 一致）。
//!
//! 边界（§4.3 重要边界）：指纹代表 SSH 服务器密钥身份，不是硬件身份。

use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use sha2::{Digest, Sha256};

/// Base64 引擎：解码兼容有/无填充（指纹展示无填充、带填充输入都接受），
/// 编码输出带填充（生成指纹时再统一去掉）。
const B64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub const SHA256_PREFIX: &str = "SHA256:";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FingerprintError {
    #[error("公钥行格式无效")]
    InvalidFormat,
    #[error("Base64 解码失败")]
    InvalidBase64,
    #[error("公钥数据为空")]
    Empty,
}

/// 宽容 Base64 解码（供模块内与设备池测试复用）。
pub fn decode_lenient(input: &str) -> Result<Vec<u8>, FingerprintError> {
    B64.decode(input.trim()).map_err(|_| FingerprintError::InvalidBase64)
}

/// 从公钥 wire blob 计算 OpenSSH 风格 SHA256 指纹。
/// russh 握手得到的服务器公钥 blob（M2）与 authorized_keys 行主体均可直接使用。
pub fn fingerprint_from_blob(blob: &[u8]) -> Result<String, FingerprintError> {
    if blob.is_empty() {
        return Err(FingerprintError::Empty);
    }
    let digest = Sha256::digest(blob);
    Ok(format!("{}{}", SHA256_PREFIX, B64.encode(digest).trim_end_matches('=')))
}

/// 解析 authorized_keys 风格的公钥行，返回 (算法名, 指纹, 备注)。
/// 行格式：`<algo> <base64-blob> [comment]`
pub fn parse_public_key_line(line: &str) -> Result<(String, String, Option<String>), FingerprintError> {
    let trimmed = line.trim();
    let mut parts = trimmed.split_whitespace();
    let algo = parts.next().ok_or(FingerprintError::InvalidFormat)?;
    let body = parts.next().ok_or(FingerprintError::InvalidFormat)?;
    let comment = parts.collect::<Vec<_>>().join(" ");
    let comment = if comment.is_empty() { None } else { Some(comment) };

    if algo.contains(':') || algo.contains('/') {
        // 形如 SHA256:xxx 或路径，说明这不是 `algo blob` 结构
        return Err(FingerprintError::InvalidFormat);
    }

    let blob = decode_lenient(body)?;
    let fingerprint = fingerprint_from_blob(&blob)?;
    Ok((algo.to_string(), fingerprint, comment))
}

/// 规范化指纹字符串，用于存储与比较（§4.3 fingerprint_sha256）。
/// 接受 `SHA256:xxx`（可带 `=` 填充，前缀大小写不敏感）或裸 32 字节 Base64 摘要；
/// 输出统一为 `SHA256:<无填充 Base64>`。
pub fn normalize_fingerprint(raw: &str) -> Result<String, FingerprintError> {
    let trimmed = raw.trim();
    let body = if trimmed.len() >= SHA256_PREFIX.len()
        && trimmed[..SHA256_PREFIX.len()].eq_ignore_ascii_case(SHA256_PREFIX)
    {
        &trimmed[SHA256_PREFIX.len()..]
    } else {
        trimmed
    };
    if body.is_empty() {
        return Err(FingerprintError::Empty);
    }
    let digest = decode_lenient(body)?;
    if digest.len() != 32 {
        // SHA-256 摘要固定 32 字节
        return Err(FingerprintError::InvalidFormat);
    }
    Ok(format!("{}{}", SHA256_PREFIX, B64.encode(digest).trim_end_matches('=')))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 固定测试向量：本机 ssh-keygen 生成的 ed25519 密钥（仅用于测试，无凭据价值）。
    const TEST_LINE: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAQxxmTjGWotg1K14G2C1StJqhVHqXgnVfzcEDSqwm1o glance-test-vector";
    const TEST_FINGERPRINT: &str = "SHA256:HpUczoNY+jguIUZ5UjeX8i8+jSxQ66W426ODXc21FoQ";

    #[test]
    fn parses_openssh_public_key_line() {
        let (algo, fp, comment) = parse_public_key_line(TEST_LINE).unwrap();
        assert_eq!(algo, "ssh-ed25519");
        assert_eq!(fp, TEST_FINGERPRINT);
        assert_eq!(comment.as_deref(), Some("glance-test-vector"));
    }

    #[test]
    fn fingerprint_matches_ssh_keygen() {
        // 与 `ssh-keygen -lf` 输出一致
        let (_, fp, _) = parse_public_key_line(TEST_LINE).unwrap();
        assert_eq!(fp, TEST_FINGERPRINT);
    }

    #[test]
    fn normalizes_padded_and_bare_forms() {
        // 带 SHA256: 前缀
        assert_eq!(normalize_fingerprint(TEST_FINGERPRINT).unwrap(), TEST_FINGERPRINT);
        // 去掉前缀的裸 Base64（带填充）
        let bare = &TEST_FINGERPRINT[SHA256_PREFIX.len()..];
        assert_eq!(normalize_fingerprint(bare).unwrap(), TEST_FINGERPRINT);
        // 大小写不同的前缀
        assert_eq!(
            normalize_fingerprint(&format!("sha256:{}", bare)).unwrap(),
            TEST_FINGERPRINT
        );
    }

    #[test]
    fn normalize_rejects_bad_input() {
        assert!(normalize_fingerprint("not-base64!!").is_err());
        assert!(normalize_fingerprint("SHA256:").is_err());
        assert!(normalize_fingerprint("").is_err());
        // 合法 Base64 但不是 32 字节摘要
        assert!(normalize_fingerprint("AAAA").is_err());
    }

    #[test]
    fn rejects_non_key_line() {
        assert!(parse_public_key_line("SHA256:HpUczoNY+jguIUZ5UjeX8i8+jSxQ66W426ODXc21FoQ").is_err());
        assert!(parse_public_key_line("").is_err());
        assert!(parse_public_key_line("ssh-ed25519 not-base64!!").is_err());
    }
}
