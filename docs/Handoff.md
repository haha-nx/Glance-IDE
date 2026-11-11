# Glance IDE — 工作交接文档（Handoff）

> 生成日期：2026-11-09 · 基于技术架构 v3.0 与开发计划 v1.0
> 读者：接手本项目的开发者。读完本文档应能独立运行、测试、打包并继续开发。

---

## 0. 会话交付摘要

### 0.1 2026-11-09 全功能增强与稳定性修复会话摘要

本会话针对近期实机使用反馈及新功能需求，完成了以下关键缺陷修复与核心体验升级：

| 项目分类 | 内容 | 状态 | 涉及核心文件 |
|---|---|---|---|
| **缺陷修复** | SSH 远程连接后打不开文件 (斜杠规范化与白屏修复) | ✅ 完成 | `src-tauri/src/filesystem/sftp.rs`, `commands/fs.rs`, `MonacoHost.tsx` |
| **缺陷修复** | 打开 WSL 界面时跳出控制台黑框终端 (CREATE_NO_WINDOW) | ✅ 完成 | `src-tauri/src/app_services/wsl.rs`, `commands/wsl.rs` |
| **交互升级** | 所见即所得 Markdown 工具栏与功能修复、去除 Typora 标识 | ✅ 完成 | `src/components/markdown/MarkdownWysiwyg.tsx`, `domToMarkdown.ts` |
| **界面优化** | SSH 与 WSL 合并为统一侧边栏，极简两行/一行连接列表 | ✅ 完成 | `src/components/remote/RemotePanel.tsx`, `ActivityBar.tsx`, `App.tsx` |
| **功能扩展** | 多终端架构：支持本机 (PowerShell)、WSL 与 SSH 远程终端 | ✅ 完成 | `app_services/terminal.rs`, `commands/terminal.rs`, `TerminalPanel.tsx` |
| **界面优化** | VS Code 风格单行沉浸式暗色标题栏与完整菜单 | ✅ 完成 | `src/components/common/TitleBar.tsx`, `src-tauri/tauri.conf.json` |
| **严重故障** | 修复 Release 生产版本打开后无法关闭退出 | ✅ 完成 | `src-tauri/capabilities/default.json`, `src-tauri/src/commands/app.rs` |
| **常规修复** | 全局搜索中文高亮错位、Diff 泄漏、任务超时 | ✅ 完成 | `app_services/search.rs`, `components/editor/DiffView.tsx`, `terminal.rs` |

### 0.2 2026-11-09 深度 UI 优化与实测缺陷修复

针对高阶用户在多屏协作、分屏编辑、终端交互、IP扫描及所见即所得 Markdown 编写等场景下的深度反馈，完成了系统性优化：

| 功能模块 | 优化 / 缺陷修复项目 | 状态 | 详细说明与核心文件 |
|---|---|---|---|
| **终端分屏与最大化** | 终端与代码左右分屏、面板最大化/还原 | ✅ 完成 | `TerminalPanel.tsx`, `EditorArea.tsx`, `App.tsx` |
| **终端布局优化** | 按钮靠右归集、终端位置移至侧边栏右侧 | ✅ 完成 | 新建(+)、分屏(\|)与最大化(□/❐)统一靠紧关闭(×)按钮；终端不再侵占侧边栏下方空间 |
| **上下文感知终端** | 新建终端自动匹配当前窗口所在设备环境 | ✅ 完成 | 本地工作区新建 PowerShell，SSH 工作区新建 SSH 远程终端，WSL 工作区新建 Linux 终端 |
| **远程面板图标化** | WSL / SSH 连接操作使用现代矢量图标替代文字 | ✅ 完成 | `RemotePanel.tsx`：新窗口连接与当前窗口直连采用紧凑图标按钮，带悬浮提示 |
| **标题栏精简化** | 文件菜单补充新建项、精简无用占位、重命名设置 | ✅ 完成 | `TitleBar.tsx`：加入“新建文件”、“新建文件夹”、“新建窗口”，精简非必要功能项 |
| **IP 发现增强** | 网段三框格式 + 端口框 + 自动填入本机 IP + 仅展示 SSH 端口 | ✅ 完成 | `DiscoveryPanel.tsx`：前三段网段输入 + `1->254` + 端口 22 输入，自动获取本机网络并仅展示确认 SSH 的主机 |
| **Markdown 表格与大纲** | 表格行列拾取器、右上角行列调整面板、正文段落旁大纲按钮 | ✅ 完成 | `MarkdownWysiwyg.tsx`：表格行列尺寸自定义、表格右上角精准增减/调整行列、紧邻段落的大纲开关 |
| **Markdown 交互体验** | 划词快捷浮动菜单、选中段落转代码块、原生可撤销 (Ctrl+Z) | ✅ 完成 | 修复选区失焦问题，`insertHTML` 结合 `document.execCommand` 保证操作完全支持撤销与重做 |
| **实测 Bug 修复** | 侧边栏宽度统一、资源管理器标题防折行 | ✅ 完成 | 资源管理器与搜索、远程、发现面板统一为 `w-72`；过长工作区名称自动省略并优雅降级为“文件” |
| **实测 Bug 修复** | SSH 打开文件黑屏问题与 SFTP 相对目录过滤 | ✅ 完成 | `sftp.rs` 过滤 `.` 与 `..`；`MonacoHost.tsx` 解决模型生命周期与重试卡死，提供加载异常恢复面板 |
| **实测 Bug 修复** | 新建终端残留内容隔离与多窗口独立关闭 | ✅ 完成 | `TerminalPanel.tsx` 隔离各终端 DOM 挂载容器；Rust `close_window` 仅当剩单个窗口时退进程，多窗口独立退出 |

### 0.3 2026-11-09 高级交互重构：VS Code 多级分屏与 Typora 极简沉浸式 Markdown

针对深度开发与文档排版场景，完成了核心编辑与终端架构升级：

| 功能模块 | 升级内容 | 状态 | 核心实现与文件 |
|---|---|---|---|
| **IP 搜索紧凑化** | 输入框自适应不截断、按钮尺寸与居中调整、删除 mDNS、单行 IP 箭头展示 | ✅ 完成 | `DiscoveryPanel.tsx`：输入框微型化防溢出，开始扫描按钮高度收缩且居中，仅展示单行 IP+连接图标 |
| **多终端动态分屏** | 突破双分屏限制，支持连续分屏；全屏响应；最后终端关闭联锁 | ✅ 完成 | `TerminalPanel.tsx`：多窗格动态并排渲染，ResizeObserver 监听全屏自适应，最后一个终端关闭时连同收起下边栏 |
| **Typora 风格 Markdown** | 顶栏极简化，左侧文档大纲，完整右键菜单体系，表格设置模态弹窗 | ✅ 完成 | `MarkdownWysiwyg.tsx`：移除选区气泡，顶栏仅留大纲与字数切换；大纲移至左侧；右键菜单支持段落/样式/插入与表格操作；插入表格弹出行列对话框 |
| **VS Code 多组代码分屏** | 突破双分屏限制，支持任意行列网格拆分，支持拖拽标签至边缘分屏与重排 | ✅ 完成 | `tabs.ts`, `tabDrag.ts`, `TabBar.tsx`, `EditorArea.tsx`：基于 EditorGroup + layout 网格，多列多行独立尺寸拖动与标签拖放拆分 |

### 0.4 2026-11-09 终端标签体验升级、右键生效与空白新窗口机制

用户反馈关于导航栏直达、终端多窗格标签栏、右键菜单冒泡修复与独立空白窗口：

