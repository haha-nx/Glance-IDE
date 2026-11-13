//! GitHub Release 检查、版本号比较、摘要校验与流式下载。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::types::*;

/// 解析类似 `v0.1.2` 或 `0.1.2-beta.1` 的版本号为主次修数字元组与是否预发布。
pub(super) fn parse_semver(raw: &str) -> Option<((u64, u64, u64), Option<String>)> {
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
            match (l_pre, c_pre) {
                (None, Some(_)) => true,
                (Some(lp), Some(cp)) => lp > cp,
                _ => false,
            }
        }
        _ => latest.trim() != current.trim(),
    }
}

pub(super) fn macos_arch_matches(lower_name: &str) -> bool {
    if cfg!(target_arch = "aarch64") {
        lower_name.contains("aarch64") || lower_name.contains("arm64")
    } else {
        lower_name.contains("x64") || lower_name.contains("x86_64")
    }
}

pub(super) fn windows_arch_matches(lower_name: &str) -> bool {
    if cfg!(target_arch = "aarch64") {
        lower_name.contains("arm64") || lower_name.contains("aarch64")
    } else {
        lower_name.contains("x64") || lower_name.contains("x86_64")
    }
}

/// 根据目标平台挑选最合适的更新包资产（macOS 优先 .app.tar.gz 原地替换，Windows 优先 NSIS 静默包）。
pub(super) fn pick_platform_asset<'a>(assets: &'a [GithubAsset], platform: &str) -> Option<&'a GithubAsset> {
    let find_match = |pred: &dyn Fn(&str) -> bool| -> Option<&'a GithubAsset> {
        assets.iter().find(|a| pred(&a.name.to_ascii_lowercase()))
    };

    match platform {
        "windows" => find_match(&|n| n.ends_with("-setup.exe") && windows_arch_matches(n))
            .or_else(|| find_match(&|n| n.ends_with("-setup.exe")))
            .or_else(|| find_match(&|n| n.ends_with(".exe")))
            .or_else(|| find_match(&|n| n.ends_with(".msi") && windows_arch_matches(n)))
            .or_else(|| find_match(&|n| n.ends_with(".msi"))),
        "macos" => find_match(&|n| n.ends_with(".app.tar.gz") && n.contains("universal"))
            .or_else(|| find_match(&|n| n.ends_with(".app.tar.gz") && macos_arch_matches(n)))
            .or_else(|| find_match(&|n| n.ends_with(".app.tar.gz")))
            .or_else(|| find_match(&|n| n.ends_with(".app.zip") && n.contains("universal")))
            .or_else(|| find_match(&|n| n.ends_with(".app.zip") && macos_arch_matches(n)))
            .or_else(|| find_match(&|n| n.ends_with(".app.zip")))
            .or_else(|| find_match(&|n| n.ends_with(".dmg") && n.contains("universal")))
            .or_else(|| find_match(&|n| n.ends_with(".dmg") && macos_arch_matches(n)))
            .or_else(|| find_match(&|n| n.ends_with(".dmg"))),
        _ => find_match(&|n| n.ends_with(".appimage"))
            .or_else(|| find_match(&|n| n.ends_with(".deb")))
            .or_else(|| find_match(&|n| n.ends_with(".tar.gz"))),
    }
}

/// 判定给定更新包的安装模式：`in_place_app` | `silent_installer` | `manual`。
pub fn determine_install_mode(platform: &str, asset_name: Option<&str>) -> &'static str {
    let Some(name) = asset_name.map(|s| s.to_ascii_lowercase()) else {
        return "manual";
    };
    match platform {
        "macos" => {
            if name.ends_with(".app.tar.gz")
                || name.ends_with(".app.zip")
                || name.ends_with(".dmg")
            {
                "in_place_app"
            } else {
                "manual"
            }
        }
        "windows" => {
            if name.ends_with(".exe") || name.ends_with(".msi") {
                "silent_installer"
            } else {
                "manual"
            }
        }
        _ => {
            if name.ends_with(".appimage") {
                "in_place_app"
            } else {
                "manual"
            }
        }
    }
}

