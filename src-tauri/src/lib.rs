//! Glance IDE 应用入口库（目录结构）。
//! 模块边界：commands（薄层）→ filesystem / ssh / storage / app_services（领域层）。

pub mod app_services;
pub mod commands;
pub mod filesystem;
pub mod logging;
pub mod ssh;
pub mod storage;

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::{Emitter, EventTarget};
use uuid::Uuid;

use commands::ssh::PendingKeyMap;
use filesystem::FileSystemProvider;
use storage::database::Database;
use storage::secret_store::{KeyringStore, SecretStore};

pub struct AppState {
    pub db: Database,
    pub fs: Arc<dyn FileSystemProvider>,
    pub secrets: Box<dyn SecretStore>,
    /// 运行时 SSH 会话（权威状态在 Rust 侧）
    pub sessions: app_services::ssh_sessions::SessionManager,
    /// PTY 终端通道注册表（M4）
    pub terminals: Arc<app_services::terminal::TerminalRegistry>,
    /// LSP 通道注册表（M6）
    pub lsp: Arc<app_services::lsp::LspRegistry>,
    /// 文件传输任务注册表
    pub transfers: Arc<app_services::transfer::TransferRegistry>,
    /// 等待用户确认的握手观测密钥（fingerprint → 观测记录），
    /// 在 approve_identity 时消费用于持久化公钥 blob
    pub pending_keys: StdMutex<PendingKeyMap>,
    /// 各窗口当前关联的远程设备身份 UUID（window_label → device_identity_id）
    pub window_devices: StdMutex<HashMap<String, Option<Uuid>>>,
    /// 发起 SSH 连接的窗口标签（session_id → window_label），当无远程工作区窗口时作为掉线提示兜底
    pub session_windows: StdMutex<HashMap<Uuid, String>>,
    /// 最近获得焦点的窗口标签（用于 macOS 原生菜单与多窗口掉线提示路由）
    pub last_focused_window: StdMutex<Option<String>>,
}

impl AppState {
    fn new(db: Database, fs: Arc<dyn FileSystemProvider>, secrets: Box<dyn SecretStore>) -> Self {
        Self {
            db,
            fs,
            secrets,
            sessions: Default::default(),
            terminals: Default::default(),
            lsp: Default::default(),
            transfers: Default::default(),
            pending_keys: StdMutex::new(HashMap::new()),
            window_devices: StdMutex::new(HashMap::new()),
            session_windows: StdMutex::new(HashMap::new()),
            last_focused_window: StdMutex::new(None),
        }
    }
}

#[cfg(target_os = "macos")]
fn resolve_menu_target_window(app: &tauri::AppHandle) -> Option<String> {
    if let Some(win) = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
    {
        return Some(win.label().to_string());
    }
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(last) = state.last_focused_window.lock().unwrap().clone() {
            if app.get_webview_window(&last).is_some() {
                return Some(last);
            }
        }
    }
    if app.get_webview_window("main").is_some() {
        return Some("main".to_string());
    }
    app.webview_windows().keys().next().cloned()
}

/// 在退出或更新重启前清理活跃传输、终端、LSP 与 SSH 会话（异步等待，设总超时避免卡死退出）。
pub async fn shutdown_runtime_sessions_async(state: &AppState) {
    state.transfers.cancel_all();
    app_services::terminal::close_all(&state.terminals).await;
    app_services::lsp::close_all(&state.lsp);
    let entries = state.sessions.list();
    if entries.is_empty() {
        return;
    }
    let _ = tokio::time::timeout(std::time::Duration::from_millis(1500), async move {
        let mut set = tokio::task::JoinSet::new();
        for entry in entries {
            let sid = entry.session_id;
            let mgr = state.sessions.clone();
            set.spawn(async move {
                let _ = mgr.disconnect(&sid).await;
            });
        }
        while set.join_next().await.is_some() {}
    })
    .await;
}

/// 同步事件上下文下的会话回收（如最后一个窗口 Destroyed 事件）
pub fn shutdown_runtime_sessions(state: &AppState) {
    state.transfers.cancel_all();
    let terminals = state.terminals.clone();
    let sessions = state.sessions.clone();
    app_services::lsp::close_all(&state.lsp);
    tauri::async_runtime::spawn(async move {
        app_services::terminal::close_all(&terminals).await;
        let _ = tokio::time::timeout(std::time::Duration::from_millis(1500), async move {
            let mut set = tokio::task::JoinSet::new();
            for entry in sessions.list() {
                let mgr = sessions.clone();
                set.spawn(async move {
                    let _ = mgr.disconnect(&entry.session_id).await;
                });
            }
            while set.join_next().await.is_some() {}
        })
        .await;
    });
}