| 模块 | 升级内容 | 状态 | 核心实现与文件 |
|---|---|---|---|
| **导航栏终端直通** | 顶部导航栏终端按钮移除下拉菜单，点击直接开启/切换终端 | ✅ 完成 | `TitleBar.tsx`：从 menus 剔除 terminal，改为直接触发 `onToggleTerminal()` |
| **浏览器式终端标签** | 终端窗格新建按钮位于标签右侧 `[+]`；支持标签拖拽分屏，分屏窗格拥有独立标签栏 | ✅ 完成 | `TerminalPanel.tsx`：多窗格模型 `TermPane`，每个分屏独立标签栏与紧邻 `[+]`，支持跨窗格拖拽重排与拖至边缘拆分 |
| **Markdown 右键修复** | 彻底修复预览模式下右键菜单瞬间消失/不生效问题 | ✅ 完成 | `MarkdownWysiwyg.tsx`：组织冒泡 `stopPropagation`，延时 60ms 绑定点击外部监听，双层挂载右键监听 |
| **纯净空白新窗口** | 新建窗口打开全新空白工作台，不自动加载历史文件夹、标签页或 SSH | ✅ 完成 | `app.rs` 注入 `?blank=1`，`App.tsx` 探测 blank 跳过工作区历史恢复，打造干净新实例 |

### 0.5 2026-11-09 原生 Logo 与经典导航栏恢复、终端直达新建
根据最新用户指示，校正品牌标识、优化导航栏结构：

| 模块 | 升级内容 | 状态 | 核心实现与文件 |
|---|---|---|---|
| **保留原生品牌 Logo** | 严格保留 Glance IDE 独创天蓝色立体折线/多边形矢量 Logo，不替换为第三方软件标识 | ✅ 完成 | `TitleBar.tsx`：采用 Glance IDE 专属 `#38bdf8` 几何多面体矢量图标 |
| **恢复经典导航栏菜单** | 恢复 `文件(F)` `编辑(E)` `查看(V)` `终端` `帮助(H)` 经典紧凑单行导航结构 | ✅ 完成 | `TitleBar.tsx`：移除选择/转到/运行等冗余菜单项与多余控制图标，色调严密契合 IDE 主题 |
| **终端按钮直接新建** | 导航栏“终端”按钮彻底取消下拉菜单，点击直接在当前活动窗格新建终端 | ✅ 完成 | `TitleBar.tsx`, `App.tsx`, `TerminalPanel.tsx`：点击直接触发新建终端，若底栏折叠则自动展开并新建 |

### 0.12 2026-11-11 源代码管理文件对比（Diff）与图形区远端加载修复（最新交付）

根据用户新需求与反馈（「源代码管理没有文件对比，图形区无法加载远端文件」），完成 Git 文件对比视图与远程 SSH / WSL / 合并提交图谱修复：

| 模块 | 升级内容 | 状态 | 核心实现与文件 |
|---|---|---|---|
| **源代码管理文件对比（Diff）** | 新增 `git_file_diff` 后端命令（支持 `working` 工作区 vs 暂存区、`staged` 暂存区 vs HEAD、`commit` 提交 vs 父提交三模式，并兼容重命名、删除、首次提交与二进制识别）；新增 `GitDiffView` Monaco Diff 编辑器标签页，支持并排/行内视图切换、刷新与打开工作区文件；点击「更改」「已暂存的更改」与「图形」中的文件条目即打开对比视图 | ✅ 完成 | `src-tauri/src/commands/git.rs` (`git_file_diff`), `src-tauri/src/lib.rs`, `src/services/git.ts`, `src/stores/tabs.ts` (`openGitDiff`), `src/components/editor/GitDiffView.tsx`, `src/components/editor/EditorArea.tsx`, `src/components/editor/TabBar.tsx`, `src/App.tsx` |
| **图形区（Commit Graph）远端加载修复** | 1) 远程 SSH `run_git_at` 改为 `sh -c` POSIX 包装并改并发 `tokio::join!` 为顺序执行，避免 `MaxSessions` 通道竞争与非 POSIX 登录 Shell 解析失败；2) `exec_capture` 等待 EOF 后再结束读取；3) `git log --all` 失败自动回退当前分支并透传 `graphError` 与重试按钮；4) `git_commit_files` 加入 `-m --first-parent` 支持合并提交；5) 修复 `CommitGraph` 因刷新 `commits` 引用清空已展开文件缓存的问题，并在点击历史文件时加载修订 Diff（不再直接读工作区磁盘文件） | ✅ 完成 | `src-tauri/src/app_services/terminal.rs` (`exec_capture`), `src-tauri/src/commands/git.rs`, `src/components/git/CommitGraph.tsx`, `src/components/git/GitPanel.tsx` |

### 0.11 2026-11-11 源代码管理升级为上下两栏（更改 + 图形）与移除 Diff 功能

根据用户最新指示，将源代码管理侧边栏拆分为上下两部分（上部分「更改」+ 下部分「图形」），支持拖拽调整比例，同时保持移除编辑器 Diff 对比功能：

| 模块 | 升级内容 | 状态 | 核心实现与文件 |
|---|---|---|---|
| **源代码管理（上栏：更改）** | 支持本地、WSL 与远程 SSH 仓库；包含分支切换/新建、同步（Fetch / Pull / Push / 超前落后计数）、顶部提交区（提交 / 提交并推送 / 自动暂存）、已暂存/工作区更改（暂存/取消暂存/单文件与全部放弃）、工作树（Worktrees）管理弹窗及活动栏实时更改计数角标 | ✅ 完成 | `src-tauri/src/commands/git.rs`, `src/services/git.ts`, `src/stores/git.ts`, `src/components/git/GitPanel.tsx`, `ActivityBar.tsx`, `TitleBar.tsx`, `App.tsx` |
| **源代码管理（下栏：图形）** | 新增多分支拓扑 SVG 提交图谱（`CommitGraph`），包含未提交工作区虚线虚拟节点、分支/远程/标签徽标、合并与分叉 Bezier 轨线、全部分支/当前分支切换，以及点击提交节点按需查看变更文件并在编辑器中直接打开 | ✅ 完成 | `src-tauri/src/commands/git.rs` (`git_commit_files`), `src/components/git/CommitGraph.tsx`, `src-tauri/src/lib.rs` |
| **移除 Diff 功能** | 去掉编辑区右上角 Diff 对比按钮并删除 `DiffView` 组件，清理冲突弹窗中的 Diff 提示文案；点击更改与提交历史文件直接打开源码/文档编辑器 | ✅ 完成 | 移除 `DiffView.tsx`, 更新 `EditorArea.tsx`, `Dialogs.tsx` |

### 0.10 2026-11-11 全新设置中心（字体/主题/GitHub 更新）、面板尺寸调节与导航菜单细节打磨

根据用户新需求，完成了设置界面重构、全界面多主题/字号同步、GitHub Release 版本检测与安装包下载，以及侧边栏/下边栏拖拽调宽调高功能：

