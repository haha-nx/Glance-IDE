//! 更新器共享 DTO、下载取消状态与平台通用辅助。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

pub(super) const GITHUB_RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/haha-nx/Glance-IDE/releases/latest";

#[cfg(target_os = "windows")]
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GithubAsset {
    pub(super) name: String,
    pub(super) browser_download_url: String,
    pub(super) size: u64,
    #[serde(default)]
    pub(super) digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GithubRelease {
    pub(super) tag_name: String,
    #[serde(default)]
    pub(super) name: String,
    #[serde(default)]
    pub(super) body: String,
    #[serde(default)]
    pub(super) html_url: String,
    #[serde(default)]
    pub(super) published_at: String,
    #[serde(default)]
    pub(super) prerelease: bool,
    #[serde(default)]
    pub(super) draft: bool,
    #[serde(default)]
    pub(super) assets: Vec<GithubAsset>,
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
    pub asset_digest: Option<String>,
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
    pub(super) active_cancel: StdMutex<Option<Arc<AtomicBool>>>,
}

pub(super) struct DownloadSlotGuard<'a> {
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
    pub(super) fn begin(&self) -> (Arc<AtomicBool>, DownloadSlotGuard<'_>) {
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

    pub(super) fn cancel(&self) -> bool {
        if let Ok(slot) = self.active_cancel.lock() {
            if let Some(flag) = slot.as_ref() {
                flag.store(true, Ordering::Relaxed);
                return true;
            }
        }
        false
    }
}

pub(super) fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub(super) fn curl_bin() -> &'static str {
    if cfg!(target_os = "windows") {
        "curl.exe"
    } else {
        "curl"
    }
}

pub(super) fn configure_background_cmd(_cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    _cmd.creation_flags(CREATE_NO_WINDOW);
}

