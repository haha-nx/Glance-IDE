//! GitHub Releases 版本检查、带进度下载与无感原地升级 Commands。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::app_services::transfer::reveal_local_path_sync;
use crate::AppState;

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
    pub install_mode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInstallerResult {
    pub saved_path: String,
    pub size: u64,
    pub already_existed: bool,
    pub install_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub status: String,
}

/// 更新下载取消控制器
#[derive(Default)]
pub struct UpdaterDownloadState {
    active_cancel: StdMutex<Option<Arc<AtomicBool>>>,
}

struct DownloadSlotGuard<'a> {
    state: &'a UpdaterDownloadState,
    flag: Arc<AtomicBool>,
}

impl Drop for DownloadSlotGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.state.active_cancel.lock() {
            if slot.as_ref().is_some_and(|cur| Arc::ptr_eq(cur, &self.flag)) {
                *slot = None;
            }
        }
    }
}

impl UpdaterDownloadState {
    fn begin(&self) -> (Arc<AtomicBool>, DownloadSlotGuard<'_>) {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut slot) = self.active_cancel.lock() {
            if let Some(prev) = slot.replace(flag.clone()) {
                prev.store(true, Ordering::Relaxed);
            }
        }
        let guard = DownloadSlotGuard {
            state: self,
            flag: flag.clone(),
        };
        (flag, guard)
    }

    fn cancel(&self) -> bool {
        if let Ok(slot) = self.active_cancel.lock() {
            if let Some(flag) = slot.as_ref() {
                flag.store(true, Ordering::Relaxed);
                return true;
            }
        }
        false
    }
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

fn configure_background_cmd(_cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    _cmd.creation_flags(CREATE_NO_WINDOW);
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
            match (l_pre, c_pre) {
                (None, Some(_)) => true,
                (Some(lp), Some(cp)) => lp > cp,
                _ => false,
            }
        }
        _ => latest.trim() != current.trim(),
    }
}

fn macos_arch_matches(lower_name: &str) -> bool {
    if cfg!(target_arch = "aarch64") {
        lower_name.contains("aarch64") || lower_name.contains("arm64")
    } else {
        lower_name.contains("x64") || lower_name.contains("x86_64")
    }
}

fn windows_arch_matches(lower_name: &str) -> bool {
    if cfg!(target_arch = "aarch64") {
        lower_name.contains("arm64") || lower_name.contains("aarch64")
    } else {
        lower_name.contains("x64") || lower_name.contains("x86_64")
    }
}

/// 根据目标平台挑选最合适的更新包资产（macOS 优先 .app.tar.gz 原地替换，Windows 优先 NSIS 静默包）。
fn pick_platform_asset<'a>(assets: &'a [GithubAsset], platform: &str) -> Option<&'a GithubAsset> {
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
            platform: platform.to_string(),
            install_mode: "manual".to_string(),
        });
    }

    let latest_clean = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    let has_update = is_newer_version(&release.tag_name, &current);
    let asset = pick_platform_asset(&release.assets, platform);
    let install_mode = determine_install_mode(platform, asset.map(|a| a.name.as_str())).to_string();

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
        install_mode,
    })
}

fn resolve_update_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .ok()
        .or_else(dirs::cache_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("updates")
}