| 模块 | 升级内容 | 状态 | 核心实现与文件 |
|---|---|---|---|
| **全新设置界面（字体与主题）** | 重构设置弹窗为分栏设置中心；新增字号（10–24px）与 4 套全界面颜色主题实时切换，并持久化至本地与 SQLite | ✅ 完成 | `src/stores/settings.ts`, `SettingsModal.tsx`, `global.css`, `monaco.ts`, `MonacoHost.tsx`, `TerminalPanel.tsx` |
| **GitHub 版本检测与下载** | 接入 GitHub Releases API 检测新版本、匹配当前平台安装包并支持下载至系统「下载」目录及启动安装 | ✅ 完成 | `src-tauri/src/commands/updater.rs`, `src/services/updater.ts`, `src/stores/updater.ts` |
| **自动检测/下载开关（默认关闭）** | 新增「自动检测更新」与「自动下载安装包」开关，默认均关闭；关闭自动检测时除非手动检查更新否则绝不主动请求或推送 | ✅ 完成 | `settings.ts`, `updater.ts`, `SettingsModal.tsx`, `App.tsx` |
| **侧边栏与下边栏拖拽调节** | 左侧边栏右边缘与底部终端栏上边缘增加拖拽调节手柄，支持双击恢复默认尺寸，带全局拖拽防穿透遮罩并持久化尺寸 | ✅ 完成 | `src/App.tsx`, `src/stores/settings.ts` |
| **导航栏文件菜单去省略号** | 去掉顶部导航栏「文件(F)」下拉菜单中「打开文件夹」和「打开文件」末尾的 `…` 省略号 | ✅ 完成 | `src/components/common/TitleBar.tsx` |

### 0.9 2026-11-10 本机实际物理局域网网段精准探测与代理/虚拟机网卡过滤

针对“IP 搜索网段误读取代理 TUN 网段或虚拟机网卡网段”的问题，完成系统性物理路由与网卡智能过滤升级：

| 模块 | 升级内容 | 状态 | 核心实现与文件 |
|---|---|---|---|
| **物理默认网关精准提取** | 彻底解决 Clash / Mihomo / Sing-box TUN 模式截获默认出站路由导致 IP 填充为 `198.18.0.x` 的问题 | ✅ 完成 | `src-tauri/src/commands/discovery.rs`：通过原生 Windows 路由表解析物理网关，强制排除 `198.18.0.0/15` |
| **虚拟机与代理网卡深度过滤** | 彻底过滤 VMware、VirtualBox、WSL、Hyper-V、Docker 等虚拟网卡及 169.254/100.64 等专用保留网段 | ✅ 完成 | `discovery.rs`：新增 `is_virtual_or_proxy_ip` 与 `is_virtual_or_proxy_name`，物理网卡加权置顶 |
| **自动填充优先物理 LAN** | 发现面板 IP 输入框首选用户实际使用的 Wi-Fi / 局域网网段（如 `192.168.1`） | ✅ 完成 | `DiscoveryPanel.tsx`：优先绑定 `defaultRoute` 探测出的真实物理网关 IP，次选首个物理网卡 |

---

### 0.8 2026-11-10 导航栏下拉菜单单行完整展示优化与帮助选项精简

根据最新视觉排版反馈，优化顶部导航栏下拉菜单项展示并精简非必要功能项：

| 模块 | 升级内容 | 状态 | 核心实现与文件 |
|---|---|---|---|
| **下拉菜单单行完整展示** | 彻底消除“打开文件夹…”等项目因宽度不足和缺少防折行而拆成两行的问题 | ✅ 完成 | `TitleBar.tsx`：容器采用 `min-w-[240px] w-max`，全项及快捷键应用 `whitespace-nowrap` 与 `shrink-0`，右对齐快捷键 |
| **移除帮助(H)选项** | 移除顶部单行导航栏多余的“帮助(H)”菜单，使导航结构更聚焦、纯净 | ✅ 完成 | `TitleBar.tsx`：清理 help 菜单数据与对应 DOM 渲染分支，顶栏仅保留 `文件(F)` `编辑(E)` `查看(V)` 以及 `终端` 直达按钮 |

---

### 0.7 2026-11-10 SSH 终端环境自适应根治与关闭终端文件列表闪烁刷新修复

针对“连上 SSH 新建终端依然是本地终端”以及“关闭终端时文件列表发生意外刷新/闪烁”的问题，完成系统性根因排查与彻底修复：

| 模块 | 升级内容 | 状态 | 核心实现与文件 |
|---|---|---|---|
| **SSH 终端智能自适应** | 彻底根治 SSH 连上后新建终端仍为本地终端的问题 | ✅ 完成 | `TerminalPanel.tsx`：实时拉取 `liveSessions`，监听会话连接事件，连接时平滑无缝替换启动期临时终端 |
| **文件列表关闭防刷新** | 彻底根治关闭终端/底栏时资源管理器文件树闪烁刷新的问题 | ✅ 完成 | `App.tsx`：为 `useWorkspacePersistence` 增加 `hasInitializedRef` 单次执行守卫，稳定回调引用，杜绝状态变更重走 `openRoot` |

#### 1. 为什么连上 SSH 后新建终端仍是本地 PowerShell 终端？
- **根因深度分析**：
  1. **挂载会话池未更新**：`TerminalPanel` 原先仅在组件第一次挂载时调用 `sshApi.listSessions()`。当应用启动时底栏为展开状态（`bottomPanelOpen=true`），`TerminalPanel` 在 SSH 尚未连接前即已挂载，其内存中的 `sessions` 为 `[]`。
  2. **事件总线监听缺失**：当 SSH 会话连接成功后派发了 `glance:session-connected`，但 `TerminalPanel` 未监听该事件，导致其内部 `sessions` 始终维持初始空数组状态。
  3. **环境判定降级逻辑短路**：在点击「+」或导航栏「终端」新建终端时，`createTerminalForCurrentDevice` 虽然检测到了 `rootPath` 为 `remote://...`，但由于内部 `sessions` 为空，在找不到对应会话后自动降级执行了 `openLocalTerminal()`。
  4. **启动竞态冲突**：当应用启动时若记忆了底栏展开态，终端组件在 0ms 瞬间挂载时探测到终端数为 0，抢先创建了默认本机终端。
- **根本修复方案**：
  1. **实时会话动态查询**：在 `createTerminalForCurrentDevice` 中改为异步实时请求 `sshApi.listSessions()`，并增加短延时重试，确保 100% 捕获刚建立的远程会话。
  2. **全局事件实时联动**：`TerminalPanel` 完整接入 `glance:session-connected` 与 `glance:session-disconnected` 监听，一旦 SSH 连上即刻同步会话池。
  3. **平滑置换未交互终端**：若启动初期自动打开了一个未使用的本地临时终端，在 SSH 建立连接的瞬间将其无感替换为远程 SSH 终端，无需用户手动干预。
  4. **工作区类型多重守卫**：只要工作区为 `remote://` 或当前存在活跃 SSH 会话，新建终端与分屏终端严格锁定为 SSH 终端。

#### 2. 为什么关闭终端时文件列表还会刷新一下？
- **根因深度分析**：
  - 在 `App.tsx` 中定义了负责应用初始化恢复的自定义 Hook `useWorkspacePersistence`，其 `useEffect` 的依赖数组中传入了 `[onSshReconnectFailed, onPanelRestored]`。
  - 在 `App` 组件中，这两个回调原先是直接内联定义的匿名箭头函数：
    ```tsx
    useWorkspacePersistence({
      onSshReconnectFailed: (profile, reason) => { ... },
      onPanelRestored: (panel) => { ... },
    });
    ```
  - 当用户关闭终端（关闭最后一个终端标签或点击终端面板右上角关闭按钮）时，`setBottomPanelOpen(false)` 被调用，触发了 `App` 组件的重新渲染。
  - 重新渲染导致两个回调函数的内存引用发生改变，进而导致 `useWorkspacePersistence` 的初始化 `useEffect` **被异常再次触发**！
  - 该 `useEffect` 重新读取了工作区并执行了 `await explorerStore.getState().openRoot(root)`。
  - `openRoot` 内部会先清空目录树缓存 `childrenMap: {}`，然后再重新向磁盘/远端拉取根目录内容，导致用户肉眼直观看到文件列表瞬间折叠、闪烁、刷新了一下。
