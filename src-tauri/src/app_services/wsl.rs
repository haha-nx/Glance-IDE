//! Windows Subsystem for Linux (WSL) 服务层。
//! 支持枚举本地 WSL 发行版、解析主目录、在 WSL 环境执行任务等。

use serde::Serialize;
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