async fn cleanup_stale_update_cache(cache_dir: &Path, keep_file: &str) {
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
#[tauri::command]
pub async fn download_update_installer(
    app: tauri::AppHandle,
    state: State<'_, UpdaterDownloadState>,
    url: String,
    file_name: String,
    expected_size: Option<u64>,
    on_event: Channel<UpdateDownloadProgress>,
) -> Result<DownloadInstallerResult, String> {
    validate_allowed_github_url(&url)?;
    let safe_name = sanitize_file_name(&file_name)?;
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
#[tauri::command]
pub async fn cancel_update_download(state: State<'_, UpdaterDownloadState>) -> Result<bool, String> {
    Ok(state.cancel())
}

#[cfg(unix)]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn resolve_macos_app_bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法获取当前应用路径: {e}"))?;
    let exe_str = exe.to_string_lossy();
    if exe_str.starts_with("/Volumes/") {
        return Err("当前正从磁盘映像运行，请先将 Glance IDE 拖入「应用程序」文件夹后再执行自动更新".into());
    }
    if exe_str.contains("/AppTranslocation/") {
        return Err("应用当前处于系统随机隔离路径中，请将其移至「应用程序」后重试自动更新".into());
    }
    let Some(app_bundle) = exe
        .ancestors()
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app") && p.join("Contents/MacOS").is_dir())
        .map(Path::to_path_buf)
    else {
        return Err("当前为开发模式构建（非 .app 应用包），无法原地替换更新".into());
    };
    Ok(app_bundle)
}

#[cfg(target_os = "macos")]
async fn find_extracted_app(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 2 {
        return None;
    }
    let mut rd = tokio::fs::read_dir(dir).await.ok()?;
    let mut subdirs = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let p = entry.path();
        if p.is_dir() {
            if p.extension().and_then(|e| e.to_str()) == Some("app")
                && p.join("Contents/MacOS").is_dir()
            {
                return Some(p);
            }
            subdirs.push(p);
        }
    }
    for sub in subdirs {
        if let Some(found) = Box::pin(find_extracted_app(&sub, depth + 1)).await {
            return Some(found);
        }
    }
    None
}