- **根本修复方案**：
  1. **生命周期单次执行守卫**：在 `useWorkspacePersistence` 中加入 `const hasInitializedRef = useRef(false);`，从底层杜绝初始化恢复逻辑在任何组件重渲染或状态切换时二次触发。
  2. **稳定引用传递**：将传递给持久化 Hook 的回调函数使用 `useRef` 及 `useCallback` 包装，将 `useEffect` 依赖数组严格收敛为 `[]`。
  3. 现在关闭终端、折叠展开面板或切换标签页时，文件树绝对保持稳定，零闪烁、零冗余网络/I/O 请求。

---

### 0.6 2026-11-10 SSH 整窗黑屏彻底根治、退出自动重连与失败弹窗机制（最新交付）

针对连接 SSH 打开文件导致整窗瞬间崩溃变黑的致命问题，以及退出后自动重连 SSH、重连失败弹窗提示的需求，完成系统性修复：

| 模块 | 升级内容 | 状态 | 核心实现与文件 |
|---|---|---|---|
| **整窗黑屏致命缺陷彻底根治** | 定位并消灭 `StatusBar.tsx` 动态条件 Hook 调用导致 React 整树崩溃卸载的元凶 | ✅ 完成 | `StatusBar.tsx`：在顶层订阅 `statuses`，彻底遵循 Hook 规则；`ErrorBoundary.tsx`：增加全局防崩溃边界 |
| **SSH 退出自动重连** | 退出 IDE 前若处于 SSH 工作区或远程界面，下次打开自动恢复并重连该 SSH 会话 | ✅ 完成 | `RemotePanel.tsx`, `explorer.ts`, `App.tsx`：双持久化 `lastSshProfileId`，启动时静默重连并拉取远程根目录与标签页 |
| **SSH 连接失败提示弹窗** | 若自动重连由于网络/关机/密钥失效等原因失败，弹出友好弹窗并提供快速重试或切回本地 | ✅ 完成 | `App.tsx`：提供「重试连接」、「打开远程配置」、「切换到本地」三项直达操作，清晰显示失败原因 |

#### 1. 深度根治 SSH 远程连接后打开文件整窗黑屏缺陷
- **用户反馈现象**：连接 SSH 成功后，只要一点击远程文件打开，整个 IDE 窗口瞬间变黑（整窗所有组件、标题栏、侧边栏全失，只剩空黑窗口）。
- **根因深度溯源（致命 React Hook 违背）**：
  - 在 `src/components/common/StatusBar.tsx` 中定义了辅助函数：
    ```tsx
    function lspStatusFor(uri: string | null) {
      if (!uri || !uri.startsWith("remote://")) return null;
      ...
      const status = lspStatusStore((s) => s.statuses[deviceId]); // 致命违规：在条件分支内调用 Hook！
      return { deviceId, status };
    }
    ```
  - 当工作区没有打开文件，或者打开的是本地文件时，`uri.startsWith("remote://")` 为 `false`，该 Hook **不会**被执行（该次渲染周期 StatusBar 调用了 N 个 Hook）。
  - 当用户在 SSH 连上后点击了任何一个远程文件，`activeId` 变成了 `remote://...`，该条件分支进入，`lspStatusStore` 作为 React Hook 被调用了（该次渲染周期变成了 N+1 个 Hook）！
  - React 核心 Diff 引擎在检测到组件 Hook 数量前后不一致时，会立即抛出致命异常：
    `Error: Rendered more hooks than during the previous render.`
  - 过去根组件外层缺乏 `ErrorBoundary`，React 遇到未捕获的渲染异常时会将整颗组件树完全 Unmount（卸载），留下一个完全空白的 `<div id="root"></div>`。由于应用全局背景为 `#18181b`，用户看到的就是整个窗口瞬间变黑崩溃。
- **根本修复方案**：
  1. **彻底修复 Hook 规则**：在 `StatusBar.tsx` 顶层统一调用 `const statuses = lspStatusStore((s) => s.statuses);`，将 Hook 数量在任何渲染周期保持绝对恒定；通过 `useMemo` 计算当前活动远程文件的 LSP 状态。
  2. **注入全局 ErrorBoundary 防护网**：新建 `src/components/common/ErrorBoundary.tsx` 并在 `src/main.tsx` 中包裹整个 `<App />`。即使未来任何单点出现渲染异常，也不会导致窗口黑屏，而是优雅展示错误栈及一键刷新按钮。

#### 2. SSH 退出自动重连与连接失败交互
- **持久化记录**：当在 SSH 面板点击「当前窗口连接」或成功切换至远程工作区时，将当前连接的 `profile.id` 存入 `workspace.lastSshProfileId`（同时写入持久化数据库及 `localStorage`）。若用户手动打开本地文件夹或关闭根目录，则自动清除该标记。
- **启动自动重连**：`App.tsx` 初始化时，若检测到上次工作区为 `remote://` 或上次会话记录了 `lastSshProfileId` 且侧边栏停留在远程面板，自动通过 `sshApi.listProfiles()` 匹配目标配置并调用 `sshApi.connectProfile(profile.id)` 发起重连。
- **无感平滑恢复**：连接成功后，自动触发 `glance:session-connected`，挂载远程根目录，并恢复之前打开的所有远程文件标签页。
- **失败优雅降级**：若因目标机器关机、IP 变动、网络中断或密钥失效导致连接失败，自动弹出「无法连接到远程设备」弹窗，展示配置名称、目标地址与详细错误信息，并提供：
  - **重试连接**：再次执行重连尝试。
  - **打开远程配置**：自动切至远程侧边栏并打开该 SSH 配置编辑弹窗供排查修改。
  - **切换到本地**：清除该远程记录，打开本地默认工作区，保障正常编码体验。
  3. **模型创建全局总线监听**：在 `MonacoHost.tsx` 与 `MarkdownWysiwyg.tsx` 中挂载 `glance:model-created` 订阅器，一旦远程读取完成创建 Model，即刻无缝挂载并触发 Monaco 自适应 `layout()`。
  4. **SFTP 全链路超时熔断**：在 `sftp.rs` 中的 `canonicalize` (10s)、`metadata` (15s)、`read_dir` (15s) 与 `read` (30s) 均接入 `tokio::time::timeout`，杜绝死锁与无限制挂起。
  2. Monaco 动态挂载与加载时，部分组件未在下一动画帧（`requestAnimationFrame`）触发 `editor.layout()`，导致尺寸初化为 0x0 呈现白屏。
  3. `getOrCreateModel` 缺少对已存 URI 模型的重复校验。
- **代码修复**：
  - 在 `src-tauri/src/filesystem/sftp.rs` 与 `src-tauri/src/filesystem/remote_uri.rs` 中全面应用 `.replace('\\', "/")` 统一规范化为正斜杠。
  - 在 `src/components/editor/MonacoHost.tsx` 中增加 `requestAnimationFrame(() => editor.layout())` 尺寸主动刷新。
  - 在 `src/lib/models.ts` 中规范化模型 URI 并防止重复创建。

