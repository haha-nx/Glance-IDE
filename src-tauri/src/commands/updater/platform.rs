//! 分平台（macOS / Windows / Linux）更新应用、重启与外部浏览器打开逻辑。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tauri::State;
use tokio::process::Command;

use super::github::{
    resolve_update_cache_dir, validate_allowed_github_url, verify_path_in_update_cache,
};
#[cfg(target_os = "windows")]
use super::types::{configure_background_cmd, CREATE_NO_WINDOW};
use crate::app_services::transfer::reveal_local_path_sync;
use crate::AppState;

#[cfg(unix)]
pub(super) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
pub(super) fn resolve_macos_app_bundle() -> Result<PathBuf, String> {
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
pub(super) async fn find_extracted_app(dir: &Path, depth: usize) -> Option<PathBuf> {
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
pub(super) async fn prepare_macos_in_place_update(
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
    let info_plist = staged_app.join("Contents/Info.plist");
    if !info_plist.is_file() || !staged_app.join("Contents/MacOS").is_dir() {
        return Err("更新应用包缺少 Info.plist 或可执行目录，已中止替换".into());
    }

    // 验证 CFBundleIdentifier 匹配 Glance IDE，防止替换为异常包
    let bundle_id_out = Command::new("plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(&info_plist)
        .output()
        .await
        .map_err(|e| format!("无法校验更新应用 Bundle Identifier: {e}"))?;
    let bundle_id = String::from_utf8_lossy(&bundle_id_out.stdout).trim().to_string();
    if !bundle_id_out.status.success() || bundle_id != "com.glance.ide" {
        return Err(format!(
            "更新应用 Bundle Identifier 不匹配（期望 com.glance.ide，实际 {bundle_id}），已中止替换"
        ));
    }

    // 若应用包附带代码签名，验证签名未被破坏（未签名构建跳过，不阻断自签名/开源发布）
    if let Ok(sig_disp) = Command::new("codesign")
        .arg("-d")
        .arg(&staged_app)
        .output()
        .await
    {
        if sig_disp.status.success() {
            let verify_out = Command::new("codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&staged_app)
                .output()
                .await
                .map_err(|e| format!("无法执行更新包签名校验: {e}"))?;
            if !verify_out.status.success() {
                let err_msg = String::from_utf8_lossy(&verify_out.stderr).trim().to_string();
                return Err(format!("更新应用包签名校验失败，已中止替换: {err_msg}"));
            }
        }
    }

    // 仅清除隔离属性，避免误清其它扩展属性
    let _ = Command::new("xattr")
        .args(["-d", "-r", "com.apple.quarantine"])
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
pub(super) fn ps_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[cfg(target_os = "windows")]
pub(super) async fn prepare_windows_silent_update(
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
pub(super) async fn prepare_linux_in_place_update(
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
pub(super) async fn apply_update_and_restart_impl(
    app: tauri::AppHandle,
    app_state: State<'_, AppState>,
    path: String,
) -> Result<bool, String> {
    let p = verify_path_in_update_cache(&app, &path)?;

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
                open_downloaded_installer_impl(app.clone(), path, false).await?;
            }
            handled
        }
    };

    if will_restart {
        crate::shutdown_runtime_sessions_async(&app_state).await;
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            app_handle.exit(0);
        });
    }

    Ok(will_restart)
}

/// 运行已下载的安装包，或在文件管理器中定位该文件（严格限制在更新缓存目录内）。
pub(super) async fn open_downloaded_installer_impl(
    app: tauri::AppHandle,
    path: String,
    reveal_only: bool,
) -> Result<(), String> {
    let p = verify_path_in_update_cache(&app, &path)?;

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
pub(super) async fn open_external_url_impl(url: String) -> Result<(), String> {
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