pub(super) fn sanitize_file_name(raw: &str) -> Result<String, String> {
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

pub(super) fn validate_allowed_github_url(url: &str) -> Result<(), String> {
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) || url.contains("..") {
        return Err("更新 URL 包含非法字符或路径穿越片段".into());
    }
    let ok = url.starts_with("https://github.com/haha-nx/Glance-IDE/releases/")
        || url.starts_with("https://objects.githubusercontent.com/")
        || url.starts_with("https://release-assets.githubusercontent.com/");
    if !ok {
        return Err("不允许访问非官方 GitHub 发布来源的 URL".into());
    }
    Ok(())
}

pub(super) fn normalize_sha256_digest(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let hex = s.strip_prefix("sha256:").unwrap_or(s);
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("更新校验摘要格式无效".into());
    }
    Ok(Some(hex.to_ascii_lowercase()))
}

/// 从 SHA256SUMS.txt 文本中提取指定资产文件名对应的 `sha256:<hex>` 摘要。
pub(super) fn parse_sha256_sums_content(content: &str, asset_name: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.splitn(2, |c: char| c.is_ascii_whitespace());
        let hash = parts.next()?.trim();
        let rest = parts.next()?.trim().trim_start_matches('*');
        let file_base = Path::new(rest)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(rest);
        if file_base == asset_name
            && hash.len() == 64
            && hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Some(format!("sha256:{}", hash.to_ascii_lowercase()));
        }
    }
    None
}

/// 当 Release API 未返回 asset.digest 时，尝试从同版本的 SHA256SUMS.txt 回退获取校验摘要。
pub(super) async fn fetch_sha256_from_sums_asset(
    assets: &[GithubAsset],
    asset_name: &str,
    user_agent: &str,
) -> Option<String> {
    let sums_asset = assets
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case("sha256sums.txt"))?;
    validate_allowed_github_url(&sums_asset.browser_download_url).ok()?;

    let mut cmd = Command::new(curl_bin());
    configure_background_cmd(&mut cmd);
    cmd.args([
        "-fsSL",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--max-redirs",
        "5",
        "--connect-timeout",
        "8",
        "--max-time",
        "15",
        "-H",
        &format!("User-Agent: {user_agent}"),
        &sums_asset.browser_download_url,
    ]);
    let output = cmd.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_sha256_sums_content(&text, asset_name)
}

pub(super) async fn compute_file_sha256(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("读取安装包计算校验失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取安装包字节失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(super) async fn verify_installer_digest(path: &Path, expected_hex: Option<&str>) -> Result<(), String> {
    let Some(expected) = expected_hex else {
        return Ok(());
    };
    let actual = compute_file_sha256(path).await?;
    if actual != expected {
        return Err(format!(
            "安装包 SHA-256 校验失败（期望 {expected}，实际 {actual}）"
        ));
    }
    Ok(())
}

pub(super) fn verify_path_in_update_cache(app: &tauri::AppHandle, raw_path: &str) -> Result<PathBuf, String> {
    let cache_dir = resolve_update_cache_dir(app);
    let canonical_cache = std::fs::canonicalize(&cache_dir)
        .map_err(|_| "更新缓存目录不存在或无权访问，请重新下载更新包".to_string())?;
    let canonical_file = std::fs::canonicalize(Path::new(raw_path))
        .map_err(|_| "找不到已下载的更新包，请重新下载".to_string())?;
    if !canonical_file.starts_with(&canonical_cache) || !canonical_file.is_file() {
        return Err("拒绝操作更新缓存目录之外的文件".into());
    }
    Ok(canonical_file)
}

/// 从 GitHub Releases API 检测最新版本。
pub(super) async fn check_github_update_impl() -> Result<UpdateCheckResult, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let user_agent = format!("Glance-IDE/{current}");

    let mut cmd = Command::new(curl_bin());
    configure_background_cmd(&mut cmd);
    cmd.args([
        "-sSL",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--max-redirs",
        "5",
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

    let platform = current_platform();
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
            asset_digest: None,
            platform: platform.to_string(),
            install_mode: "manual".to_string(),
        });
    }

    let latest_clean = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    let has_update = is_newer_version(&release.tag_name, &current);
    let asset = pick_platform_asset(&release.assets, platform);
    let install_mode = determine_install_mode(platform, asset.map(|a| a.name.as_str())).to_string();
    let asset_digest = match asset {
        Some(selected) => match selected.digest.clone() {
            Some(digest) => Some(digest),
            None => fetch_sha256_from_sums_asset(&release.assets, &selected.name, &user_agent).await,
        },
        None => None,
    };

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
        asset_digest,
        platform: platform.to_string(),
        install_mode,
    })
}

