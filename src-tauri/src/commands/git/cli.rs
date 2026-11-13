//! Git 跨平台（本地 / WSL / SSH）命令执行器、路径 URI 归一化与输入校验。

use std::time::Duration;

use tokio::process::Command;

use super::types::*;
use crate::app_services::terminal::exec_capture;
use crate::commands::CmdError;
use crate::filesystem::ResourceUri;
use crate::AppState;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(super) fn decode_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2
        && ((bytes[0] == 0xFF && bytes[1] == 0xFE)
            || bytes.iter().skip(1).step_by(2).take(16).filter(|&&b| b == 0).count() > 4)
    {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .filter(|&c| c != 0xFEFF && c != 0)
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub(super) fn normalize_path(raw: &str) -> String {
    let s = raw.trim().replace('\\', "/");
    if s.len() > 1 && s.ends_with('/') {
        // 保留 Windows 盘符根目录如 C:/
        if s.len() == 3 && s.as_bytes()[1] == b':' {
            s
        } else {
            s.trim_end_matches('/').to_string()
        }
    } else {
        s
    }
}

pub(super) fn paths_equal(target: &GitTarget, a: &str, b: &str) -> bool {
    let na = normalize_path(a);
    let nb = normalize_path(b);
    match target {
        GitTarget::Local { .. } if cfg!(target_os = "windows") => na.eq_ignore_ascii_case(&nb),
        _ => na == nb,
    }
}

pub(super) fn build_workspace_uri(target: &GitTarget, raw_fs_path: &str) -> String {
    let norm = normalize_path(raw_fs_path);
    match target {
        GitTarget::Local { .. } => norm,
        GitTarget::Wsl { distro, .. } => {
            let p = if norm.starts_with('/') { norm } else { format!("/{norm}") };
            format!("wsl://{distro}{p}")
        }
        GitTarget::Remote { device_id, .. } => {
            let p = if norm.starts_with('/') { norm } else { format!("/{norm}") };
            format!("remote://{device_id}{p}")
        }
    }
}

pub(super) fn join_repo_file_uri(target: &GitTarget, repo_root: &str, rel_path: &str) -> String {
    let base = normalize_path(repo_root);
    let rel = rel_path.trim_start_matches('/');
    let full = if base.ends_with('/') {
        format!("{base}{rel}")
    } else {
        format!("{base}/{rel}")
    };
    build_workspace_uri(target, &full)
}

pub(super) fn shell_quote_posix(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\"'\"'"))
}

pub(super) fn strip_uri_to_fs_path(target: &GitTarget, input: &str) -> String {
    let trimmed = input.trim();
    match ResourceUri::parse(trimmed) {
        Ok(ResourceUri::Local { path }) => path,
        Ok(ResourceUri::Wsl { path, .. }) => path,
        Ok(ResourceUri::Remote { path, .. }) => path,
        Err(_) => match target {
            GitTarget::Local { .. } => trimmed.to_string(),
            GitTarget::Wsl { .. } | GitTarget::Remote { .. } => trimmed.replace('\\', "/"),
        },
    }
}

pub(super) async fn resolve_target(state: &AppState, root_uri: &str) -> Result<GitTarget, CmdError> {
    let parsed = ResourceUri::parse(root_uri)
        .map_err(|e| CmdError::validation(format!("工作区路径无效: {e}")))?;
    match parsed {
        ResourceUri::Local { path } => Ok(GitTarget::Local { root: path }),
        ResourceUri::Wsl { distro, path } => Ok(GitTarget::Wsl { distro, path }),
        ResourceUri::Remote {
            device_identity_id,
            path,
        } => {
            let entry = state
                .sessions
                .find_by_device(&device_identity_id)
                .await
                .ok_or_else(|| CmdError::validation("SSH 会话未连接，无法执行 Git 操作"))?;
            Ok(GitTarget::Remote {
                session_id: entry.session_id,
                device_id: device_identity_id.to_string(),
                path: path.replace('\\', "/"),
            })
        }
    }
}

