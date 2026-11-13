//! GitHub Releases 版本检查、带进度下载与无感原地升级 Commands。

mod github;
mod platform;
mod types;

use tauri::ipc::Channel;
use tauri::State;

use crate::AppState;

pub use types::{
    DownloadInstallerResult, UpdateCheckResult, UpdateDownloadProgress, UpdaterDownloadState,
};

#[tauri::command]
pub async fn check_github_update() -> Result<UpdateCheckResult, String> {
    github::check_github_update_impl().await
}

#[tauri::command]
pub async fn download_update_installer(
    app: tauri::AppHandle,
    state: State<'_, UpdaterDownloadState>,
    url: String,
    file_name: String,
    expected_size: Option<u64>,
    expected_digest: Option<String>,
    on_event: Channel<UpdateDownloadProgress>,
) -> Result<DownloadInstallerResult, String> {
    github::download_update_installer_impl(
        app,
        state,
        url,
        file_name,
        expected_size,
        expected_digest,
        on_event,
    )
    .await
}

#[tauri::command]
pub async fn cancel_update_download(state: State<'_, UpdaterDownloadState>) -> Result<bool, String> {
    github::cancel_update_download_impl(state).await
}

#[tauri::command]
pub async fn apply_update_and_restart(
    app: tauri::AppHandle,
    app_state: State<'_, AppState>,
    path: String,
) -> Result<bool, String> {
    platform::apply_update_and_restart_impl(app, app_state, path).await
}

#[tauri::command]
pub async fn open_downloaded_installer(
    app: tauri::AppHandle,
    path: String,
    reveal_only: bool,
) -> Result<(), String> {
    platform::open_downloaded_installer_impl(app, path, reveal_only).await
}

#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    platform::open_external_url_impl(url).await
}

#[cfg(test)]
mod tests {
    use super::github::*;
    #[cfg(unix)]
    use super::platform::sh_quote;
    use super::types::*;

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
                digest: None,
            },
            GithubAsset {
                name: "Glance.IDE_0.2.0_universal.app.tar.gz".into(),
                browser_download_url: "https://example.com/mac-tar".into(),
                size: 110,
                digest: None,
            },
            GithubAsset {
                name: "Glance.IDE_0.2.0_x64_en-US.msi".into(),
                browser_download_url: "https://example.com/msi".into(),
                size: 200,
                digest: None,
            },
            GithubAsset {
                name: "Glance.IDE_0.2.0_x64-setup.exe".into(),
                browser_download_url: "https://example.com/exe".into(),
                size: 300,
                digest: None,
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

    #[test]
    fn validates_github_urls_and_digests() {
        assert!(validate_allowed_github_url(
            "https://github.com/haha-nx/Glance-IDE/releases/download/v0.1.5/app.dmg"
        )
        .is_ok());
        assert!(validate_allowed_github_url("https://github.com/evil/repo/releases/a.dmg").is_err());
        assert!(validate_allowed_github_url(
            "https://github.com/haha-nx/Glance-IDE/releases/../evil"
        )
        .is_err());

        assert_eq!(
            normalize_sha256_digest(Some(&format!("sha256:{}", "A".repeat(64)))).unwrap(),
            Some("a".repeat(64))
        );
        assert!(normalize_sha256_digest(Some("sha256:short")).is_err());

        let hash = "b".repeat(64);
        let sums = format!("# comment\n{hash}  *dist/Glance IDE_0.1.6_universal.app.tar.gz\n");
        assert_eq!(
            parse_sha256_sums_content(&sums, "Glance IDE_0.1.6_universal.app.tar.gz"),
            Some(format!("sha256:{hash}"))
        );
        assert_eq!(
            parse_sha256_sums_content(&sums, "other.dmg"),
            None
        );
    }
}