#### 2. 打开 WSL 界面跳出控制台黑框终端问题修复
- **症状**：在 Windows GUI 环境下点击打开 WSL 面板或探测发行版时，系统频繁跳出 `wsl.exe` 黑框控制台窗口闪烁。
- **根因分析**：Windows GUI 程序通过 `std::process::Command::new("wsl.exe")` 派生子进程时，默认继承父进程的子系统标记；由于没有控制台句柄，Windows 会自动为其分配新建一个控制台窗口。
- **代码修复**：
  - 引入 `std::os::windows::process::CommandExt`，在所有 `wsl.exe` 进程调用处显式注入创建标志 `creation_flags(0x08000000)`（`CREATE_NO_WINDOW`）。
  - 在获取用户（`whoami`）、探测家目录（`echo $HOME`）、列出发行版（`wsl -l -v`）以及启动子任务时全部静默无窗口执行。

#### 3. Markdown 所见即所得模式深度优化
- **界面去标**：彻底去除“Typora 所见即所得”字样，界面更纯粹简洁。
- **工具栏与格式修复**：
  - 工具栏按钮增加 `onMouseDown={(e) => e.preventDefault()}`，彻底解决点击工具栏按钮导致输入区失焦、光标 Selection 丢失而无法插入格式的问题。
  - 修复有序列表、待办复选框、引用块、代码块、表格、水平分割线的插入与渲染逻辑。
  - 实现复选框待办项点击直接触发容器事件委托更新，即时双向同步底层 Monaco TextModel。

#### 4. 远程设备与 WSL 面板合并与极简化交互
- **统一入口**：合并左侧活动栏 SSH 与 WSL 入口，改为单一的「远程连接与 WSL」图标（`RemotePanel.tsx`）。
- **左上角下拉切换**：支持在「SSH 远程设备」与「WSL 本地子系统」之间秒级切换。
- **极简化设备列表**：
  - **SSH 远程设备**：严格收敛为两行展示：
    - 第一行：连接名称（若留空则自动显示主机 IP）、编辑按钮、删除按钮。
    - 第二行：`username@host:port`、新建窗口连接按钮、当前窗口连接按钮。
  - **WSL 子系统**：严格收敛为单行展示：
    - `username · DistroName`、新建窗口连接按钮、当前窗口连接按钮。
- **直连工作区**：点击「当前窗口连接」直接建立连接并将远程根目录/Linux 家目录打开至资源管理器。
- **名称选填与占位清理**：新建连接配置的“名称”字段改为选填（留空默认采用主机 IP）；清理并移除了所有树莓派、pi、ros、ubuntu 等特定预设字样，更加中立通用。

#### 5. 多终端全环境支持（本机、WSL、SSH）
- **本机终端**：支持在 Windows 上启动本地 PowerShell 终端，在 Unix 上启动系统默认 Shell。
- **WSL 终端**：通过 `wsl.exe -d <distro>` 支持直接在所选 Linux 子系统环境启动交互式终端。
- **SSH 终端**：通过 `russh` PTY 通道直连远程主机 Linux 终端。
- **终端面板增强**（`TerminalPanel.tsx`）：支持在多终端类型之间自由创建标签页并无缝切换，构建任务命令输入框采用通用通用占位说明。

#### 6. VS Code 风格单行沉浸式暗色标题栏与窗口控制
- **背景与痛点**：顶部标题与菜单分成两行，且菜单为 Windows 原生白底蓝字的高对比度 Win32 菜单，与深色 IDE 界面严重冲突；用户要求单行暗色一体化布局，且随 IDE 颜色主题走。
- **实现方案**：
  - `src-tauri/tauri.conf.json` 中配置 `"decorations": false`，禁用操作系统原生双层 Win32 标题栏与亮色 Win32 菜单栏。
  - `src-tauri/src/lib.rs`：Windows 平台剔除原生菜单绑定，改由前端全权控制。
  - `src/components/common/TitleBar.tsx`：开发一体化暗色标题栏：
    - 高度 30px，颜色动态跟随 `--glance-bg` 与 `--glance-border` 主题变量。
    - 左侧：Glance IDE 品牌 Logo + 紧凑式横向菜单组（文件、编辑、选择、查看、转到、运行、终端、帮助），支持下拉菜单与热键助记符（如文件 (F)）。
    - 中间：带有窗口拖拽属性（`data-tauri-drag-region`）的应用标题与当前打开文件路径展示，双击自动最大化/还原。
    - 右侧：无缝集成的 Windows 风格暗色最小化、最大化/还原、关闭窗口控制按钮。

#### 7. 修复 Release 生产版本打开后无法退出的严重 Bug
- **现象**：11/8 12:09 打包生成的 Release 版本在 Windows 下打开后，点击右上角关闭按钮或通过系统手势无法关闭退出应用。
- **根因分析**：
  - 在 Release 生产模式下，Tauri 2 开启严格的安全能力沙箱（`capabilities/default.json`）。
  - 前端窗口关闭逻辑中调用了 `getCurrentWebviewWindow().destroy()`，但 `default.json` 权限列表中仅包含 `"core:window:default"`，并未授予 `"core:window:allow-destroy"` 以及 `"core:window:allow-close"`。
  - 开发环境（dev）下沙箱可能放行，但在 Release 生产打包产物中，由于权限缺失，调用 `destroy()` 被 Tauri 权限引擎静默拦截并抛出 Permission Denied，导致窗口无法关闭。
- **修复措施**：
  - `src-tauri/capabilities/default.json` 显式补充授予 `"core:window:allow-destroy"`、`"core:window:allow-close"`、`"core:window:allow-minimize"`、`"core:window:allow-maximize"`、`"core:window:allow-toggle-maximize"`。
  - `src-tauri/src/commands/app.rs` 与 `src-tauri/src/lib.rs` 新增 `exit_app` 指令（调用 `app_handle.exit(0)`）作为双重保险。
  - 前端关闭窗口时优先调用 `exit_app`，并在异常时降级执行 `window.destroy()`。

#### 6. 代码常规问题巡检与修复
- **全局搜索中文高亮错位**（`src-tauri/src/app_services/search.rs`）：
  - 搜索匹配返回的是 UTF-8 字节偏移（`byte offset`）。若匹配行包含中文字符（3 字节），直接传给前端高亮计算会导致严重错位。
  - 修复：将 `match_start` 转换为字符计数：`line_lower[..pos].chars().count()`。
- **DiffView Monaco Model 内存泄漏**（`src/components/editor/DiffView.tsx`）：
  - Diff 视图组件卸载或文件切换时未释放创建的 Monaco Model。修复：在 cleanup effect 中显式调用 `originalModel.dispose()` 与 `modifiedModel.dispose()`。
- **终端长任务 15 秒硬超时**（`src-tauri/src/app_services/terminal.rs`）：
  - `run_exec` 中写死了 15s 硬超时，超过该时长的编译或任务会被强杀。修复：将超时调整为 1800 秒（30 分钟）。

---

### 0.2 2026-11-08 Windows 端交付会话摘要（历史归档）

本会话在 **Windows 10/11 x64（Administrator）** 上完成了遗留项的绝大部分：

| 遗留项（原 §5.2） | 状态 |
|---|---|
| 1. M6 LSP 桥接 | ✅ **完成**。Spike 冻结 + 实现落地，真机 clangd 握手/hover/双通道隔离验证通过（见 §5.4 Spike 结论） |
| 2. dmg 打包失败 | ⏸ 仍是 macOS 环境问题，与代码无关 |
| 3. Windows 侧未验证 | ✅ **完成**：cargo 全量测试、凭据管理器（Credential Manager）往返、网卡枚举、WebView2 渲染、原生对话框、Monaco、打包（MSI + NSIS）、真机 SSH/SFTP/PTY/LSP 全链路 |
| 4. §12.2 真机 8 项验收 | ✅ 自动化 3 项 + Windows UI 实机走查（指纹登记对话框/连接/会话）；克隆 Host Key、同 IP 抢占仍需第二台设备 |
| 5. vite dev 首启竞态 | 未变（仅 dev） |
| 6. CUA 偶发挂起 | Windows 上同样存在：控制器偶发 `independent_surface_requires_association` / `stopped`；恢复手段见 §5.6 |

