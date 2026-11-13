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

/// 优雅退出应用：先清理活跃会话再退出，彻底解决 release 包无法关闭或会话残余问题
#[tauri::command]
pub async fn exit_app(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    crate::shutdown_runtime_sessions_async(&state).await;
    app.exit(0);
    Ok(())
}

/// 关闭当前窗口。如果这是最后一个窗口，则先回收会话再彻底退出应用；若还有其他窗口，仅销毁当前窗口
#[tauri::command]
pub async fn close_window(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    use tauri::Manager;
    let count = app.webview_windows().len();
    if count <= 1 {
        crate::shutdown_runtime_sessions_async(&state).await;
        app.exit(0);
    } else {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn url_encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

/// 在新窗口中打开应用（可携带 SSH 配置、WSL 发行版或指定文件夹路径参数）
#[tauri::command]
pub async fn open_new_window(
    app: tauri::AppHandle,
    profile_id: Option<String>,
    wsl_distro: Option<String>,
    folder_path: Option<String>,
) -> Result<(), String> {
    let label = format!("win-{}", uuid::Uuid::new_v4().simple());
    let query = if let Some(folder) = folder_path.filter(|s| !s.trim().is_empty()) {
        format!("?open_folder={}", url_encode_component(&folder))
    } else if let Some(pid) = profile_id {
        format!("?connect_ssh={pid}")
    } else if let Some(distro) = wsl_distro {
        format!("?connect_wsl={distro}")
    } else {
        "?blank=1".to_string()
    };
    let url_str = format!("index.html{query}");
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url_str.into()))
        .title("Glance IDE")
        .inner_size(1360.0, 860.0)
        .min_inner_size(940.0, 600.0);

    // macOS 保留原生窗口框架（红绿灯/圆角/阴影），内容叠加进标题栏；Windows 用无边框自绘标题栏
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    builder
        .build()
        .map_err(|e| format!("打开新窗口失败: {e}"))?;
    Ok(())
}
