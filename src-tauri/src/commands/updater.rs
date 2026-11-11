//! GitHub Releases 版本检查与安装包下载 Commands。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::process::Command;

const GITHUB_RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/haha-nx/Glance-IDE/releases/latest";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_name: String,
    pub release_notes: String,
    pub release_url: String,
    pub published_at: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub asset_size: Option<u64>,
    pub platform: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInstallerResult {
    pub saved_path: String,
    pub size: u64,
    pub already_existed: bool,
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn curl_bin() -> &'static str {
    if cfg!(target_os = "windows") {
        "curl.exe"
    } else {
        "curl"
    }
}

fn configure_background_cmd(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// 解析类似 `v0.1.2` 或 `0.1.2-beta.1` 的版本号为主次修数字元组与是否预发布。
fn parse_semver(raw: &str) -> Option<((u64, u64, u64), Option<String>)> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    if trimmed.is_empty() {
        return None;
    }
    let (core, pre) = match trimmed.split_once('-') {
        Some((c, p)) => (c, Some(p.to_string())),
        None => (trimmed, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    Some(((major, minor, patch), pre))
}

/// 比较远端版本是否严格高于当前版本。
pub fn is_newer_version(latest: &str, current: &str) -> bool {
    match (parse_semver(latest), parse_semver(current)) {
        (Some((l_core, l_pre)), Some((c_core, c_pre))) => {
            if l_core != c_core {
                return l_core > c_core;
            }
            // 同核心版本号下，正式版 (None) 高于预发布版 (Some)
            match (l_pre, c_pre) {
                (None, Some(_)) => true,
                (Some(lp), Some(cp)) => lp > cp,
                _ => false,
            }
        }
        _ => latest.trim() != current.trim(),
    }
}

/// 根据目标平台挑选最合适的安装包资产。
fn pick_platform_asset<'a>(assets: &'a [GithubAsset], platform: &str) -> Option<&'a GithubAsset> {
    let lower_matches = |pred: &dyn Fn(&str) -> bool| -> Option<&'a GithubAsset> {
        assets.iter().find(|a| pred(&a.name.to_ascii_lowercase()))
    };

    match platform {
        "windows" => lower_matches(&|n| n.ends_with("-setup.exe"))
            .or_else(|| lower_matches(&|n| n.ends_with(".exe")))
            .or_else(|| lower_matches(&|n| n.ends_with(".msi"))),
        "macos" => lower_matches(&|n| n.ends_with("_universal.dmg"))
            .or_else(|| {
                if cfg!(target_arch = "aarch64") {
                    lower_matches(&|n| n.ends_with(".dmg") && (n.contains("aarch64") || n.contains("arm64")))
                } else {
                    lower_matches(&|n| n.ends_with(".dmg") && (n.contains("x64") || n.contains("x86_64")))
                }
            })
            .or_else(|| lower_matches(&|n| n.ends_with(".dmg"))),
        _ => lower_matches(&|n| n.ends_with(".appimage"))
            .or_else(|| lower_matches(&|n| n.ends_with(".deb")))
            .or_else(|| lower_matches(&|n| n.ends_with(".tar.gz"))),
    }
}

fn sanitize_file_name(raw: &str) -> Result<String, String> {
    let name = Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
    {
        return Err("无效的安装包文件名".into());
    }
    Ok(name)
}

fn validate_allowed_github_url(url: &str) -> Result<(), String> {
    let ok = url.starts_with("https://github.com/haha-nx/Glance-IDE/")
        || url.starts_with("https://objects.githubusercontent.com/")
        || url.starts_with("https://release-assets.githubusercontent.com/");
    if !ok {
        return Err("不允许访问非官方 GitHub 发布来源的 URL".into());
    }
    Ok(())
}