pub(super) async fn run_git_at(
    state: &AppState,
    target: &GitTarget,
    cwd_override: Option<&str>,
    args: &[&str],
    timeout_secs: u64,
) -> Result<CmdOutput, CmdError> {
    match target {
        GitTarget::Local { root } => {
            let dir = cwd_override.unwrap_or(root.as_str());
            let mut cmd = Command::new("git");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.env("GIT_TERMINAL_PROMPT", "0");
            cmd.env("LC_ALL", "C");
            cmd.arg("-C").arg(dir);
            cmd.args(["-c", "core.quotepath=false"]);
            cmd.args(args);

            let out = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
                .await
                .map_err(|_| CmdError::validation("Git 命令执行超时"))?
                .map_err(|e| CmdError::validation(format!("无法启动 git（请确认本机已安装 Git）: {e}")))?;

            Ok(CmdOutput {
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                code: out.status.code().unwrap_or(-1),
            })
        }
        GitTarget::Wsl { distro, path } => {
            let dir = cwd_override.unwrap_or(path.as_str());
            let mut cmd = Command::new("wsl.exe");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.args([
                "-d",
                distro.as_str(),
                "--",
                "env",
                "GIT_TERMINAL_PROMPT=0",
                "LC_ALL=C",
                "git",
                "-C",
                dir,
                "-c",
                "core.quotepath=false",
            ]);
            cmd.args(args);

            let out = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
                .await
                .map_err(|_| CmdError::validation("WSL Git 命令执行超时"))?
                .map_err(|e| CmdError::validation(format!("无法调用 WSL 执行 git: {e}")))?;

            Ok(CmdOutput {
                stdout: decode_output(&out.stdout),
                stderr: decode_output(&out.stderr),
                code: out.status.code().unwrap_or(-1),
            })
        }
        GitTarget::Remote {
            session_id, path, ..
        } => {
            let dir = cwd_override.unwrap_or(path.as_str());
            let mut inner = vec![
                "GIT_TERMINAL_PROMPT=0".to_string(),
                "LC_ALL=C".to_string(),
                "git".to_string(),
                "-C".to_string(),
                shell_quote_posix(dir),
                "-c".to_string(),
                "core.quotepath=false".to_string(),
            ];
            for a in args {
                inner.push(shell_quote_posix(a));
            }
            // 使用 POSIX sh -c 包装，避免远程用户默认登录 shell 为 fish / tcsh 时环境变量写法不兼容
            let full = format!("sh -c {}", shell_quote_posix(&inner.join(" ")));
            let (stdout, stderr, code) = exec_capture(
                &state.sessions,
                *session_id,
                &full,
                Duration::from_secs(timeout_secs),
            )
            .await
            .map_err(CmdError::validation)?;

            Ok(CmdOutput {
                stdout,
                stderr,
                code,
            })
        }
    }
}


pub(super) fn validate_hex_hash<'a>(hash: &'a str, label: &str) -> Result<&'a str, CmdError> {
    let clean = hash.trim();
    if clean.len() < 4 || clean.len() > 64 || !clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CmdError::validation(format!("无效的{label}")));
    }
    Ok(clean)
}

pub(super) fn sanitize_rel_repo_path(path: &str) -> Result<String, CmdError> {
    let clean = path.trim().replace('\\', "/").trim_start_matches('/').to_string();
    if clean.is_empty() || clean.starts_with('-') || clean.contains('\0') {
        return Err(CmdError::validation("无效的仓库相对文件路径"));
    }
    Ok(clean)
}


pub(super) fn check_git_success(out: CmdOutput, action: &str) -> Result<CmdOutput, CmdError> {
    if out.code == 0 {
        Ok(out)
    } else {
        let msg = out.stderr.trim();
        let alt = out.stdout.trim();
        let detail = if !msg.is_empty() { msg } else { alt };
        Err(CmdError::validation(if detail.is_empty() {
            format!("{action}失败")
        } else {
            format!("{action}失败: {detail}")
        }))
    }
}

pub(super) fn validate_ref_name(name: &str, what: &str) -> Result<String, CmdError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.contains('\0') {
        return Err(CmdError::validation(format!("无效的{what}名称")));
    }
    Ok(trimmed.to_string())
}

