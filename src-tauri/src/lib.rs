//! Glance IDE 应用入口库（路线图 §11.1 目录结构）。
//! 模块边界：commands（薄层）→ filesystem / ssh / storage / app_services（领域层）。

pub mod app_services;
pub mod commands;
pub mod filesystem;
pub mod ssh;
pub mod storage;

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use tauri::{Emitter, Manager};

use commands::ssh::PendingKeyMap;
use filesystem::FileSystemProvider;
use storage::database::Database;
use storage::secret_store::{KeyringStore, SecretStore};

pub struct AppState {
    pub db: Database,
    pub fs: Arc<dyn FileSystemProvider>,
    pub secrets: Box<dyn SecretStore>,
    /// 运行时 SSH 会话（权威状态在 Rust 侧，§11.4）
    pub sessions: app_services::ssh_sessions::SessionManager,
    /// PTY 终端通道注册表（M4）
    pub terminals: Arc<app_services::terminal::TerminalRegistry>,
    /// 等待用户确认的握手观测密钥（fingerprint → 观测记录），
    /// 在 approve_identity 时消费用于持久化公钥 blob
    pub pending_keys: StdMutex<PendingKeyMap>,
}

impl AppState {
    fn new(db: Database, fs: Arc<dyn FileSystemProvider>, secrets: Box<dyn SecretStore>) -> Self {
        Self {
            db,
            fs,
            secrets,
            sessions: Default::default(),
            terminals: Default::default(),
            pending_keys: StdMutex::new(HashMap::new()),
        }
    }
}

/// 发现服务状态（独立 manage，避免污染 AppState）
pub struct DiscoveryHandles;


pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Database::open(&data_dir.join("glance.db"))
                .map_err(|e| std::io::Error::other(format!("数据库初始化失败: {e}")))?;
            log::info!("数据库已就绪: {}", data_dir.join("glance.db").display());

            app.manage(AppState::new(
                db,
                Arc::new(filesystem::local::LocalFileSystem::new()),
                Box::new(KeyringStore::default()),
            ));
            app.manage(commands::discovery::DiscoveryState::default());

            // 原生菜单（用户反馈：文件菜单需包含打开文件夹/文件/设置）
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
            let open_folder =
                MenuItem::with_id(app, "open_folder", "打开文件夹…", true, None::<&str>)?;
            let open_file =
                MenuItem::with_id(app, "open_file", "打开文件…", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let close_window = PredefinedMenuItem::close_window(app, None::<&str>)?;
            let file_menu = Submenu::with_items(
                app,
                "文件",
                true,
                &[&open_folder, &open_file, &settings, &close_window],
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

            let minimize = PredefinedMenuItem::minimize(app, None::<&str>)?;
            let window_menu =
                Submenu::with_items(app, "窗口", true, &[&minimize, &close_window])?;

            let about = PredefinedMenuItem::about(app, Some("关于 Glance IDE"), None)?;
            let help_menu = Submenu::with_items(app, "帮助", true, &[&about])?;

            let menu = Menu::with_items(app, &[&file_menu, &edit_menu, &window_menu, &help_menu])?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| match event.id().as_ref() {
                "open_folder" => {
                    let _ = app.emit("menu:open-folder", ());
                }
                "open_file" => {
                    let _ = app.emit("menu:open-file", ());
                }
                "settings" => {
                    let _ = app.emit("menu:settings", ());
                }
                _ => {}
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::get_app_info,
            // 文件系统
            commands::fs::list_dir,
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::create_dir,
            commands::fs::create_file,
            commands::fs::rename_entry,
            commands::fs::delete_entry,
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
            // 搜索与界面状态（M1）
            commands::workspace::search_workspace,
            commands::workspace::get_ui_state,
            commands::workspace::set_ui_state,
            // 远程语言智能（M6 基础）
            commands::lsp::lsp_detect,
            commands::lsp::project_detect,
            // 局域网发现（M5）
            commands::discovery::discovery_interfaces,
            commands::discovery::discovery_default_route,
            commands::discovery::discovery_scan,
            commands::discovery::discovery_cancel,
            commands::discovery::discovery_mdns_start,
            commands::discovery::discovery_mdns_cancel,
            // 终端与构建任务（M4）
            commands::terminal::terminal_open,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_device,
            commands::terminal::run_remote_task,
        ])
        .on_window_event(|window, event| {
            // 主窗口关闭时回收全部 SSH 会话（§6.4 生命周期管理）
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    let state: Option<tauri::State<AppState>> = window.try_state();
                    if let Some(state) = state {
                        // 关闭全部终端通道
                        let terminals = state.terminals.clone();
                        tauri::async_runtime::spawn(async move {
                            app_services::terminal::close_all(&terminals).await;
                        });
                        for entry in state.sessions.list() {
                            tauri::async_runtime::spawn(async move {
                                let handle = entry.handle.lock().await;
                                let _ = handle
                                    .disconnect(russh::Disconnect::ByApplication, "app exit", "en")
                                    .await;
                            });
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Glance IDE 运行出错");
}