pub(super) fn resolve_update_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .ok()
        .or_else(dirs::cache_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("updates")
}

pub(super) async fn cleanup_stale_update_cache(cache_dir: &Path, keep_file: &str) {
    let Ok(mut rd) = tokio::fs::read_dir(cache_dir).await else {
        return;
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == keep_file {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            let _ = tokio::fs::remove_dir_all(&path).await;
        } else {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
}

/// 下载更新包到应用缓存目录，通过 Channel 实时汇报下载字节数、总大小与速率，支持取消。
pub(super) async fn download_update_installer_impl(
    app: tauri::AppHandle,
    state: State<'_, UpdaterDownloadState>,
    url: String,
    file_name: String,
    expected_size: Option<u64>,
    expected_digest: Option<String>,
    on_event: Channel<UpdateDownloadProgress>,
) -> Result<DownloadInstallerResult, String> {
    validate_allowed_github_url(&url)?;
    let safe_name = sanitize_file_name(&file_name)?;
    let normalized_digest = normalize_sha256_digest(expected_digest.as_deref())?;
    let platform = current_platform();
    let install_mode = determine_install_mode(platform, Some(&safe_name)).to_string();

    let dir = resolve_update_cache_dir(&app);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("无法访问更新缓存目录: {e}"))?;

    cleanup_stale_update_cache(&dir, &safe_name).await;

    let target = dir.join(&safe_name);
    let total_bytes = expected_size.unwrap_or(0);
    if let (Ok(meta), Some(exp)) = (tokio::fs::metadata(&target).await, expected_size) {
        if meta.len() == exp && exp > 0 {
            if verify_installer_digest(&target, normalized_digest.as_deref())
                .await
                .is_ok()
            {
                let _ = on_event.send(UpdateDownloadProgress {
                    downloaded_bytes: exp,
                    total_bytes: exp,
                    speed_bytes_per_sec: 0,
                    status: "completed".into(),
                });
                return Ok(DownloadInstallerResult {
                    saved_path: target.to_string_lossy().to_string(),
                    size: exp,
                    already_existed: true,
                    install_mode,
                });
            }
            let _ = tokio::fs::remove_file(&target).await;
        }
    }

    let part = dir.join(format!("{safe_name}.download.part"));
    let _ = tokio::fs::remove_file(&part).await;

    let (cancel, _slot_guard) = state.begin();
    let user_agent = format!("Glance-IDE/{}", env!("CARGO_PKG_VERSION"));
    let mut cmd = Command::new(curl_bin());
    configure_background_cmd(&mut cmd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    cmd.args([
        "-fSL",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--max-redirs",
        "5",
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

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动更新下载进程: {e}"))?;
    let mut stderr_pipe = child.stderr.take();

    let started_at = Instant::now();
    let _ = on_event.send(UpdateDownloadProgress {
        downloaded_bytes: 0,
        total_bytes,
        speed_bytes_per_sec: 0,
        status: "downloading".into(),
    });

    let exit_status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = tokio::fs::remove_file(&part).await;
            let _ = on_event.send(UpdateDownloadProgress {
                downloaded_bytes: 0,
                total_bytes,
                speed_bytes_per_sec: 0,
                status: "cancelled".into(),
            });
            return Err("已取消更新下载".into());
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                let downloaded = tokio::fs::metadata(&part)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                let elapsed = started_at.elapsed().as_secs_f64();
                let speed = if elapsed > 0.1 {
                    (downloaded as f64 / elapsed) as u64
                } else {
                    0
                };
                let _ = on_event.send(UpdateDownloadProgress {
                    downloaded_bytes: downloaded,
                    total_bytes: total_bytes.max(downloaded),
                    speed_bytes_per_sec: speed,
                    status: "downloading".into(),
                });
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            Err(e) => {
                let _ = child.kill().await;
                let _ = tokio::fs::remove_file(&part).await;
                let _ = on_event.send(UpdateDownloadProgress {
                    downloaded_bytes: 0,
                    total_bytes,
                    speed_bytes_per_sec: 0,
                    status: "failed".into(),
                });
                return Err(format!("监控更新下载状态失败: {e}"));
            }
        }
    };

    if !exit_status.success() {
        let mut stderr_buf = String::new();
        if let Some(mut pipe) = stderr_pipe.take() {
            let _ = pipe.read_to_string(&mut stderr_buf).await;
        }
        let _ = tokio::fs::remove_file(&part).await;
        let _ = on_event.send(UpdateDownloadProgress {
            downloaded_bytes: 0,
            total_bytes,
            speed_bytes_per_sec: 0,
            status: "failed".into(),
        });
        let stderr = stderr_buf.trim();
        return Err(if stderr.is_empty() {
            "下载更新包失败，请检查网络连接".into()
        } else {
            format!("下载更新包失败: {stderr}")
        });
    }

    let meta = tokio::fs::metadata(&part)
        .await
        .map_err(|e| format!("读取已下载更新包失败: {e}"))?;
    if meta.len() == 0 {
        let _ = tokio::fs::remove_file(&part).await;
        let _ = on_event.send(UpdateDownloadProgress {
            downloaded_bytes: 0,
            total_bytes,
            speed_bytes_per_sec: 0,
            status: "failed".into(),
        });
        return Err("下载的更新包为空文件".into());
    }
    if let Some(exp) = expected_size.filter(|s| *s > 0) {
        if meta.len() != exp {
            let _ = tokio::fs::remove_file(&part).await;
            let _ = on_event.send(UpdateDownloadProgress {
                downloaded_bytes: 0,
                total_bytes,
                speed_bytes_per_sec: 0,
                status: "failed".into(),
            });
            return Err(format!(
                "更新包大小不匹配（期望 {exp} 字节，实际 {} 字节），已终止保存",
                meta.len()
            ));
        }
    }
    if let Err(err) = verify_installer_digest(&part, normalized_digest.as_deref()).await {
        let _ = tokio::fs::remove_file(&part).await;
        let _ = on_event.send(UpdateDownloadProgress {
            downloaded_bytes: 0,
            total_bytes,
            speed_bytes_per_sec: 0,
            status: "failed".into(),
        });
        return Err(err);
    }

    let _ = tokio::fs::remove_file(&target).await;
    tokio::fs::rename(&part, &target)
        .await
        .map_err(|e| format!("保存更新包失败: {e}"))?;

    let final_size = meta.len();
    let _ = on_event.send(UpdateDownloadProgress {
        downloaded_bytes: final_size,
        total_bytes: total_bytes.max(final_size),
        speed_bytes_per_sec: 0,
        status: "completed".into(),
    });

    Ok(DownloadInstallerResult {
        saved_path: target.to_string_lossy().to_string(),
        size: final_size,
        already_existed: false,
        install_mode,
    })
}

/// 取消正在进行的更新包下载。
pub(super) async fn cancel_update_download_impl(state: State<'_, UpdaterDownloadState>) -> Result<bool, String> {
    Ok(state.cancel())
}

