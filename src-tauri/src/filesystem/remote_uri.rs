//! 资源 URI（路线图 §5.3）：
//! - 本地：普通绝对路径，或 `local://<path>`
//! - 远程：`remote://<device-identity-uuid><path>`，路径以 `/` 开头
//!
//! 远程 URI 必须包含设备身份 UUID，不得只按 IP 区分（ADR-005）。

use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceUri {
    Local { path: String },
    Remote { device_identity_id: Uuid, path: String },
}

impl ResourceUri {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let raw = raw.trim();
        if let Some(rest) = raw.strip_prefix("remote://") {
            let mut parts = rest.splitn(2, '/');
            let id_part = parts.next().unwrap_or_default();
            let path = parts.next().unwrap_or_default();
            if id_part.is_empty() {
                return Err(format!("remote URI 缺少设备身份: {raw}"));
            }
            let device_identity_id =
                Uuid::parse_str(id_part).map_err(|e| format!("设备身份 UUID 无效: {e}"))?;
            let path = format!("/{path}");
            return Ok(Self::Remote { device_identity_id, path });
        }
        let path = raw
            .strip_prefix("local://")
            .map(|p| p.to_string())
            .unwrap_or_else(|| raw.to_string());
        if path.trim().is_empty() {
            return Err("空路径".into());
        }
        Ok(Self::Local { path })
    }

    pub fn remote(device_identity_id: Uuid, path: &str) -> Self {
        let path = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        };
        Self::Remote { device_identity_id, path }
    }

    pub fn as_string(&self) -> String {
        match self {
            Self::Local { path } => path.clone(),
            Self::Remote {
                device_identity_id,
                path,
            } => format!("remote://{device_identity_id}{path}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "b0f1a2c3-4d5e-6f70-8a9b-c0d1e2f3a4b5";

    #[test]
    fn parses_remote_uri() {
        let uri = ResourceUri::parse(&format!("remote://{ID}/home/pi/ros2_ws/src/main.cpp")).unwrap();
        match uri {
            ResourceUri::Remote { device_identity_id, path } => {
                assert_eq!(device_identity_id.to_string(), ID);
                assert_eq!(path, "/home/pi/ros2_ws/src/main.cpp");
            }
            other => panic!("应为 Remote: {other:?}"),
        }
    }

    #[test]
    fn roundtrips_and_rejects_bad() {
        let uri = ResourceUri::remote(ID.parse().unwrap(), "home/pi");
        assert_eq!(uri.as_string(), format!("remote://{ID}/home/pi"));

        assert!(ResourceUri::parse("remote://not-a-uuid/x").is_err());
        assert!(ResourceUri::parse("remote:///x").is_err());
        assert!(ResourceUri::parse("  ").is_err());
        // 本地形式
        assert_eq!(
            ResourceUri::parse("local:///Users/x/a.txt").unwrap(),
            ResourceUri::Local { path: "/Users/x/a.txt".into() }
        );
        assert_eq!(
            ResourceUri::parse("/Users/x/a.txt").unwrap(),
            ResourceUri::Local { path: "/Users/x/a.txt".into() }
        );
    }
}