**修复的真实 Bug**：`SftpFileSystem::expand_path` 依赖 russh-sftp 的 `expand-path@openssh.com`
扩展（标准 sftp-server 不宣告，恒返回 None）→ 改用标准 `SSH_FXP_REALPATH`
（`canonicalize`）。症状：「打开文件」报「无法解析远程路径: .」。

**修复的真实 Bug #2（用户反馈：连接后无法访问文件 / 再次连接没用）**：三个叠加缺陷——
① `SessionManager` 条目永不回收：设备重启/网络切换后 handle 已死的**僵尸会话**
一直存在且 UI 显示绿灯；② `find_by_device` 从 HashMap **随机**挑同设备会话，
文件操作可能路由到死会话（报错或卡死）；③ 前端 `ensureLoaded` 失败后缓存空列表，
目录永远显示"(空)"。修复：`prune_dead()`（按 `Handle::is_closed` 清理，`list_sessions`
先清后列）+ `find_by_device` 改异步并**选最新**会话 + `connect_profile` **替换语义**
（新握手成功后回收同配置全部旧会话——「重新连接」即恢复手段）+ 前端
`invalidateRemote()`（连接/断开时清远程目录缓存，展开态保留按需重载）+ LSP 桥
监听 `glance:session-connected` 复活已打开远程文档的语言服务。
回归测试：`real_device::real_06_session_lifecycle`（真机 6/6）。
**用户侧恢复口径：设备断电/换网后，点该配置的「重新连接」即可恢复文件访问。**

**Windows 打包**：`npm run tauri build` →
`src-tauri/target/release/bundle/msi/Glance IDE_0.1.0_x64_en-US.msi` +
`bundle/nsis/Glance IDE_0.1.0_x64-setup.exe`。构建依赖：NASM（aws-lc-sys），
已写入用户 PATH（`%LOCALAPPDATA%\bin\NASM`）；NSIS 由 tauri 下载到
`%LOCALAPPDATA%\tauri\NSIS`（本机 GitHub 直连超时，经 WSL 下载 zip 后手动解压为
`NSIS/` 目录即可）。断网资源审计：dist 内无运行时外链（仅 license/RFC 字面量）。

### 5.4 M6 LSP Spike 结论（§6.4 要求的冻结记录）

**传输层：Tauri Channel 方案冻结。** 实测（Windows → Ubuntu 20.04 设备，
`tests/lsp_bridge.rs`）：`lsp_open`（SSH exec 启动 clangd）≈180ms，
`initialize` RTT ≈65ms（clangd 本地 reply 0ms，延迟被 SSH 设备 RTT 主导）。
WebSocket 本机回环（~0.3ms）相比设备 RTT 可忽略，却引入监听端口/一次性令牌/
防火墙弹窗/额外依赖——安全面（§6.4 三条硬性要求）与复杂度全部省去。
实现：Rust 侧 JSON-RPC Content-Length 组帧/解帧（`app_services/lsp.rs` 的
`FrameParser`，容忍分片/粘帧/前导噪声）+ SSH exec 无 PTY 字节透传（stderr 分离）；
命令 `lsp_open/lsp_send/lsp_close`；会话断开/应用退出统一回收。

**客户端：不引入 monaco-languageclient（决策记录）。** 其 8.x/9.x 强制依赖
`@codingame/monaco-vscode-api` 全家桶并替换 vanilla Monaco，与本项目
EditorHost/Model 架构冲突。前端直接消费 JSON-RPC JSON 消息，自建轻量桥
（`src/lib/lsp/remoteLsp.ts`，约 600 行）：补全（含 snippet/textEdit/resolve 能力探测）、
悬停（三形态 contents 归一化）、定义跳转（file:// ↔ remote:// 映射）、
publishDiagnostics → Monaco markers、didOpen/didChange(全量+250ms 防抖)/didClose。
缓存键（§6.5）：`device_identity_id + workspace_root + language_id`（控制器实例即上下文）。
状态在 StatusBar 展示（ready/starting/failed 降级可见，§6.6）。

**语言服务器候选**（前端 `SERVER_SPECS`）：cpp/c → clangd；python → pylsp →
pyright-langserver --stdio（依次回退）。远程命令参数白名单校验（§6.4）。

### 5.5 Windows 构建环境要求

- Node 22+、Rust stable、MSVC Build Tools（VS18 Community 已装）、WebView2 Runtime
- **NASM**（russh→aws-lc-sys 需要）：`winget install NASM.NASM`，加入 PATH
- NSIS/WiX 由 tauri 自动下载（GitHub 不通时走 WSL 或代理下载后解压到 `%LOCALAPPDATA%\tauri\NSIS`）
- `scripts/e2e-server/server.js` 在 Windows 上需
  `GLANCE_E2E_SFTP_SERVER=linux:/usr/lib/openssh/sftp-server`（经 wsl.exe 直通；
  注意 Git Bash 会转换路径形环境变量，必须用 `linux:` 前缀协议）
- 测试命令（真机）：
  ```bash
  cd src-tauri
  REAL_SSH_HOST=<ip> REAL_SSH_PORT=22 REAL_SSH_USER=<user> REAL_SSH_PASS=<pass> \
    REAL_SSH_HOSTKEY_PUB=<pub> cargo test --test real_device --test lsp_bridge
  cargo test --test windows_platform   # 仅 Windows 有意义
  ```

### 5.6 Windows CUA（UI 自动化）注意事项

- 偶发 `independent_surface_requires_association`（物理输入被拒）与 `stopped`。
- 观察（getAXState/截图）始终可用；物理输入被拒时重启控制器无效果，需新会话。
- 已 UI 实机验证：应用启动/渲染、本地文件夹打开（原生对话框）、Monaco 语法高亮、
  文件树、Profile 创建（含 Windows 凭据管理器存储说明）、连接 → 未知身份阻断对话框
  （指纹三方一致核对）→ 登记并连接 → 会话绿灯。
- 待 UI 复核（后端均已集成测试覆盖）：远程文件树浏览/编辑保存、终端 PTY、
  任务运行、发现扫描、LSP hover/补全的实际操作手感。

---

## 1. 项目概览

**Glance IDE**：本地/远程一体化桌面开发工作台。Tauri 2 + React 19 + TypeScript + Rust，
核心能力：本地与 SFTP 远程文件编辑（Monaco）、WSL 原生子系统工作区直连、SSH 设备池（同 IP 多设备轮换身份识别）、
PTY 终端、远程构建任务与错误跳转、局域网设备发现、远程语言环境检测、Typora 风格 Markdown 所见即所得原地编辑。

**核心数据模型（不可破坏）**：网络端点 / 连接配置 / 设备身份 / 远程环境 四层分离（ADR-003~007）。
- 远程 SSH 资源以 `remote://{device-identity-uuid}/path` 编址；
- WSL 资源以 `wsl://{distro_name}/path` 编址并映射本地 UNC `\\wsl.localhost\{distro}\{path}`；
- 未知/变化的 Host Key 永不自动放行；凭据只进 OS 钥匙串。