/// 从 GitHub Releases API 检测最新版本。
#[tauri::command]
pub async fn check_github_update() -> Result<UpdateCheckResult, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let user_agent = format!("Glance-IDE/{current}");

    let mut cmd = Command::new(curl_bin());
    configure_background_cmd(&mut cmd);
    cmd.args([
        "-sSL",
        "--connect-timeout",
        "8",
        "--max-time",
        "20",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        &format!("User-Agent: {user_agent}"),
        "-w",
        "\n%{http_code}",
        GITHUB_RELEASES_LATEST_URL,
    ]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("无法执行更新检测网络请求: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "连接 GitHub 检测更新失败，请检查网络连接或代理设置".into()
        } else {
            format!("连接 GitHub 检测更新失败: {stderr}")
        });
    }

    let full = String::from_utf8_lossy(&output.stdout);
    let (body, code_str) = full
        .rsplit_once('\n')
        .unwrap_or((full.as_ref(), "0"));
    let status_code = code_str.trim().parse::<u16>().unwrap_or(0);

    if status_code == 404 {
        return Err("GitHub 仓库尚无已发布的 Release 版本".into());
    }
    if !(200..300).contains(&status_code) {
        let api_msg = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from));
        return Err(match api_msg {
            Some(m) => format!("GitHub 接口返回异常 ({status_code}): {m}"),
            None => format!("GitHub 接口返回异常状态码 ({status_code})"),
        });
    }

    let release: GithubRelease = serde_json::from_str(body)
        .map_err(|e| format!("解析 GitHub Release 数据失败: {e}"))?;

    if release.draft || release.prerelease {
        return Ok(UpdateCheckResult {
            current_version: current.clone(),
            latest_version: current,
            has_update: false,
            release_name: release.name,
            release_notes: release.body,
            release_url: release.html_url,
            published_at: release.published_at,
            asset_name: None,
            asset_url: None,
            asset_size: None,
            platform: current_platform().to_string(),
        });
    }

    let latest_clean = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    let has_update = is_newer_version(&release.tag_name, &current);
    let platform = current_platform();
    let asset = pick_platform_asset(&release.assets, platform);

    Ok(UpdateCheckResult {
        current_version: current,
        latest_version: if latest_clean.is_empty() {
            release.tag_name.clone()
        } else {
            latest_clean
        },
        has_update,
        release_name: if release.name.is_empty() {
            release.tag_name.clone()
        } else {
            release.name
        },
        release_notes: release.body,
        release_url: release.html_url,
        published_at: release.published_at,
        asset_name: asset.map(|a| a.name.clone()),
        asset_url: asset.map(|a| a.browser_download_url.clone()),
        asset_size: asset.map(|a| a.size),
        platform: platform.to_string(),
    })
}

fn resolve_download_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .download_dir()
        .ok()
        .or_else(dirs::download_dir)
        .unwrap_or_else(std::env::temp_dir)
}

/// 下载安装包到本地下载目录（原子临时文件落盘）。
#[tauri::command]
pub async fn download_update_installer(
    app: tauri::AppHandle,
    url: String,
    file_name: String,
    expected_size: Option<u64>,
) -> Result<DownloadInstallerResult, String> {
    validate_allowed_github_url(&url)?;
    let safe_name = sanitize_file_name(&file_name)?;
    let dir = resolve_download_dir(&app);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("无法访问下载目录: {e}"))?;

    let target = dir.join(&safe_name);
    if let (Ok(meta), Some(exp)) = (tokio::fs::metadata(&target).await, expected_size) {
        if meta.len() == exp && exp > 0 {
            return Ok(DownloadInstallerResult {
                saved_path: target.to_string_lossy().to_string(),
                size: exp,
                already_existed: true,
            });
        }
    }

    let part = dir.join(format!("{safe_name}.download.part"));
    let _ = tokio::fs::remove_file(&part).await;

    let user_agent = format!("Glance-IDE/{}", env!("CARGO_PKG_VERSION"));
    let mut cmd = Command::new(curl_bin());
    configure_background_cmd(&mut cmd);
    cmd.args([
        "-fSL",
        "--connect-timeout",
        "10",
        "--max-time",
        "600",
        "-H",
        &format!("User-Agent: {user_agent}"),
        "-o",
    ]);
    cmd.arg(&part);
    cmd.arg(&url);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("无法启动安装包下载进程: {e}"))?;

    if !output.status.success() {
        let _ = tokio::fs::remove_file(&part).await;
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "下载安装包失败，请检查网络连接".into()
        } else {
            format!("下载安装包失败: {stderr}")
        });
    }

    let meta = tokio::fs::metadata(&part)
        .await
        .map_err(|e| format!("读取已下载文件失败: {e}"))?;
    if meta.len() == 0 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("下载的安装包为空文件".into());
    }

    let _ = tokio::fs::remove_file(&target).await;
    tokio::fs::rename(&part, &target)
        .await
        .map_err(|e| format!("保存安装包失败: {e}"))?;

    Ok(DownloadInstallerResult {
        saved_path: target.to_string_lossy().to_string(),
        size: meta.len(),
        already_existed: false,
    })
}