/// 发现服务状态（独立 manage，避免污染 AppState）
pub struct DiscoveryHandles;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let log_dir = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| data_dir.join("logs"));
            logging::init(&log_dir);

            let db = Database::open(&data_dir.join("glance.db"))
                .map_err(|e| std::io::Error::other(format!("数据库初始化失败: {e}")))?;
            log::info!("数据库已就绪: {}", data_dir.join("glance.db").display());

            app.manage(AppState::new(
                db,
                Arc::new(filesystem::local::LocalFileSystem::new()),
                Box::new(KeyringStore::default()),
            ));
            app.manage(commands::discovery::DiscoveryState::default());
            app.manage(commands::updater::UpdaterDownloadState::default());

            // macOS 使用系统顶部全局原生菜单栏（AppKit 规范）；Windows 使用与 VS Code 一致的单行自定义暗色标题栏
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{
                    Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
                };

                // AppKit 约定：主菜单的第一个子菜单即「应用菜单」，标题会被系统替换为进程名。
                // 因此必须单独构造它，不能把「文件」放在首位（否则「文件」菜单整体消失）。
                let app_about = PredefinedMenuItem::about(app, Some("关于 Glance IDE"), None)?;
                let app_services = PredefinedMenuItem::services(app, Some("服务"))?;
                let app_hide = PredefinedMenuItem::hide(app, Some("隐藏 Glance IDE"))?;
                let app_hide_others = PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?;
                let app_show_all = PredefinedMenuItem::show_all(app, Some("全部显示"))?;
                // 不用 PredefinedMenuItem::quit：它会直接 terminate，绕过前端未保存文件确认。
                // 改为自定义项，交给前端复用关闭守卫后再退出。
                let app_quit =
                    MenuItem::with_id(app, "quit", "退出 Glance IDE", true, Some("CmdOrCtrl+Q"))?;
                let app_sep1 = PredefinedMenuItem::separator(app)?;
                let app_sep2 = PredefinedMenuItem::separator(app)?;
                let app_sep3 = PredefinedMenuItem::separator(app)?;
                let app_menu = Submenu::with_items(
                    app,
                    "Glance IDE",
                    true,
                    &[
                        &app_about,
                        &app_sep1,
                        &app_services,
                        &app_sep2,
                        &app_hide,
                        &app_hide_others,
                        &app_show_all,
                        &app_sep3,
                        &app_quit,
                    ],
                )?;

                let new_file =
                    MenuItem::with_id(app, "new_file", "新建文件", true, Some("CmdOrCtrl+N"))?;
                let new_folder = MenuItem::with_id(app, "new_folder", "新建文件夹", true, None::<&str>)?;
                let new_window =
                    MenuItem::with_id(app, "new_window", "新建窗口", true, Some("CmdOrCtrl+Shift+N"))?;
                let open_folder =
                    MenuItem::with_id(app, "open_folder", "打开文件夹", true, Some("CmdOrCtrl+Shift+O"))?;
                let open_file =
                    MenuItem::with_id(app, "open_file", "打开文件", true, Some("CmdOrCtrl+O"))?;
                let save = MenuItem::with_id(app, "save", "保存", true, Some("CmdOrCtrl+S"))?;
                let save_all =
                    MenuItem::with_id(app, "save_all", "全部保存", true, Some("CmdOrCtrl+Alt+S"))?;
                let settings =
                    MenuItem::with_id(app, "settings", "设置", true, Some("CmdOrCtrl+,"))?;
                let close_window = PredefinedMenuItem::close_window(app, None::<&str>)?;
                let file_sep1 = PredefinedMenuItem::separator(app)?;
                let file_sep2 = PredefinedMenuItem::separator(app)?;
                let file_sep3 = PredefinedMenuItem::separator(app)?;
                let file_sep4 = PredefinedMenuItem::separator(app)?;
                let file_menu = Submenu::with_items(
                    app,
                    "文件",
                    true,
                    &[
                        &new_file,
                        &new_folder,
                        &new_window,
                        &file_sep1,
                        &open_folder,
                        &open_file,
                        &file_sep2,
                        &save,
                        &save_all,
                        &file_sep3,
                        &settings,
                        &file_sep4,
                        &close_window,
                    ],
                )?;

                let undo = PredefinedMenuItem::undo(app, Some("撤销"))?;
                let redo = PredefinedMenuItem::redo(app, Some("重做"))?;
                let sep1 = PredefinedMenuItem::separator(app)?;
                let cut = PredefinedMenuItem::cut(app, Some("剪切"))?;
                let copy = PredefinedMenuItem::copy(app, Some("拷贝"))?;
                let paste = PredefinedMenuItem::paste(app, Some("粘贴"))?;
                let sep2 = PredefinedMenuItem::separator(app)?;
                let select_all = PredefinedMenuItem::select_all(app, Some("全选"))?;
                let edit_menu = Submenu::with_items(
                    app,
                    "编辑",
                    true,
                    &[&undo, &redo, &sep1, &cut, &copy, &paste, &sep2, &select_all],
                )?;

                let view_explorer = MenuItem::with_id(
                    app,
                    "panel_explorer",
                    "资源管理器",
                    true,
                    Some("CmdOrCtrl+Shift+E"),
                )?;
                let view_search = MenuItem::with_id(
                    app,
                    "panel_search",
                    "全局搜索",
                    true,
                    Some("CmdOrCtrl+Shift+F"),
                )?;
                let view_git = MenuItem::with_id(
                    app,
                    "panel_git",
                    "源代码管理",
                    true,
                    Some("CmdOrCtrl+Shift+G"),
                )?;
                let view_remote = MenuItem::with_id(
                    app,
                    "panel_remote",
                    "远程连接",
                    true,
                    Some("CmdOrCtrl+Shift+R"),
                )?;
                let view_discovery =
                    MenuItem::with_id(app, "panel_discovery", "局域网发现", true, None::<&str>)?;
                let view_terminal = MenuItem::with_id(
                    app,
                    "toggle_terminal",
                    "切换底部终端",
                    true,
                    Some("CmdOrCtrl+`"),
                )?;
                let view_fullscreen = PredefinedMenuItem::fullscreen(app, Some("切换全屏"))?;
                let view_sep1 = PredefinedMenuItem::separator(app)?;
                let view_sep2 = PredefinedMenuItem::separator(app)?;
                let view_menu = Submenu::with_items(
                    app,
                    "查看",
                    true,
                    &[
                        &view_explorer,
                        &view_search,
                        &view_git,
                        &view_remote,
                        &view_discovery,
                        &view_sep1,
                        &view_terminal,
                        &view_sep2,
                        &view_fullscreen,
                    ],
                )?;

                // 终端菜单：AppKit 顶层菜单项必须带子菜单（无子菜单的项不会显示），
                // 因此这里保留下拉，但只放「新建终端」一项，点开即可直接新建终端
                let term_new = MenuItem::with_id(
                    app,
                    "new_terminal",
                    "新建终端",
                    true,
                    Some("CmdOrCtrl+Shift+`"),
                )?;
                let term_menu = Submenu::with_items(app, "终端", true, &[&term_new])?;

                let minimize = PredefinedMenuItem::minimize(app, None::<&str>)?;
                let zoom = PredefinedMenuItem::maximize(app, Some("缩放"))?;
                let bring_all = PredefinedMenuItem::bring_all_to_front(app, Some("全部置前"))?;
                let window_sep = PredefinedMenuItem::separator(app)?;
                // 使用原生窗口菜单 ID，AppKit 才会接管「全部置前」等窗口列表行为
                let window_menu = Submenu::with_id_and_items(
                    app,
                    WINDOW_SUBMENU_ID,
                    "窗口",
                    true,
                    &[&minimize, &zoom, &window_sep, &bring_all],
                )?;

                let repo = MenuItem::with_id(app, "github_repo", "GitHub 仓库", true, None::<&str>)?;
                // 使用原生帮助菜单 ID，系统会提供帮助搜索框
                let help_menu =
                    Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "帮助", true, &[&repo])?;

                let menu = Menu::with_items(
                    app,
                    &[
                        &app_menu,
                        &file_menu,
                        &edit_menu,
                        &view_menu,
                        &term_menu,
                        &window_menu,
                        &help_menu,
                    ],
                )?;
                let _ = app.set_menu(menu);

                app.on_menu_event(|app, event| {
                    let Some(target_label) = resolve_menu_target_window(app) else {
                        return;
                    };
                    let target = EventTarget::webview_window(target_label);
                    match event.id().as_ref() {
                        // 保持既有事件名，编辑器区按当前窗口监听
                        "open_folder" => {
                            let _ = app.emit_to(target, "menu:open-folder", ());
                        }
                        "open_file" => {
                            let _ = app.emit_to(target, "menu:open-file", ());
                        }
                        "settings" => {
                            let _ = app.emit_to(target, "menu:settings", ());
                        }
                        // 其余菜单项统一走 menu:command，仅派发给当前焦点窗口
                        id => {
                            let _ = app.emit_to(target, "menu:command", id);
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::get_app_info,
            commands::app::exit_app,
            commands::app::close_window,
            commands::app::open_new_window,
            // 版本检测与更新
            commands::updater::check_github_update,
            commands::updater::download_update_installer,
            commands::updater::cancel_update_download,
            commands::updater::apply_update_and_restart,
            commands::updater::open_downloaded_installer,
            commands::updater::open_external_url,
            // 文件系统与文件传输
            commands::fs::list_dir,
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::create_dir,
            commands::fs::create_file,
            commands::fs::rename_entry,
            commands::fs::delete_entry,
            commands::transfer::check_transfer_conflicts,
            commands::transfer::upload_to_workspace,
            commands::transfer::download_from_workspace,
            commands::transfer::cancel_transfer,
            commands::transfer::reveal_local_path,
            // SSH 连接配置与设备池（M2）
            commands::ssh::list_profiles,
            commands::ssh::create_profile,
            commands::ssh::update_profile,
            commands::ssh::delete_profile,
            commands::ssh::approve_identity,
            commands::ssh::unbind_identity,
            commands::ssh::connect_profile,
            commands::ssh::list_sessions,
            commands::ssh::disconnect_session,
            commands::ssh::remote_home,
            commands::ssh::set_window_remote_device,
            // WSL 功能
            commands::wsl::wsl_is_available,
            commands::wsl::wsl_list_distros,
            commands::wsl::wsl_distro_home,
            commands::wsl::wsl_run_task,
            // 搜索与界面状态（M1）
            commands::workspace::search_workspace,
            commands::workspace::get_ui_state,
            commands::workspace::set_ui_state,
            // 远程语言智能（M6 基础）
            commands::lsp::lsp_detect,
            commands::lsp::project_detect,
            commands::lsp::lsp_open,
            commands::lsp::lsp_send,
            commands::lsp::lsp_close,
            // 局域网发现（M5）
            commands::discovery::discovery_interfaces,
            commands::discovery::discovery_default_route,
            commands::discovery::discovery_scan,
            commands::discovery::discovery_cancel,
            commands::discovery::discovery_mdns_start,
            commands::discovery::discovery_mdns_cancel,
            // 终端与构建任务（M4）
            commands::terminal::terminal_open,
            commands::terminal::terminal_open_local,
            commands::terminal::terminal_open_wsl,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_device,
            commands::terminal::run_remote_task,
            // Git 与工作树（Worktrees）
            commands::git::git_overview,
            commands::git::git_commit_files,
            commands::git::git_file_diff,
            commands::git::git_init,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_discard,
            commands::git::git_discard_all,
            commands::git::git_commit,
            commands::git::git_checkout,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_fetch,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_worktree_prune,
        ])
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            match event {
                tauri::WindowEvent::Focused(true) => {
                    if let Some(state) = window.try_state::<AppState>() {
                        *state.last_focused_window.lock().unwrap() = Some(label);
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if let Some(state) = window.try_state::<AppState>() {
                        state.window_devices.lock().unwrap().remove(&label);
                        {
                            let mut last = state.last_focused_window.lock().unwrap();
                            if last.as_deref() == Some(label.as_str()) {
                                *last = None;
                            }
                        }
                        // 仅在最后一个窗口销毁时回收全部 SSH/终端/LSP 会话（先关主窗口不误杀副窗口）
                        let is_last_window = window
                            .app_handle()
                            .webview_windows()
                            .keys()
                            .all(|k| k == &label);
                        if is_last_window {
                            shutdown_runtime_sessions(&state);
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("Glance IDE 运行出错");
}