## 2. 当前状态（截至本次交接）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 技术验证 | ✅ | Monaco ESM+Worker 全离线；russh/russh-sftp/rusqlite 锁定；**Windows 编译通过** |
| M1 本地编辑器 | ✅ | 文件树/多标签/Typora 风格所见即所得原地编辑/Diff/全局搜索/ui_state 持久化；**Windows 单行沉浸暗色标题栏一体化** |
| M2 SSH 设备池 | ✅ 核心 | 指纹计算与 ssh-keygen 一致；A/B/A 轮换；未知/变化阻断；Profile/Identity CRUD；Keychain；**Windows 凭据管理器验证** |
| M3 SFTP 远程工作区 | ✅ 核心 | 统一 Provider + URI 调度 + 会话内 SFTP 通道懒初始化 + 冲突检测；**修复远程子项路径前缀**；**新增 WSL 原生映射支持** |
| M4 终端与构建 | ✅ 核心 | PTY(xterm.js) + exec 任务(stdout/stderr 分离+ExitStatus) + Problem Matcher + 错误跳转；**任务超时延至 30 分钟** |
| M5 局域网发现 | ✅ | mdns-sd + CIDR TCP 扫描（并发/超时/取消）+ SSH banner 分级；**Windows 网卡枚举验证** |
| M6 远程语言智能 | ✅ | 检测/工程识别/compile_commands 指纹 + **LSP 桥接完成**（§5.4 Spike 结论；真机 clangd 握手/hover/隔离通过） |
| M7 打包发布 | ✅ | macOS .app + **Windows MSI + NSIS 安装包**；断网资源检查通过；**修复 Release 关闭沙箱拦截** |

**测试**：Rust 单元 38/38 · loopback 互操作 3/3 · 真机互操作 5/5（Ubuntu 20.04，Windows 客户端）
· **LSP 桥真机 2/2** · **Windows 平台专项 4/4**（凭据管理器/中文密码/网卡/WSL 支持）
· 前端 TS 严格模式构建全绿 · UI 走查：macOS 全量；Windows 关键路径（见 §5.6）。

**已实机复测反馈并修复的 11 项**：
1. SSH 远程连接后打不开文件（`list_dir` 协议前缀补全 + 正斜杠归一化）
2. Release 版本打开后无法关闭退出（Tauri 2 capability 显式授权 + `exit_app` 命令双保险）
3. 顶部导航栏双行与原生亮色菜单脱节（`decorations: false` + 自研 VS Code 风格 36px 一体化暗色标题栏）
4. Markdown 预览编辑交互体验（废弃悬浮抽屉，改建 Typora 风格所见即所得原地编辑、快捷格式栏、任务清单交互勾选、Monaco 双向同步）
5. WSL 原生接入（新增 `wsl://` 协议、UNC 本地极速映射、UTF-16LE 发行版探测、构建任务直通与管理面板）
6. 全局搜索中文匹配高亮错位（UTF-8 字节偏移转 Unicode 标量字符数）
7. DiffView 切换/卸载 Monaco Model 内存泄漏（显式 `dispose()`）
8. 终端构建任务 15 秒硬超时（延至 30 分钟）
9. SSH 连不通/扫不到设备（macOS 本地网络权限根因，见 §5.1）
10. 全屏切窗口布局丢失与 Diff 方向纠正
11. 僵尸会话积累与无法访问文件（`prune_dead()` + 连接替换语义）

## 3. 环境与工具链

- **本机路径**：Node 22 LTS 在 `~/tools/nodejs/bin`；Rust 在 `~/.cargo/bin`。两者不在默认 PATH：

```bash
export PATH="$HOME/tools/nodejs/bin:$HOME/.cargo/bin:$PATH"
```

- **cargo runner 自动签名**：`src-tauri/.cargo/config.toml` 配置了 `runner = "../scripts/dev-runner.sh"`，
  每次 `cargo run` / `tauri dev` / `cargo test` 编译产物自动 ad-hoc 签名。**不要移除**——macOS 26
  本地网络权限按签名归属判定（见 §5.1）。
- **打包后处理**：`npm run tauri build` 之后**必须**执行 `bash scripts/fix-macos-bundle.sh`
  （注入 NSLocalNetworkUsageDescription / NSBonjourServices 并重签）。
- **运行**：`npm run tauri dev`（开发）· `npm run tauri build`（打包）· 产物在
  `src-tauri/target/release/bundle/msi/` 与 `bundle/nsis/`（Windows）及 `bundle/macos/Glance IDE.app`（macOS）

## 4. 测试体系与命令

```bash
# 全部单元测试
cd src-tauri && cargo test --lib

# Windows 平台专项测试（含凭据管理器、网卡枚举、WSL 发行版探测与解码）
cargo test --test windows_platform

# loopback 互操作（需先起本地测试服务器；见下）
node scripts/e2e-server/server.js /tmp/glance-e2e/keys/hostkey 2222 &
ssh-keygen -t ed25519 -N "" -f /tmp/glance-e2e/keys/hostkey   # 首次
GLANCE_SSH_TEST_PORT=2222 GLANCE_SSH_TEST_HOSTKEY_PUB=/tmp/glance-e2e/keys/hostkey.pub \
  cargo test --test ssh_interop

# 真机互操作（REAL_SSH_* 为目标设备凭据，勿提交真实密码）
REAL_SSH_HOST=<ip> REAL_SSH_PORT=22 REAL_SSH_USER=<user> REAL_SSH_PASS=<pass> \
  REAL_SSH_HOSTKEY_PUB=/tmp/real/hostkey.pub cargo test --test real_device
# hostkey.pub 获取：ssh-keyscan -t ed25519 <ip> > /tmp/real/hostkey.pub
# 注意 ssh-keyscan 输出带主机前缀与 # 注释行，测试已做归一化
```

e2e 测试服务器在 `scripts/e2e-server/server.js`（Node ssh2）：密码认证 pi/raspberry、
exec 回显（`stderr:` 前缀走 stderr、`exit N` 传退出码）、简单 PTY shell、**sftp 直通
`/usr/libexec/sftp-server`**（通过原始 subsystem 通道管道——不能用 ssh2 的 'sftp' 事件，
那会解析协议而非透传字节，这是踩过的坑）。

## 5. 已知问题与关键坑（重要程度排序）

### 5.1 macOS 本地网络权限（最高优先级认知）
- macOS 26 按**代码签名归属**判定局域网访问权。未签名/未声明的二进制连局域网设备被**静默拒绝**
  （`EHOSTUNREACH/No route to host`），loopback 不受影响——这就是为什么本地测试全过而真机失败。
- 三件套缺一不可：① 应用 Info.plist 含 `NSLocalNetworkUsageDescription`；② 二进制有签名
  （dev 由 runner 自动签名；release 由 fix-macos-bundle.sh 重签）；③ 用户在
  系统设置→隐私与安全性→本地网络 中允许应用。授权状态重置：`tccutil reset LocalNetwork com.glance.ide`。
- SSH 客户端已对 `No route to host` 输出友好提示（`src-tauri/src/ssh/client.rs`）。

### 5.2 遗留工作清单（2026-11-09 更新）
1. ~~M6 LSP 桥接~~ ✅ 已完成（§5.4）。
2. ~~WSL 支持与远程子路径前缀修复~~ ✅ 已完成（§0.1）。
3. ~~Markdown Typora 风格所见即所得与标题栏单行优化~~ ✅ 已完成（§0.1）。
4. ~~Windows Release 无法关闭 Bug~~ ✅ 已完成（§0.1）。
5. **dmg 打包失败**：`bundle_dmg.sh` 报 Finder AppleEvent 超时（-1712），本机 Finder 脚本执行
   环境问题，与代码无关。.app 本身可靠产出；dmg 可换机器/重启 Finder 后重试。