/// 运行已下载的安装包，或在文件管理器中定位该文件。
#[tauri::command]
pub async fn open_downloaded_installer(path: String, reveal_only: bool) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("找不到安装包文件，可能已被移动或删除".into());
    }

    #[cfg(target_os = "windows")]
    {
        if reveal_only {
            let mut cmd = Command::new("explorer.exe");
            cmd.arg(format!("/select,{}", p.display()));
            cmd.spawn()
                .map_err(|e| format!("无法打开文件夹: {e}"))?;
        } else {
            // 使用环境变量传参避免文件名含空格或括号导致的命令行注入
            let mut cmd = Command::new("powershell.exe");
            configure_background_cmd(&mut cmd);
            cmd.env("GLANCE_INSTALLER_PATH", &p);
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Process -FilePath $env:GLANCE_INSTALLER_PATH",
            ]);
            cmd.spawn()
                .map_err(|e| format!("无法启动安装程序: {e}"))?;
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        if reveal_only {
            cmd.arg("-R");
        }
        cmd.arg(&p);
        cmd.spawn()
            .map_err(|e| format!("无法打开安装镜像: {e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let target = if reveal_only {
            p.parent().unwrap_or(&p).to_path_buf()
        } else {
            p
        };
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("无法打开文件: {e}"))?;
        Ok(())
    }
}

/// 使用系统浏览器打开官方 Release 页面。
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    validate_allowed_github_url(&url)?;

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("powershell.exe");
        configure_background_cmd(&mut cmd);
        cmd.env("GLANCE_OPEN_URL", &url);
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Process $env:GLANCE_OPEN_URL",
        ]);
        cmd.spawn()
            .map_err(|e| format!("无法打开浏览器: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("无法打开浏览器: {e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("无法打开浏览器: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_comparison_works() {
        assert!(is_newer_version("v0.2.0", "0.1.0"));
        assert!(is_newer_version("0.1.1", "0.1.0"));
        assert!(is_newer_version("1.0.0", "0.9.9"));
        assert!(is_newer_version("0.2.0", "0.2.0-beta.1"));
        assert!(!is_newer_version("v0.1.0", "0.1.0"));
        assert!(!is_newer_version("0.0.9", "0.1.0"));
    }

    #[test]
    fn platform_asset_selection_prefers_native_installer() {
        let assets = vec![
            GithubAsset {
                name: "Glance.IDE_0.2.0_universal.dmg".into(),
                browser_download_url: "https://example.com/mac".into(),
                size: 100,
            },
            GithubAsset {
                name: "Glance.IDE_0.2.0_x64_en-US.msi".into(),
                browser_download_url: "https://example.com/msi".into(),
                size: 200,
            },
            GithubAsset {
                name: "Glance.IDE_0.2.0_x64-setup.exe".into(),
                browser_download_url: "https://example.com/exe".into(),
                size: 300,
            },
        ];

        assert_eq!(
            pick_platform_asset(&assets, "windows").map(|a| a.name.as_str()),
            Some("Glance.IDE_0.2.0_x64-setup.exe")
        );
        assert_eq!(
            pick_platform_asset(&assets, "macos").map(|a| a.name.as_str()),
            Some("Glance.IDE_0.2.0_universal.dmg")
        );
    }
}
