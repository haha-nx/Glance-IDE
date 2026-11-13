import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as pickDialog } from "@tauri-apps/plugin-dialog";
import { appApi, filesApi } from "../../services/files";
import { updaterApi } from "../../services/updater";
import { explorerStore } from "../../stores/explorer";
import { tabsStore } from "../../stores/tabs";
import { getOrCreateModel } from "../../lib/models";
import { IS_MAC } from "../../lib/platform";

/** 快捷键文案：macOS 用 ⌘，Windows 用 Ctrl */
const mod = IS_MAC ? "⌘" : "Ctrl+";
const shift = IS_MAC ? "⇧" : "Shift+";
const altKey = IS_MAC ? "⌥" : "Alt+";

interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  separator?: boolean;
}

interface MenuDef {
  id: string;
  label: string;
  items: MenuItem[];
}

interface TitleBarProps {
  onToggleTerminal?: () => void;
  onNewTerminal?: () => void;
  onOpenSettings?: () => void;
  onRequestClose?: () => void;
}

export function TitleBar({
  onToggleTerminal,
  onNewTerminal,
  onOpenSettings,
  onRequestClose,
}: TitleBarProps) {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const rootPath = explorerStore((s) => s.rootPath);
  const activeId = tabsStore((s) => s.activeId);
  const tabs = tabsStore((s) => s.tabs);

  const activeTab = tabs.find((t) => t.uri === activeId);

  // 监听窗口最大化状态以切换最大化/还原图标
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {});

    void getCurrentWindow()
      .onResized(async () => {
        try {
          const max = await getCurrentWindow().isMaximized();
          setIsMaximized(max);
        } catch {
          /* 忽略 */
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, []);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!activeMenu) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };
    window.addEventListener("mousedown", handleOutsideClick);
    return () => window.removeEventListener("mousedown", handleOutsideClick);
  }, [activeMenu]);

  // macOS 原生菜单栏事件：系统菜单项统一以 menu:command 派发，在此映射到既有动作
  // 用 ref 持有最新回调，避免父组件每次渲染都重新订阅
  const toggleTerminalRef = useRef(onToggleTerminal);
  toggleTerminalRef.current = onToggleTerminal;
  const newTerminalRef = useRef(onNewTerminal);
  newTerminalRef.current = onNewTerminal;

  useEffect(() => {
    if (!IS_MAC) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWebviewWindow()
      .listen<string>("menu:command", (event) => {
        switch (event.payload) {
          case "new_file":
            newFile();
            break;
          case "new_folder":
            newFolder();
            break;
          case "new_window":
            newWindow();
            break;
          case "save":
            saveCurrent();
            break;
          case "save_all":
            saveAll();
            break;
          case "new_terminal":
            newTerminalRef.current?.();
            break;
          case "toggle_terminal":
            toggleTerminalRef.current?.();
            break;
          case "panel_explorer":
          case "panel_search":
          case "panel_git":
          case "panel_remote":
          case "panel_discovery": {
            const panel = event.payload.replace("panel_", "");
            window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: panel }));
            break;
          }
          case "github_repo":
            void updaterApi.openExternalUrl("https://github.com/haha-nx/Glance-IDE");
            break;
          case "quit":
            // 复用未保存确认流程：有脏文件时由 App 弹出确认，否则直接退出
            if (tabsStore.getState().hasDirty()) {
              window.dispatchEvent(new CustomEvent("glance:request-close"));
            } else {
              void appApi.exitApp();
            }
            break;
          default:
            break;
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 窗口控制逻辑
  const handleMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      /* 忽略 */
    }
  };

  const handleToggleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
      const max = await getCurrentWindow().isMaximized();
      setIsMaximized(max);
    } catch {
      /* 忽略 */
    }
  };

  const handleClose = () => {
    if (onRequestClose) {
      onRequestClose();
    } else {
      if (tabsStore.getState().hasDirty()) {
        window.dispatchEvent(new CustomEvent("glance:request-close"));
      } else {
        void appApi.closeWindow();
      }
    }
  };

  // 菜单动作
  const newFile = () => {
    setActiveMenu(null);
    const root = explorerStore.getState().rootPath;
    if (root) {
      const name = prompt("请输入新建文件名称（如 main.rs 或 doc.md）：");
      if (name && name.trim()) {
        const cleanRoot = root.replace(/\\/g, "/");
        const cleanPath = `${cleanRoot}/${name.trim()}`;
        void filesApi.createFile(cleanPath).then(async () => {
          await explorerStore.getState().refresh(root);
          await tabsStore.getState().openFileByPath(cleanPath);
        });
      }
    } else {
      const id = `local://untitled-${Date.now()}.txt`;
      getOrCreateModel(id, "", "untitled.txt");
      tabsStore.setState((s) => ({
        tabs: [
          ...s.tabs,
          {
            uri: id,
            path: id,
            name: "untitled.txt",
            dirty: true,
            mtimeMs: Date.now(),
            readonly: false,
          },
        ],
        activeId: id,
      }));
    }
  };

  const newFolder = () => {
    setActiveMenu(null);
    const root = explorerStore.getState().rootPath;
    if (root) {
      const name = prompt("请输入新建文件夹名称：");
      if (name && name.trim()) {
        const cleanRoot = root.replace(/\\/g, "/");
        const cleanPath = `${cleanRoot}/${name.trim()}`;
        void filesApi.createDir(cleanPath).then(() => {
          void explorerStore.getState().refresh(root);
        });
      }
    } else {
      alert("请先在资源管理器打开工作区文件夹");
    }
  };

  const newWindow = () => {
    setActiveMenu(null);
    void appApi.openNewWindow();
  };

  const openFolder = async () => {
    setActiveMenu(null);
    const picked = await pickDialog({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) {
      await explorerStore.getState().openRoot(picked);
      window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "explorer" }));
    }
  };

  const openFile = async () => {
    setActiveMenu(null);
    const picked = await pickDialog({ multiple: false });
    if (typeof picked === "string" && picked) {
      await tabsStore.getState().openFileByPath(picked);
    }
  };

  const saveCurrent = () => {
    setActiveMenu(null);
    const { activeId: id, saveTab } = tabsStore.getState();
    if (id) void saveTab(id);
  };

  const saveAll = () => {
    setActiveMenu(null);
    void tabsStore.getState().saveAll();
  };

  const menus: MenuDef[] = [
    {
      id: "file",
      label: `文件${IS_MAC ? "" : "(F)"}`,
      items: [
        { label: "新建文件", shortcut: `${mod}N`, action: newFile },
        { label: "新建文件夹", action: newFolder },
        { label: "新建窗口", shortcut: `${mod}${shift}N`, action: newWindow },
        { separator: true, label: "" },
        { label: "打开文件夹", shortcut: `${mod}${shift}O`, action: () => void openFolder() },
        { label: "打开文件", shortcut: `${mod}O`, action: () => void openFile() },
        { separator: true, label: "" },
        { label: "保存", shortcut: `${mod}S`, action: saveCurrent },
        { label: "全部保存", shortcut: `${mod}${altKey}S`, action: saveAll },
        { separator: true, label: "" },
        {
          label: "设置",
          shortcut: `${mod},`,
          action: () => {
            setActiveMenu(null);
            onOpenSettings?.();
          },
        },
        { separator: true, label: "" },
        { label: "退出", shortcut: IS_MAC ? `${mod}Q` : "Alt+F4", action: handleClose },
      ],
    },
    {
      id: "edit",
      label: `编辑${IS_MAC ? "" : "(E)"}`,
      items: [
        {
          label: "撤销",
          shortcut: `${mod}Z`,
          action: () => {
            setActiveMenu(null);
            document.execCommand("undo");
          },
        },
        {
          label: "重做",
          shortcut: IS_MAC ? `${mod}${shift}Z` : "Ctrl+Y",
          action: () => {
            setActiveMenu(null);
            document.execCommand("redo");
          },
        },
        { separator: true, label: "" },
        {
          label: "剪切",
          shortcut: `${mod}X`,
          action: () => {
            setActiveMenu(null);
            document.execCommand("cut");
          },
        },
        {
          label: "复制",
          shortcut: `${mod}C`,
          action: () => {
            setActiveMenu(null);
            document.execCommand("copy");
          },
        },
        {
          label: "粘贴",
          shortcut: `${mod}V`,
          action: () => {
            setActiveMenu(null);
            document.execCommand("paste");
          },
        },
        { separator: true, label: "" },
        {
          label: "全选",
          shortcut: `${mod}A`,
          action: () => {
            setActiveMenu(null);
            document.execCommand("selectAll");
          },
        },
      ],
    },
    {
      id: "view",
      label: `查看${IS_MAC ? "" : "(V)"}`,
      items: [
        {
          label: "资源管理器",
          shortcut: `${mod}${shift}E`,
          action: () => {
            setActiveMenu(null);
            window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "explorer" }));
          },
        },
        {
          label: "全局搜索",
          shortcut: `${mod}${shift}F`,
          action: () => {
            setActiveMenu(null);
            window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "search" }));
          },
        },
        {
          label: "源代码管理",
          shortcut: `${mod}${shift}G`,
          action: () => {
            setActiveMenu(null);
            window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "git" }));
          },
        },
        {
          label: IS_MAC ? "远程连接" : "远程连接与 WSL",
          shortcut: `${mod}${shift}R`,
          action: () => {
            setActiveMenu(null);
            window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "remote" }));
          },
        },
        {
          label: "局域网发现",
          action: () => {
            setActiveMenu(null);
            window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "discovery" }));
          },
        },
        { separator: true, label: "" },
        {
          label: "切换底部终端",
          shortcut: `${mod}\``,
          action: () => {
            setActiveMenu(null);
            onToggleTerminal?.();
          },
        },
        { separator: true, label: "" },
        {
          label: "切换全屏",
          shortcut: IS_MAC ? "⌃⌘F" : "F11",
          action: () => {
            setActiveMenu(null);
            void handleToggleMaximize();
          },
        },
      ],
    },
  ];

  // 计算标题文本
  let title = "Glance IDE";
  if (activeTab) {
    title = `${activeTab.name} — Glance IDE`;
  } else if (rootPath) {
    const rootName = rootPath.split(/[/\\]/).filter(Boolean).pop() || rootPath;
    title = `${rootName} — Glance IDE`;
  }

  return (
    <div
      ref={barRef}
      data-tauri-drag-region
      className={`flex h-[30px] shrink-0 select-none items-center justify-between border-b border-zinc-800 bg-[var(--glance-bg)] text-[12px] text-zinc-300 ${
        // macOS 标题栏叠加在内容之上，左侧需给原生红绿灯让出位置
        IS_MAC ? "pl-[76px]" : ""
      }`}
    >
      {/* 左侧：Windows 品牌 Logo + 单行菜单项；macOS 不需要（菜单与红绿灯都由系统提供） */}
      <div className="flex h-full items-center">
        {/* Glance IDE 标志：与应用图标一致 —— 天蓝色终端提示符 ">" + 灰色下划线（仅 Windows 显示） */}
        <div
          className={`flex h-full items-center pl-2.5 pr-2 ${IS_MAC ? "hidden" : ""}`}
          title="Glance IDE"
        >
          {/* 图形实际包围盒：x 272..768 / y 292..732（含 56 像素圆头笔画） */}
          <svg
            width="18"
            height="16"
            viewBox="272 292 496 440"
            aria-hidden="true"
          >
            {/* 提示符 ">"：与 scripts/gen_icon.py 的 (300,320)→(520,512)→(300,704) 折线同源 */}
            <path
              d="M300 320 L520 512 L300 704"
              fill="none"
              stroke="#38bdf8"
              strokeWidth="56"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* 下划线：(580,704)→(740,704)，图标中为 zinc-400 */}
            <line
              x1="580"
              y1="704"
              x2="740"
              y2="704"
              stroke="#a3a3b1"
              strokeWidth="56"
              strokeLinecap="round"
            />
          </svg>
        </div>

        {/* 顶部菜单：文件(F) 编辑(E) 查看(V) 终端(直接新建)；macOS 隐藏（由系统菜单栏承担） */}
        <div className={`flex h-full items-center text-zinc-300 ${IS_MAC ? "hidden" : ""}`}>
          {menus.map((menu) => {
            const isOpen = activeMenu === menu.id;
            return (
              <div key={menu.id} className="relative h-full flex items-center">
                <button
                  onClick={() => setActiveMenu(isOpen ? null : menu.id)}
                  onMouseEnter={() => {
                    if (activeMenu && activeMenu !== menu.id) {
                      setActiveMenu(menu.id);
                    }
                  }}
                  className={`flex h-[22px] items-center px-2 text-[12px] rounded-[3px] transition-colors ${
                    isOpen ? "bg-zinc-800 text-zinc-100" : "hover:bg-zinc-800/70 hover:text-zinc-100"
                  }`}
                >
                  {menu.label}
                </button>

                {isOpen && (
                  <div className="absolute left-0 top-full z-[9999] min-w-[240px] w-max rounded-md border border-zinc-700 bg-zinc-900 py-1 text-zinc-200 shadow-2xl backdrop-blur-md">
                    {menu.items.map((item, idx) => {
                      if (item.separator) {
                        return <div key={idx} className="my-1 border-t border-zinc-800" />;
                      }
                      return (
                        <button
                          key={idx}
                          onClick={item.action}
                          className="group flex w-full cursor-pointer items-center justify-between gap-6 px-3 py-1.5 text-left text-[12px] whitespace-nowrap hover:bg-sky-600 hover:text-white transition-colors"
                        >
                          <span className="shrink-0 whitespace-nowrap">{item.label}</span>
                          {item.shortcut && (
                            <span className="ml-auto shrink-0 pl-4 text-[11px] text-zinc-400 group-hover:text-white whitespace-nowrap font-mono">
                              {item.shortcut}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* 终端直接按钮：无下拉菜单，按下直接新建终端 */}
          <button
            onClick={() => {
              setActiveMenu(null);
              onNewTerminal?.();
            }}
            className="flex h-[22px] items-center px-2 text-[12px] rounded-[3px] transition-colors hover:bg-zinc-800/70 hover:text-zinc-100"
            title="新建终端"
          >
            终端
          </button>
        </div>
      </div>

      {/* 中间：窗口标题 + 拖拽区域。
          双击最大化/还原由 Tauri 内置 drag.js 对 data-tauri-drag-region 原生处理，
          这里不能再绑 onDoubleClick，否则会与原生行为各切一次、放大后立刻缩回。 */}
      <div
        data-tauri-drag-region
        className="flex h-full flex-1 items-center justify-center cursor-default px-4 text-zinc-400 text-[12px] font-normal truncate"
      >
        <span data-tauri-drag-region className="truncate opacity-90">
          {title}
        </span>
      </div>

      {/* 右侧：Windows 窗口控制按钮（macOS 使用系统原生红绿灯，不渲染） */}
      <div className={`flex h-full items-center ${IS_MAC ? "hidden" : ""}`}>
        <button
          onClick={handleMinimize}
          className="flex h-full w-11 items-center justify-center text-zinc-300 hover:bg-zinc-800/70 hover:text-zinc-100 transition-colors"
          title="最小化"
        >
          <svg width="10" height="1" viewBox="0 0 10 1">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </button>

        <button
          onClick={handleToggleMaximize}
          className="flex h-full w-11 items-center justify-center text-zinc-300 hover:bg-zinc-800/70 hover:text-zinc-100 transition-colors"
          title={isMaximized ? "还原" : "最大化"}
        >
          {isMaximized ? (
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            >
              <rect x="2.5" y="0.5" width="7" height="7" />
              <polyline points="0.5,2.5 0.5,9.5 7.5,9.5" />
            </svg>
          ) : (
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            >
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>

        <button
          onClick={handleClose}
          className="flex h-full w-11 items-center justify-center text-zinc-300 hover:bg-[#e81123] hover:text-white transition-colors"
          title="关闭"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2">
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      </div>
    </div>
  );
}