6. **§12.2 真机 8 项验收**：已自动化 3 项 + 单设备 UI 全流程；克隆 Host Key 检测、
   同 IP 抢占等 5 项需两台真实设备。
7. vite dev 首启竞态：lockfile 变化后首次加载可能白屏（Re-optimizing 竞态），刷新即可；
   仅 dev 存在。
8. 屏幕控制（CUA）权限代理挂起：macOS/Windows 均存在（§5.6）。UI 回归建议人工执行。

### 5.3 踩坑速查（代码层面）
| 坑 | 结论 |
|---|---|
| Tauri 2 capability 窗口关闭拦截 | Release 环境下，前端调用 `window.destroy()` 需显式在 `capabilities/default.json` 声明 `"core:window:allow-destroy"` 和 `"core:window:allow-close"`，否则被静默拦截导致窗口无法关闭。建议配合 Rust 侧 `exit_app`（`app.exit(0)`）双重保障。 |
| Windows 无边框与原生菜单 | 设置 `decorations: false` 禁用原生 Win32 标题栏与亮色双层菜单后，需在 HTML 层使用 `data-tauri-drag-region` 配合前端自研暗色标题栏，实现 VS Code 风格单行菜单 + 窗口控制。 |
| 远程文件树前缀丢失 | `list_dir` 必须保留 `remote://{id}` 和 `wsl://{distro}` 协议前缀，否则前端点击子节点或文件时路径退化为普通本地路径无法访问。 |
| WSL 发行版探测与控制台编码 | `wsl.exe -l -v` 输出为 Windows 控制台 UTF-16LE 编码，直接以 UTF-8 读取会导致乱码甚至空结果，需按 `u16` 解码后转 UTF-8。 |
| 全局搜索字符偏移 | Rust 字符串 `pos` 匹配返回字节偏移，若包含中文等多字节字符直接传给前端高亮会错位，须转换为 Unicode 标量字符数 `line_lower[..pos].chars().count()`。 |
| serde 枚举序列化 | `#[serde(tag, rename_all)]` 只改变体名；变体字段需 `rename_all_fields = "camelCase"`（已加回归测试 `connect_outcome_serializes_camel_case`） |
| monaco-editor 0.5x 包导出 | exports map `./*`→`./esm/vs/*`，深路径写 `monaco-editor/editor/editor.worker`（无 `vs` 前缀） |
| base64 crate | STANDARD 引擎解码要求规范填充；指纹（43 字符无填充）需 `DecodePaddingMode::Indifferent`（`host_key_verifier.rs` 的 `B64` 引擎） |
| russh 0.65 | 通道 IO 用 `channel.split()` → read_half.wait() 处理 `ChannelMsg::{Data,ExtendedData,ExitStatus,Eof,Close}`；写用 `write_half.data_bytes()`；**不要**持 std MutexGuard 跨 await（会污染 async command 的 Send） |
| russh-sftp 3.0 | `session.write()` 只带 WRITE 标志不 CREATE——写文件必须用 `sftp.create()`（CREATE\|TRUNCATE\|WRITE）；write_file 在 `filesystem/sftp.rs` |
| keyring 4.x | 默认 feature 已含 Keychain/Credential Manager，不要加 `apple-native`（v3 的 feature，4.x 会编译失败） |
| Rust 通道模型 | Tauri 长输出用 `tauri::ipc::Channel`；产品层用 `EventSink = Arc<dyn Fn(Value)+Send+Sync>` 抽象（测试可传闭包），见 `app_services/terminal.rs` |

## 6. 代码地图（关键入口）

```
src/                                      # 前端（React）
  components/common/TitleBar.tsx          # 单行 VS Code 风格暗色标题栏、品牌 Logo、菜单组、窗口控制
  components/editor/EditorArea.tsx        # 编辑器区：模式切换/菜单事件/设置弹窗
  components/markdown/MarkdownWysiwyg.tsx # Typora 风格所见即所得 Markdown 原地编辑器
  components/wsl/WslPanel.tsx             # WSL 管理面板：发行版列表、家目录一键打开
  components/ssh/SshPanel.tsx             # 远程设备面板：Profile CRUD/连接/指纹登记/环境检测
  components/terminal/TerminalPanel.tsx   # 底部面板：xterm 终端/任务运行/问题列表
  components/discovery/DiscoveryPanel.tsx # 局域网发现
  lib/domToMarkdown.ts                    # 轻量级 DOM 转 Markdown 序列化引擎
  lib/models.ts                           # Monaco Model 注册表（URI 唯一性，保护 wsl:// 与 remote://）
  lib/problems.ts                         # Problem Matcher（gcc/clang/python）
  services/wsl.ts                         # 前端 WSL IPC 封装
  stores/                                 # zustand：tabs/explorer/ui
src-tauri/src/
  lib.rs                                  # AppState/菜单/命令注册/退出清理
  commands/
    app.rs                                # 应用级命令（exit_app 退出兜底）
    fs.rs                                 # 薄层：fs(URI 调度，支持 remote/wsl/local 前缀与规范化)
    wsl.rs                                # WSL 命令（列出发行版、家目录路径、运行任务）
    ssh.rs / terminal.rs / discovery.rs / lsp.rs / workspace.rs
  filesystem/                             # provider trait + local.rs + sftp.rs + remote_uri.rs(WSL UNC 支持)
  ssh/                                    # client.rs(russh 编排) / host_key_verifier.rs / device_pool.rs
  app_services/
    wsl.rs                                # WSL 发行版 UTF-16LE 探测与解码、任务执行
    connection_profiles.rs / ssh_sessions.rs / terminal.rs / discovery.rs / lsp.rs / search.rs
  storage/                                # database.rs(迁移 v1→v2) / secret_store.rs(keyring)
scripts/
  fix-macos-bundle.sh                     # 打包后 Info.plist 补丁+重签（必跑）
  dev-runner.sh                           # cargo runner 自动签名
  e2e-server/                             # 本地 SSH 测试服务器
  gen_icon.py                             # 图标源图生成
docs/
  Glance-IDE_技术架构与实施路线图_v3.0.md    # 架构权威文档
  开发计划_v1.0.md                           # 里程碑与验收映射
```

## 7. 数据库与迁移

SQLite（app_data_dir/glance.db，PRAGMA user_version 管理）。当前 v2。
**新增迁移的正确姿势**：在 `storage/database.rs` 追加 `MIGRATION_V3` 常量 + 加入 MIGRATIONS 数组 +
写一条「旧版本库→新版」迁移测试（参照 `migration_v2_adds_key_path_column`）。
迁移前自动备份为 `.db.bak-v<旧版本>-<时间戳>`。

## 8. 下一步建议（优先级）

1. **真机 8 项验收补全**：找第二台设备做克隆 Host Key/同 IP 抢占场景（§12.2）。
2. **设置面板实质化**：主题/字号/终端外观（现为止占位弹窗）。
3. **凭据体验**：Device Identity 级凭据 override（§4.5 同设备不同凭据场景）。
4. **dmg 修复**：换环境或排查 Finder AppleScript。

## 9. 安全红线（每次改动自查）

1. 未知/变化 Host Key 不自动放行（ADR-007）——`device_pool.rs` 逻辑勿绕过。
2. SQLite/日志无明文凭据——密码只经 keyring；`credential_ref` 形如 `glance://profile/<id>`。
3. 缓存/LSP/构建历史以 `device_identity_id` 为键，不以 IP。
4. 离线红线：不引入 CDN/在线字体/账号服务；Monaco Worker 随包分发。
5. 扫描不认证不建信任；PTY 与 exec/LSP 通道分离。
