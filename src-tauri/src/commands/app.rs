//! 应用信息与生命周期 Commands。

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

#[tauri::command]
pub fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    let package = app.package_info();
    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
    }
}

/// 优雅退出应用，彻底解决 release 包中窗口权限或环境异常导致的无法关闭问题
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 关闭当前窗口。如果这是最后一个窗口，则彻底退出应用；若还有其他窗口，仅销毁当前窗口
#[tauri::command]
pub async fn close_window(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let count = app.webview_windows().len();
    if count <= 1 {
        app.exit(0);
    } else {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 在新窗口中打开应用（可携带 SSH 配置或 WSL 发行版自连参数）
#[tauri::command]
pub async fn open_new_window(
    app: tauri::AppHandle,
    profile_id: Option<String>,
    wsl_distro: Option<String>,
) -> Result<(), String> {
    let label = format!("win-{}", uuid::Uuid::new_v4().simple());
    let query = if let Some(pid) = profile_id {
        format!("?connect_ssh={pid}")
    } else if let Some(distro) = wsl_distro {
        format!("?connect_wsl={distro}")
    } else {
        "?blank=1".to_string()
    };
    let url_str = format!("index.html{query}");
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url_str.into()))
        .title("Glance IDE")
        .inner_size(1360.0, 860.0)
        .min_inner_size(940.0, 600.0)
        .decorations(false)
        .build()
        .map_err(|e| format!("打开新窗口失败: {e}"))?;
    Ok(())
}
