//! 远程语言智能基础（路线图 M6，§06）。
//! - 语言服务器检测：可执行路径 / 版本 / 架构（§6.6：不静默安装，缺失则降级提示）
//! - 工程识别：ROS 2 / CMake / Python 工作区与 compile_commands.json 指纹（§6.3/§6.5）
//!
//! LSP JSON-RPC 的 stdio 传输（exec 无 PTY）在 §6.4 的 Spike 中冻结方案后接入。

use serde::Serialize;
use uuid::Uuid;

use crate::app_services::ssh_sessions::SessionManager;
use crate::app_services::terminal::exec_capture;

const DETECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerInfo {
    pub language: String,
    pub server: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub arch: Option<String>,
    pub available: bool,
}

/// 版本输出首行（clangd：`clangd version 18.1.3`；pyright：`pyright 1.1.3xx`）
fn first_meaningful_line(text: &str) -> Option<String> {
    text.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(120).collect())
}

/// 检测目标设备上预装的语言服务器（§6.6：不得联网下载）
pub async fn detect_servers(
    sessions: &SessionManager,
    session_id: Uuid,
) -> Result<Vec<LspServerInfo>, String> {
    let mut out = Vec::new();
    for (language, server) in [("c/cpp", "clangd"), ("python", "pyright-langserver"), ("python", "pylsp")] {
        let (path_out, _, code) = exec_capture(
            sessions,
            session_id,
            &format!("command -v {server} || true"),
            DETECT_TIMEOUT,
        )
        .await?;
        let path = path_out.trim().to_string();
        let available = code == 0 && !path.is_empty();
        let version = if available {
            let (vout, _, _) = exec_capture(
                sessions,
                session_id,
                &format!("{server} --version"),
                DETECT_TIMEOUT,
            )
            .await?;
            first_meaningful_line(&vout)
        } else {
            None
        };
        let arch = if available {
            let (arch_out, _, _) = exec_capture(sessions, session_id, "uname -m", DETECT_TIMEOUT)
                .await
                .unwrap_or_default();
            let a = arch_out.trim().to_string();
            (!a.is_empty()).then_some(a)
        } else {
            None
        };
        out.push(LspServerInfo {
            language: language.to_string(),
            server: server.to_string(),
            path: available.then_some(path),
            version,
            arch,
            available,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub workspace_root: String,
    pub kind: String, // ros2 | cmake | python | unknown
    pub details: Vec<String>,
    /// compile_commands.json 是否存在（clangd 必需，§6.3）
    pub has_compile_commands: bool,
    /// compile_commands.json 摘要指纹（sha256 前 16 位；缓存键组成部分 §6.5）
    pub compile_db_fingerprint: Option<String>,
}

/// 识别远程工程结构（只读探测，不执行构建脚本 §3.2 Project Service 边界）
pub async fn detect_project(
    sessions: &SessionManager,
    session_id: Uuid,
    workspace_root: &str,
) -> Result<ProjectInfo, String> {
    let root = workspace_root.trim().trim_end_matches('/').to_string();
    let mut details = Vec::new();

    let (probe, _, code) = exec_capture(
        sessions,
        session_id,
        &format!(
            "test -d '{root}/src' && ls '{root}/src' | head -50 || true; \
             test -f '{root}/CMakeLists.txt' && echo CMAKE_ROOT || true; \
             test -f '{root}/package.xml' && echo ROS_ROOT || true; \
             test -f '{root}/pyproject.toml' && echo PYPROJECT || true; \
             test -f '{root}/setup.py' && echo SETUP || true; \
             find '{root}/build' -maxdepth 2 -name compile_commands.json 2>/dev/null | head -3; \
             test -f '{root}/compile_commands.json' && echo '{root}/compile_commands.json'"
        ),
        DETECT_TIMEOUT,
    )
    .await?;

    let mut has_compile_commands = false;
    let mut compile_db_path: Option<String> = None;
    let mut kind = "unknown";

    for line in probe.lines() {
        let line = line.trim();
        if line.ends_with("compile_commands.json") {
            has_compile_commands = true;
            compile_db_path = Some(line.to_string());
        } else {
            match line {
                "CMAKE_ROOT" => details.push("CMakeLists.txt（CMake 工程）".into()),
                "ROS_ROOT" => {
                    kind = "ros2";
                    details.push("package.xml（ROS 2 工作区）".into());
                }
                "PYPROJECT" | "SETUP" => {
                    if kind == "unknown" {
                        kind = "python";
                    }
                    details.push("Python 打包配置".into());
                }
                other if !other.is_empty() => details.push(format!("src/{other}")),
                _ => {}
            }
        }
    }
    if code != 0 && details.is_empty() {
        details.push("远程探测未完成（会话异常？）".into());
    }

    // compile_commands 指纹（§6.5 缓存键：device+workspace+clangd_version+compile_db_hash）
    let compile_db_fingerprint = if let Some(path) = compile_db_path {
        let (hash, _, hcode) = exec_capture(
            sessions,
            session_id,
            &format!("sha256sum '{path}' | cut -c1-16"),
            DETECT_TIMEOUT,
        )
        .await
        .unwrap_or_default();
        (hcode == 0).then(|| hash.trim().to_string()).filter(|s| !s.is_empty())
    } else {
        None
    };

    Ok(ProjectInfo {
        workspace_root: root,
        kind: kind.to_string(),
        details,
        has_compile_commands,
        compile_db_fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_extraction() {
        assert_eq!(
            first_meaningful_line("\nclangd version 18.1.3\nFeatures: x"),
            Some("clangd version 18.1.3".into())
        );
        assert_eq!(first_meaningful_line("   "), None);
    }
}
