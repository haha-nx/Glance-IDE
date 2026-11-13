//! Windows Subsystem for Linux (WSL) 服务层。
//! 支持枚举本地 WSL 发行版、解析主目录、在 WSL 环境执行任务等。

use serde::Serialize;
#[cfg(windows)]
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
    pub user: String,
    pub is_default: bool,
    pub state: String,
    pub version: u32,
    pub base_path: String,
}

/// 检查本机是否有 WSL 环境
pub fn is_available() -> bool {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("wsl.exe");
        cmd.arg("--status");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 解码 wsl.exe 输出（Windows 下通常为 UTF-16LE）
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2
        && (bytes[0] == 0xFF && bytes[1] == 0xFE
            || bytes.iter().skip(1).step_by(2).any(|&b| b == 0))
    {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .filter(|&c| c != 0xFEFF && c != 0)
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

/// 获取指定发行版的默认登录用户（whoami）
pub fn get_distro_user(distro: &str) -> String {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", distro, "--", "whoami"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = cmd.output() {
            let u = decode_wsl_output(&output.stdout).trim().to_string();
            if !u.is_empty() && !u.contains(' ') {
                return u;
            }
        }
        "root".to_string()
    }
    #[cfg(not(windows))]
    {
        let _ = distro;
        "user".to_string()
    }
}

/// 枚举已安装的 WSL 发行版
pub fn list_distros() -> Result<Vec<WslDistro>, String> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-l", "-v"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output().map_err(|e| format!("无法执行 wsl.exe: {e}"))?;

        let text = decode_wsl_output(&output.stdout);
        let mut distros = Vec::new();

        for line in text.lines().skip(1) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let is_default = line.starts_with('*');
            let clean = if is_default {
                line.trim_start_matches('*').trim()
            } else {
                line
            };

            let parts: Vec<&str> = clean.split_whitespace().collect();
            if parts.is_empty() {
                continue;
            }

            let name = parts[0].to_string();
            let state = if parts.len() > 1 {
                parts[1].to_string()
            } else {
                "Unknown".to_string()
            };
            let version = if parts.len() > 2 {
                parts[2].parse::<u32>().unwrap_or(2)
            } else {
                2
            };

            let user = get_distro_user(&name);
            let base_path = format!(r"\\wsl.localhost\{name}");

            distros.push(WslDistro {
                name,
                user,
                is_default,
                state,
                version,
                base_path,
            });
        }

        Ok(distros)
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// 获取指定发行版的用户主目录（$HOME），默认回退到 /
pub fn get_distro_home(distro: &str) -> String {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", distro, "--", "sh", "-c", "echo $HOME"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output();

        if let Ok(out) = output {
            let s = decode_wsl_output(&out.stdout).trim().to_string();
            if s.starts_with('/') {
                return s;
            }
        }
        "/".to_string()
    }
    #[cfg(not(windows))]
    {
        let _ = distro;
        "/".to_string()
    }
}

/// 规范化 WSL 内的 POSIX 子路径，确保以单个 `/` 开头且不包含连续 `//`。
pub fn normalize_wsl_subpath(linux_path: &str) -> String {
    let mut s = linux_path.replace('\\', "/");
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    if !s.starts_with('/') {
        s.insert(0, '/');
    }
    s
}

/// 从 Windows UNC 路径剥离 `\\wsl.localhost\<distro>` 或 `\\wsl$\<distro>`（大小写不敏感）。
pub fn strip_wsl_unc_prefix(unc_path: &str, distro: &str) -> Option<String> {
    let lower = unc_path.to_ascii_lowercase();
    let p1 = format!(r"\\wsl.localhost\{}", distro.to_ascii_lowercase());
    let p2 = format!(r"\\wsl$\{}", distro.to_ascii_lowercase());
    let matched_len = if lower.starts_with(&p1) {
        Some(p1.len())
    } else if lower.starts_with(&p2) {
        Some(p2.len())
    } else {
        None
    }?;
    let rest = &unc_path[matched_len..];
    if rest.is_empty() || rest.starts_with('\\') || rest.starts_with('/') {
        let posix = rest.replace('\\', "/");
        if posix.is_empty() {
            Some("/".to_string())
        } else {
            Some(normalize_wsl_subpath(&posix))
        }
    } else {
        None
    }
}

/// 将 WSL POSIX 路径解析为 Windows 下的 UNC 路径；
/// 优先检查 `\\wsl.localhost\<distro>`，回退 `\\wsl$\<distro>`，并在需要时唤醒 Stopped 发行版。
pub fn resolve_wsl_unc_path(distro: &str, linux_path: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        let normalized = normalize_wsl_subpath(linux_path);
        let win_sub = normalized.replace('/', "\\");
        let build_unc = |prefix: &str| {
            if win_sub == "\\" {
                format!("{prefix}\\")
            } else {
                format!("{prefix}{win_sub}")
            }
        };

        let localhost_prefix = format!(r"\\wsl.localhost\{distro}");
        let dollar_prefix = format!(r"\\wsl$\{distro}");
        let root_localhost = format!(r"{localhost_prefix}\");
        let root_dollar = format!(r"{dollar_prefix}\");

        if std::path::Path::new(&root_localhost).exists() {
            return Ok(build_unc(&localhost_prefix));
        }
        if std::path::Path::new(&root_dollar).exists() {
            return Ok(build_unc(&dollar_prefix));
        }

        // 若发行版处于 Stopped 状态，9P 共享尚未挂载，先通过无窗口子进程唤醒再探测
        let mut wake = Command::new("wsl.exe");
        wake.args(["-d", distro, "--", "true"]);
        wake.creation_flags(CREATE_NO_WINDOW);
        let _ = wake.output();

        if std::path::Path::new(&root_localhost).exists() {
            return Ok(build_unc(&localhost_prefix));
        }
        if std::path::Path::new(&root_dollar).exists() {
            return Ok(build_unc(&dollar_prefix));
        }

        Ok(build_unc(&localhost_prefix))
    }
    #[cfg(not(windows))]
    {
        let _ = (distro, linux_path);
        Err("WSL 仅在 Windows 环境下可用".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_wsl_unc_handles_both_prefixes_case_insensitive() {
        assert_eq!(
            strip_wsl_unc_prefix(r"\\WSL.LOCALHOST\Ubuntu\home\dev\app.ts", "ubuntu").as_deref(),
            Some("/home/dev/app.ts")
        );
        assert_eq!(
            strip_wsl_unc_prefix(r"\\wsl$\Ubuntu\etc", "Ubuntu").as_deref(),
            Some("/etc")
        );
        assert_eq!(
            strip_wsl_unc_prefix(r"\\wsl.localhost\Ubuntu", "Ubuntu").as_deref(),
            Some("/")
        );
        assert_eq!(
            strip_wsl_unc_prefix(r"\\wsl.localhost\Ubuntu-22.04\home", "Ubuntu"),
            None
        );
    }

    #[test]
    fn normalize_wsl_subpath_collapses_slashes() {
        assert_eq!(normalize_wsl_subpath(r"home\\user//proj"), "/home/user/proj");
        assert_eq!(normalize_wsl_subpath("/"), "/");
    }
}