#[cfg(target_os = "macos")]
async fn prepare_macos_in_place_update(
    app: &tauri::AppHandle,
    archive_path: &Path,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let target_app = resolve_macos_app_bundle()?;
    let cache_dir = resolve_update_cache_dir(app);
    let stage_dir = cache_dir.join("staging");
    let _ = tokio::fs::remove_dir_all(&stage_dir).await;
    tokio::fs::create_dir_all(&stage_dir)
        .await
        .map_err(|e| format!("无法创建更新暂存目录: {e}"))?;

    let lower_name = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if lower_name.ends_with(".tar.gz") || lower_name.ends_with(".tgz") {
        let out = Command::new("tar")
            .arg("-xzf")
            .arg(archive_path)
            .arg("-C")
            .arg(&stage_dir)
            .output()
            .await
            .map_err(|e| format!("无法解压更新包: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "解压更新包失败: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    } else if lower_name.ends_with(".zip") {
        let out = Command::new("ditto")
            .arg("-xk")
            .arg(archive_path)
            .arg(&stage_dir)
            .output()
            .await
            .map_err(|e| format!("无法解压更新压缩包: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "解压更新压缩包失败: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    } else if lower_name.ends_with(".dmg") {
        let mnt_dir = cache_dir.join(format!("mnt-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&mnt_dir).await;
        tokio::fs::create_dir_all(&mnt_dir)
            .await
            .map_err(|e| format!("无法创建镜像挂载点: {e}"))?;

        let attach = Command::new("hdiutil")
            .args([
                "attach",
                "-nobrowse",
                "-readonly",
                "-noverify",
                "-noautoopen",
                "-mountpoint",
            ])
            .arg(&mnt_dir)
            .arg(archive_path)
            .output()
            .await
            .map_err(|e| format!("挂载 DMG 失败: {e}"))?;
        if !attach.status.success() {
            let _ = tokio::fs::remove_dir_all(&mnt_dir).await;
            return Err(format!(
                "静默挂载 DMG 失败: {}",
                String::from_utf8_lossy(&attach.stderr).trim()
            ));
        }

        let copy_res = async {
            let found = find_extracted_app(&mnt_dir, 0)
                .await
                .ok_or_else(|| "更新镜像中未找到 .app 应用包".to_string())?;
            let app_name = found
                .file_name()
                .ok_or_else(|| "无法读取更新应用包名称".to_string())?;
            let staged_dest = stage_dir.join(app_name);
            let out = Command::new("ditto")
                .arg(&found)
                .arg(&staged_dest)
                .output()
                .await
                .map_err(|e| format!("复制更新应用包失败: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "复制更新应用包失败: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            Ok(())
        }
        .await;

        let _ = Command::new("hdiutil")
            .arg("detach")
            .arg(&mnt_dir)
            .arg("-force")
            .output()
            .await;
        let _ = tokio::fs::remove_dir_all(&mnt_dir).await;
        copy_res?;
    } else {
        return Err("不支持的 macOS 更新包格式".into());
    }

    let staged_app = find_extracted_app(&stage_dir, 0)
        .await
        .ok_or_else(|| "更新包中未找到有效的 .app 应用结构".to_string())?;
    if !staged_app.join("Contents/Info.plist").is_file() {
        return Err("更新应用包缺少 Info.plist，已中止替换".into());
    }

    let _ = Command::new("xattr")
        .args(["-cr"])
        .arg(&staged_app)
        .output()
        .await;

    let parent_dir = target_app.parent().unwrap_or(Path::new("/Applications"));
    let probe = parent_dir.join(format!(".glance-upd-probe-{}", std::process::id()));
    let parent_writable = match tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&probe)
        .await
    {
        Ok(_) => {
            let _ = tokio::fs::remove_file(&probe).await;
            true
        }
        Err(_) => false,
    };

    let current_pid = std::process::id();
    let current_uid_out = Command::new("id").arg("-u").output().await.ok();
    let console_uid = current_uid_out
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();

    let helper_script = cache_dir.join("apply_update.sh");
    let script_body = format!(
        r#"#!/bin/sh
set -u
OLD_PID={old_pid}
TARGET_APP={target_app}
STAGED_APP={staged_app}
STAGE_DIR={stage_dir}
ARCHIVE_PATH={archive_path}
CONSOLE_UID={console_uid}
BACKUP_APP="${{TARGET_APP}}.backup.$$"

i=0
while [ "$i" -lt 150 ]; do
  if ! kill -0 "$OLD_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
  i=$((i + 1))
done

if [ -e "$TARGET_APP" ]; then
  if ! mv "$TARGET_APP" "$BACKUP_APP"; then
    exit 1
  fi
fi

if ! mv "$STAGED_APP" "$TARGET_APP"; then
  if [ -e "$BACKUP_APP" ]; then
    mv "$BACKUP_APP" "$TARGET_APP" || true
  fi
  exit 1
fi

rm -rf "$BACKUP_APP" "$STAGE_DIR" "$ARCHIVE_PATH" "$0" 2>/dev/null || true
if [ "$(id -u)" = "0" ] && [ -n "$CONSOLE_UID" ] && [ "$CONSOLE_UID" != "0" ]; then
  launchctl asuser "$CONSOLE_UID" open -n "$TARGET_APP" >/dev/null 2>&1 || true
else
  open -n "$TARGET_APP" >/dev/null 2>&1 || open "$TARGET_APP" >/dev/null 2>&1 || true
fi
"#,
        old_pid = current_pid,
        target_app = sh_quote(&target_app.to_string_lossy()),
        staged_app = sh_quote(&staged_app.to_string_lossy()),
        stage_dir = sh_quote(&stage_dir.to_string_lossy()),
        archive_path = sh_quote(&archive_path.to_string_lossy()),
        console_uid = sh_quote(&console_uid),
    );

    tokio::fs::write(&helper_script, script_body)
        .await
        .map_err(|e| format!("无法写入更新脚本: {e}"))?;
    let mut perms = tokio::fs::metadata(&helper_script)
        .await
        .map_err(|e| format!("读取更新脚本权限失败: {e}"))?
        .permissions();
    perms.set_mode(0o700);
    tokio::fs::set_permissions(&helper_script, perms)
        .await
        .map_err(|e| format!("设置更新脚本权限失败: {e}"))?;

    if parent_writable {
        let mut launch = std::process::Command::new("/bin/sh");
        launch.arg("-c").arg(format!(
            "nohup /bin/sh {} </dev/null >/dev/null 2>&1 &",
            sh_quote(&helper_script.to_string_lossy())
        ));
        launch
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        launch
            .spawn()
            .map_err(|e| format!("无法启动后台更新守护脚本: {e}"))?;
    } else {
        // 目标应用目录（如受限 /Applications）需要管理员权限时再弹出原生系统授权一次完成
        let apple_cmd = format!(
            "do shell script {} with administrator privileges",
            format!(
                "\"nohup /bin/sh \" & quoted form of {} & \" </dev/null >/dev/null 2>&1 &\"",
                format!(
                    "\"{}\"",
                    helper_script.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"")
                )
            )
        );
        let auth_out = Command::new("osascript")
            .args(["-e", &apple_cmd])
            .output()
            .await
            .map_err(|e| format!("无法请求管理员授权更新: {e}"))?;
        if !auth_out.status.success() {
            return Err("需要应用目录写入权限才能完成自动替换更新".into());
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn ps_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[cfg(target_os = "windows")]
async fn prepare_windows_silent_update(
    app: &tauri::AppHandle,
    installer_path: &Path,
) -> Result<(), String> {
    let current_exe =
        std::env::current_exe().map_err(|e| format!("无法获取当前应用路径: {e}"))?;
    let install_dir = current_exe
        .parent()
        .ok_or_else(|| "无法获取当前安装目录".to_string())?;
    let cache_dir = resolve_update_cache_dir(app);
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("无法访问更新缓存目录: {e}"))?;

    let is_msi = installer_path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("msi"));

    let ps1_path = cache_dir.join("apply_update.ps1");
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$oldPid = {old_pid}
$installer = {installer}
$installDir = {install_dir}
$currentExe = {current_exe}
$isMsi = {is_msi}

try {{
    Wait-Process -Id $oldPid -Timeout 30 -ErrorAction SilentlyContinue
}} catch {{}}
Start-Sleep -Milliseconds 300

if ($isMsi) {{
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $installer, '/passive', '/norestart') -PassThru -Wait
}} else {{
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $installer
    $psi.Arguments = "/S /D=$installDir"
    $psi.UseShellExecute = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.WaitForExit()
}}

if ($p.ExitCode -eq 0) {{
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $currentExe) {{
        Start-Process -FilePath $currentExe
    }}
}}
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
"#,
        old_pid = std::process::id(),
        installer = ps_single_quote(&installer_path.to_string_lossy()),
        install_dir = ps_single_quote(&install_dir.to_string_lossy()),
        current_exe = ps_single_quote(&current_exe.to_string_lossy()),
        is_msi = if is_msi { "$true" } else { "$false" },
    );

    // 写入 UTF-8 BOM 以确保 PowerShell 5.1 正确识别含中文用户名/安装目录
    let mut bom_bytes = vec![0xEF, 0xBB, 0xBF];
    bom_bytes.extend_from_slice(script.as_bytes());
    tokio::fs::write(&ps1_path, bom_bytes)
        .await
        .map_err(|e| format!("无法写入静默更新脚本: {e}"))?;

    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    cmd.arg(&ps1_path);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn()
        .map_err(|e| format!("无法启动静默更新程序: {e}"))?;

    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn prepare_linux_in_place_update(
    app: &tauri::AppHandle,
    installer_path: &Path,
) -> Result<bool, String> {
    use std::os::unix::fs::PermissionsExt;

    let lower = installer_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let Some(appimage_target) = std::env::var_os("APPIMAGE").map(PathBuf::from) else {
        return Ok(false);
    };
    if !lower.ends_with(".appimage") {
        return Ok(false);
    }

    let cache_dir = resolve_update_cache_dir(app);
    let mut perms = tokio::fs::metadata(installer_path)
        .await
        .map_err(|e| format!("读取更新包权限失败: {e}"))?
        .permissions();
    perms.set_mode(0o755);
    tokio::fs::set_permissions(installer_path, perms)
        .await
        .map_err(|e| format!("设置 AppImage 可执行权限失败: {e}"))?;

    let helper_script = cache_dir.join("apply_update.sh");
    let script = format!(
        r#"#!/bin/sh
set -u
OLD_PID={old_pid}
TARGET={target}
SOURCE={source}

i=0
while [ "$i" -lt 150 ]; do
  if ! kill -0 "$OLD_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
  i=$((i + 1))
done

mv -f "$SOURCE" "$TARGET" && chmod +x "$TARGET"
rm -f "$0" 2>/dev/null || true
nohup "$TARGET" </dev/null >/dev/null 2>&1 &
"#,
        old_pid = std::process::id(),
        target = sh_quote(&appimage_target.to_string_lossy()),
        source = sh_quote(&installer_path.to_string_lossy()),
    );
    tokio::fs::write(&helper_script, script)
        .await
        .map_err(|e| format!("无法写入 Linux 更新脚本: {e}"))?;
    let mut sh_perms = tokio::fs::metadata(&helper_script)
        .await
        .map_err(|e| format!("读取脚本权限失败: {e}"))?
        .permissions();
    sh_perms.set_mode(0o700);
    tokio::fs::set_permissions(&helper_script, sh_perms)
        .await
        .map_err(|e| format!("设置脚本权限失败: {e}"))?;

    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(format!(
            "nohup /bin/sh {} </dev/null >/dev/null 2>&1 &",
            sh_quote(&helper_script.to_string_lossy())
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法启动更新守护脚本: {e}"))?;

    Ok(true)
}

/// 优雅应用更新并重启（macOS 原地替换 .app 并重开；Windows 静默覆盖并重启；非自动格式回退到系统打开）。
/// 返回 `true` 表示正在自动重启；返回 `false` 表示已唤起系统安装器/目录。
#[tauri::command]
pub async fn apply_update_and_restart(
    app: tauri::AppHandle,
    app_state: State<'_, AppState>,
    path: String,
) -> Result<bool, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("找不到已下载的更新包，请重新下载".into());
    }

    let will_restart = {
        #[cfg(target_os = "macos")]
        {
            prepare_macos_in_place_update(&app, &p).await?;
            true
        }
        #[cfg(target_os = "windows")]
        {
            prepare_windows_silent_update(&app, &p).await?;
            true
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let handled = prepare_linux_in_place_update(&app, &p).await?;
            if !handled {
                open_downloaded_installer(path, false).await?;
            }
            handled
        }
    };

    if will_restart {
        crate::shutdown_runtime_sessions(&app_state);
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(180)).await;
            app_handle.exit(0);
        });
    }

    Ok(will_restart)
}

/// 运行已下载的安装包，或在文件管理器中定位该文件。
#[tauri::command]
pub async fn open_downloaded_installer(path: String, reveal_only: bool) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("找不到安装包文件，可能已被移动或删除".into());
    }

    if reveal_only {
        return reveal_local_path_sync(&p);
    }

    #[cfg(target_os = "windows")]
    {
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
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("无法打开安装镜像: {e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&p)
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
    fn platform_asset_selection_prefers_in_place_archive_on_macos_and_nsis_on_windows() {
        let assets = vec![
            GithubAsset {
                name: "Glance.IDE_0.2.0_universal.dmg".into(),
                browser_download_url: "https://example.com/mac-dmg".into(),
                size: 100,
            },
            GithubAsset {
                name: "Glance.IDE_0.2.0_universal.app.tar.gz".into(),
                browser_download_url: "https://example.com/mac-tar".into(),
                size: 110,
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
            Some("Glance.IDE_0.2.0_universal.app.tar.gz")
        );
        assert_eq!(
            determine_install_mode("macos", Some("Glance.IDE_0.2.0_universal.app.tar.gz")),
            "in_place_app"
        );
        assert_eq!(
            determine_install_mode("macos", Some("Glance.IDE_0.2.0_universal.dmg")),
            "in_place_app"
        );
        assert_eq!(
            determine_install_mode("windows", Some("Glance.IDE_0.2.0_x64-setup.exe")),
            "silent_installer"
        );
        assert_eq!(
            determine_install_mode("linux", Some("Glance.IDE_0.2.0_amd64.deb")),
            "manual"
        );
    }

    #[cfg(unix)]
    #[test]
    fn sh_quote_escapes_special_characters() {
        assert_eq!(sh_quote("Glance IDE.app"), "'Glance IDE.app'");
        assert_eq!(sh_quote("O'Reilly/$HOME"), "'O'\\''Reilly/$HOME'");
    }
}
