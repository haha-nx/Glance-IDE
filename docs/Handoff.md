# Glance IDE — 项目交接与当前进度文档（Handoff）

> 基线版本：`v0.1.3`（包含 SSH/WSL 文件与文件夹实时进度传输、完成后 5 秒自动隐藏、进度流式无感原地/静默更新、项目交接与开发规范整合）
> 更新日期：2026-11-13 · 适用平台：Windows / macOS（兼顾 Linux AppImage）
> 开发规范与界面按钮规范已整合至 **[docs/开发规范.md](开发规范.md)**。

---

## 1. 项目概览

Glance IDE 是本地/远程一体化桌面开发工作台。以本机为控制中心，统一处理：

- 本地文件与工程编辑
- Windows WSL 子系统工作区
- 局域网 Linux 设备（树莓派等）SSH / SFTP 工作区与文件传输
- 代码与 Markdown 编辑、Monaco Diff、全局搜索
- 本机 / WSL / SSH 终端，多窗格分屏
- Git 更改管理、提交图谱与工作树（Worktrees）
- 局域网设备发现、远程构建任务、远程语言智能（LSP）
- 应用版本检测与原地/静默更新

**核心数据模型（不可破坏）**：网络端点 / 连接配置 / 设备身份 / 远程工程环境 四层分离。

- 远程 SSH 资源以 `remote://{device-identity-uuid}/path` 编址
- WSL 资源以 `wsl://{distro_name}/path` 编址，Windows 侧解析为 `\\wsl.localhost\{distro}\{path}`（回退 `\\wsl$\{distro}\{path}`）
- 未知或变化的 SSH Host Key 永不自动放行
- 凭据只进 OS 钥匙串（macOS Keychain / Windows Credential Manager）

---

## 2. 技术栈

| 层 | 选型（当前版本） |
|---|---|
| 桌面容器 | Tauri `2.12`（Windows WebView2 / macOS WKWebView） |
| 前端 | React `19.3` + TypeScript `6.0`（strict）+ Vite `8.3` + Tailwind CSS `4.3` + Zustand `5.1` |
| 编辑器 | Monaco Editor `0.57`（ESM + Worker 全离线打包） |
| 终端 | xterm.js `6.0` + FitAddon `0.11` |
| 后端 | Rust + Tokio `1` |
| SSH / SFTP | `russh 0.65` / `russh-sftp 3` |
| 本机 PTY | `libc` `openpty`（仅 Unix） |
| 存储 | SQLite（`rusqlite 0.41`，`PRAGMA user_version` 迁移，当前 schema v2） |
| 凭据 | `keyring 4`（Keychain / Credential Manager） |
| 局域网发现 | `mdns-sd 0.13` + 自建 CIDR 并发 TCP 扫描 |

离线红线：不依赖 CDN、在线字体、账号服务或远程中继；Monaco Worker 随安装包分发。

---

## 3. 开发进度总览

### 3.1 里程碑与功能就绪状态

| 模块 | 状态 | 进度与验证说明 |
|---|---|---|
| M0–M1 核心壳与本地工作区 | 已完成（已发布） | Monaco 多分组分屏、标签拖拽拆分、Typora 风格 Markdown、全局搜索、问题面板、`ui_state` 持久化与恢复 |
| M2–M3 SSH 连接与 SFTP/WSL 浏览 | 已完成（已发布 + v0.1.3 修复） | Host Key 登记/阻断、设备池、掉线监控与重连；v0.1.3 补全悬空符号链接列举/删除安全与 WSL `Stopped` 自动唤醒 |
| M4 本机 / 远程 / WSL 终端 | 已完成（已发布） | 多窗格分屏/拖拽/最大化；macOS/Linux 真 PTY（`openpty`），Windows `powershell.exe` + `CREATE_NO_WINDOW` |
| M5 局域网发现与直连 | 已完成（已发布） | 物理网卡探测、过滤代理/VPN 虚拟网卡、CIDR TCP 扫描、SSH banner 分级、命中已存配置直接连接 / 未保存预填新建 |
| M6 远程语言智能（LSP） | 已完成（已发布） | `clangd` / `pylsp` 只读探测、SSH 无 PTY `exec` 通道 + Rust JSON-RPC 组帧 + Monaco 补全/悬停/定义/诊断 |
| M7 Git 与工作树（Worktrees） | 已完成（已发布） | 更改/图形两栏、分支管理、Sync、提交/推送、SVG 提交图谱、Worktree CRUD、Monaco Diff（含远端提交文件对比） |
| M8 双端窗口与 UI 规范统一 | 已完成（已发布 `v0.1.2`） | Windows 无边框自绘单行暗色标题栏；macOS 原生 Overlay 标题栏与系统顶部 `NSMenu`；统一按钮交互与 250ms 全局 Tooltip |
| **文件/文件夹上传下载（v0.1.3）** | **已编码实现，待实机 SSH/WSL 联调** | 256 KiB 分块流式传输、独立 SFTP 传输通道、实时进度条队列（完成/取消 5s 自动隐藏）、OS 拖拽上传、右键/工具栏入口、冲突覆盖/跳过与取消清理；已通过 Rust 本地测试，待连真实 SSH/WSL 实测 |
| **无感原地/静默更新（v0.1.3）** | **已编码实现，待 CI 实包跨版本实测** | GitHub Releases 进度流下载（存应用缓存）、取消下载、macOS 原地替换 `.app` 重开、Windows NSIS/MSI 后台静默覆盖重启、未保存标签守卫、`release.yml` 双端流水线 |

---

## 4. 当前已实现功能详解

### 4.1 编辑器与工作区

- Monaco 多标签编辑，按「列 × 行」网格的多分组分屏，分隔条可拖拽调权
- 标签拖拽：跨分组移动、拖到编辑区四边拆分新分组
- 保存冲突检测（`mtime`）、原子写、路径穿越防护
- Markdown 所见即所得（Typora 风格）：原地编辑、表格行列调整、大纲、右键菜单、`document.execCommand` 原生撤销
- 全局搜索：中文高亮偏移按 Unicode 标量计算
- 问题面板：Problem Matcher（`gcc`/`clang`/`python`）→ 点击跳转源码位置
- 工作区/标签/`ui_state` 持久化；启动自动恢复

### 4.2 资源管理器与文件传输

- 本地 / `remote://` / `wsl://` 三类根目录统一懒加载（含悬空符号链接安全展示与安全删除）
- 新建文件/文件夹（统一走 `joinChildPath`，修复根目录双斜杠）、重命名、删除、刷新、空白处/条目右键菜单
- 修复 `explorerStore.parentOf` 对 `remote://uuid/`、`wsl://distro/` 根子项及 Windows `\` 分隔符的父路径解析
- 远程目录缓存按 `device_identity_id` 隔离，会话重连后自动失效重载
- **文件与文件夹传输（v0.1.3）**：
  - 入口：资源管理器顶部工具栏（上传文件/上传文件夹）、节点与空白区右键菜单（上传到当前/所在目录、下载文件/文件夹）、系统文件管理器直接拖拽入资源管理器（通过 Tauri `onDragDropEvent` + DPR 换算定位具体目录高亮）
  - 后端：`app_services/transfer.rs` + `commands/transfer.rs`，支持目录递归预扫描（空目录、0 字节文件、跳过目录符号链接与悬空链接、禁止本地自包含拷贝）、256 KiB 分块流式拷贝、80ms 节流 `Channel` 进度推送、取消立即清理当前未完成半成品文件
  - 冲突处理：传输前调用 `check_transfer_conflicts` 预检，弹窗提供「覆盖同名项 / 跳过已存在 / 取消」
  - 进度呈现：底部可折叠 `TransferQueuePanel`（含速度、已传/总大小、百分比、取消、完成后在 Finder/资源管理器中定位，完成/取消项 5 秒后自动移除并在队列为空时隐藏窗口，失败项保留以便查看错误）与 `StatusBar` 实时传输汇总徽标

### 4.3 Git

- 侧边栏上下两栏：「更改」+「图形」，比例可拖拽
- 更改区：分支切换/新建、同步（Fetch/Pull/Push、超前落后计数）、提交/提交并推送/自动暂存、已暂存与工作区更改、暂存/取消暂存/放弃（单文件与全部）、工作树（Worktrees）管理
- 图形区：多分支拓扑 SVG 提交图谱、分支/远程/标签徽标、未提交虚拟节点、按提交查看变更文件
- Monaco Diff：工作区 vs 暂存区、暂存区 vs HEAD、提交 vs 父提交；支持并排/行内切换
- 支持本地、WSL、远程 SSH 仓库

### 4.4 远程连接（SSH / WSL）

- 统一的远程连接面板：Windows 下左上角切换 SSH / WSL；**macOS 只显示 SSH**（不渲染 WSL 标签与视图）
- 活动栏入口在 macOS 上显示为「远程连接」，Windows 为「远程连接与 WSL」
- SSH：连接配置 CRUD；设备身份（Host Key 指纹）首次登记、变更阻断；一个配置可绑定多台设备身份（设备池）；连接替换语义（新握手成功才清旧会话）
- WSL：发行版探测（UTF-16LE 解码）、家目录直达；Windows 访问自动兼容 `\\wsl.localhost` 与 `\\wsl$`，若发行版处于 `Stopped` 状态则自动无窗口唤醒后再读/写/传输；仅 Windows 可用
- 连接动作：当前窗口直连（打开远程工作区）或新窗口连接
- 启动自动重连同配置；失败弹窗支持「打开远程配置 / 切换到本地 / 重试连接」

### 4.5 终端

- 底部面板：终端 / 任务 / 问题 三个页签
- 终端类型：本机、SSH 远程、WSL（WSL 仅 Windows）；按当前工作区上下文自动选择
- 每个窗格独立标签栏，支持连续分屏、拖拽跨窗格重排、标签拖到窗格边缘拆分
- 终端最大化/还原；底栏高度与侧边栏宽度可拖拽并持久化
- Windows：`powershell.exe`，管道 + `CREATE_NO_WINDOW`，`\r` 自动补 `\n`
- macOS/Linux：`$SHELL` 经真实 PTY（`openpty` + `setsid` + `TIOCSCTTY`），`TIOCSWINSZ` 同步窗口尺寸

### 4.6 局域网发现

- 网段前三段 + `1→254` + 端口输入，自动填入本机物理网卡 IP
- 过滤代理 / VPN / 虚拟机网卡与保留网段；默认路由优先
- CIDR 并发 TCP 扫描 + SSH banner 分级；后端保留 mDNS 能力（当前面板以网段扫描为主）
- 结果只显示确认可连 SSH 的设备
- 点击连接：**命中已保存配置（host + port 一致）→ 直接在当前窗口发起连接**；未保存过 → 跳到远程面板并预填 IP/端口打开新建配置
- 首次扫描兜底：等待本机网段探测落定、使用真实网段；若首次零结果自动重试一次（兼容 macOS 首次局域网权限静默拦截与 ARP 冷启动）

### 4.7 设置与无感更新

- 四套主题（`dark` / `midnight` / `nord` / `light`），全界面与 Monaco/终端同步
- 字号 10–24px；侧边栏宽度、底栏高度持久化
- GitHub Releases 版本检测与带进度流下载（「自动检测」「自动下载」默认关闭）：
  - 更新包缓存在 `app_cache_dir/updates` 并清理旧包，不再污染 `~/Downloads`
  - 实时进度条 + 速率展示 + 随时取消（`cancel_update_download`）
  - **一键重启更新（`apply_update_and_restart`）**：
    - macOS：优先 `.app.tar.gz`/`.app.zip`，回退静默挂载 `.dmg` → 预先校验并暂存 `.app`、清除隔离属性 → 脱离式脚本等待退出后原子替换目标 `.app` 并重开
    - Windows：优先 NSIS `-setup.exe`（`/S /D=$installDir`），回退 `.msi`（`/passive /norestart`）→ UTF-8 BOM PowerShell 后台静默覆盖并重启
    - Linux：AppImage 就地替换并重开，其余格式回退系统打开
  - 重启更新前统一触发未保存标签守卫（保存/丢弃/取消），再调用 `shutdown_runtime_sessions` 优雅断开 SSH/终端/LSP/传输任务
- 关于页：版本、平台、凭据存储位置说明

### 4.8 多窗口与会话生命周期

- `文件 → 新建窗口` 打开全新空白工作台（不继承主窗口工作区/标签/SSH 环境）
- 新窗口参数：`?open_folder=`、`?connect_ssh=`、`?connect_wsl=`
- 非最后窗口关闭不退出进程；最后一个窗口关闭才退出
- SSH 会话掉线监控：每 2s 探测传输状态，设备关机/断网时弹窗「重新连接 / 断开连接」
- 僵尸会话自动清理；按设备身份路由到最新活跃会话

### 4.9 远程语言智能

- 语言服务器检测（`clangd` / `pylsp` / `pyright-langserver`，只读不安装）
- ROS 2 / CMake / Python 工程识别与 `compile_commands.json` 指纹
- 远程 LSP 桥：SSH `exec`（无 PTY）通道 + Rust JSON-RPC 组帧 + Monaco 桥（补全/悬停/定义/诊断），按设备身份隔离

**M6 LSP Spike 结论（冻结方案）**：
- 传输层采用 Tauri Channel（Rust 侧 SSH `exec` 无 PTY 字节透传 + JSON-RPC `Content-Length` 组帧/解帧），不引入本地 WebSocket。
- 前端不引入 `monaco-languageclient`（8.x/9.x 强绑定 `@codingame/monaco-vscode-api` 全家桶，与现有 vanilla Monaco 架构冲突），直接自建轻量 JSON-RPC 到 Monaco 映射。
- 会话缓存键按 `device_identity_id + workspace_root + language` 隔离；同步策略采用 `didChange` 全量文本 + 250ms 防抖。

---

## 5. 架构与数据流

### 5.1 分层

```
前端 React
  components/   UI 视图（App Shell / TitleBar / ExplorerPanel / TransferQueuePanel / EditorArea / TerminalPanel / GitPanel / RemotePanel / DiscoveryPanel / SettingsModal / StatusBar）
  stores/       Zustand 状态（tabs / explorer / transfer / git / settings / updater / tabDrag / ui）
  services/     Tauri Command & Channel 封装（files / ssh / terminal / git / discovery / lsp / updater / workspace / wsl）
  lib/          Monaco 模型表、Problem Matcher、DOM↔Markdown、平台判定、字节格式化、窗口状态
  types/        前后端 IPC / SSH / WSL 类型契约

Rust（src-tauri/src）
  commands/     薄命令层（参数校验 → 领域层调用，不承载复杂状态）
  app_services/ 领域服务（ssh_sessions / connection_profiles / transfer / terminal / lsp / discovery / search / wsl）
  filesystem/   FileSystemProvider trait + local / sftp / remote_uri
  ssh/          russh 编排、Host Key 校验、设备池
  storage/      SQLite（PRAGMA user_version 迁移）、OS 凭据库（keyring）
```

### 5.2 IPC 与通道

| 场景 | 机制 |
|---|---|
| 文件/目录/配置读写、冲突预检、取消操作 | Tauri Command（短请求-响应） |
| 终端输出、扫描结果、LSP、文件传输进度、更新下载进度 | `tauri::ipc::Channel` 流式推送 |
| 会话状态、菜单动作 | Tauri Event；前端跨组件动作走 DOM `CustomEvent`（`glance:*`） |

**通道分离**：PTY（交互终端）、`exec`（构建任务）、LSP、文件传输 SFTP（`open_transfer_sftp`）各自独立，互不阻塞。

### 5.3 数据库

SQLite（`app_data_dir/glance.db`），当前 schema v2，迁移前自动备份为 `.db.bak-v<旧版本>-<时间戳>`。主要表：`connection_profiles`、`device_identities`、`profile_identity_bindings`、`remote_environments`、`ui_state`。

---

## 6. 关键双端差异与踩坑速查

| 方面 | Windows | macOS |
|---|---|---|
| 窗口与标题栏 | `decorations: false` + HTML 自绘单行暗色栏 + 窗口三键 | `tauri.macos.conf.json` 覆盖 `decorations: true` + `titleBarStyle: "Overlay"` + `hiddenTitle: true` + 红绿灯（`pl-[76px]`） |
| 菜单 | 窗口内自绘菜单栏 | 系统顶部原生 `NSMenu`（首位必须为 App 菜单；顶层无子菜单项不渲染） |
| 终端 | `powershell.exe -NoLogo` + 管道 + `CREATE_NO_WINDOW` | `$SHELL` + `openpty` 真 PTY + `setsid` / `TIOCSCTTY` + `TIOCSWINSZ` |
| WSL | 完整入口与终端；支持 `\\wsl.localhost` / `\\wsl$` 及停机唤醒 | 完全隐藏 WSL 入口与视图；后端兜底拒绝 |
| 凭据库 | Credential Manager | Keychain |
| 更新打包产物 | MSI + NSIS (`*-setup.exe`)，支持 `/S /D=...` 静默覆盖 | 执行 `scripts/fix-macos-bundle.sh` 后打包 `.app.tar.gz` + `.dmg`，支持原地替换 `.app` |
| 本地网络权限 | — | macOS 26 强制按签名归属授权：`dev-runner.sh` / `fix-macos-bundle.sh` 必跑 |

### 常见关键坑（详情见 [开发规范.md](开发规范.md)）

- Release 下窗口关闭需在 `capabilities/default.json` 授权 `core:window:allow-destroy`/`allow-close` 并以 `exit_app` 兜底。
- `data-tauri-drag-region` 已内置双击最大化，不要再额外绑 `onDoubleClick`。
- 多窗口共享 `localStorage`：空白窗口（`?blank=1`）禁止读写历史工作区与终端设备状态；`StrictMode` 卸载清理需识别实例归属，防止打断首次扫描。
- Tauri 默认拦截 webview 原生拖拽，OS 文件拖入需监听 `getCurrentWebview().onDragDropEvent` 并按 `devicePixelRatio` 换算坐标。
- `russh 0.65` 禁止持 `std::sync::MutexGuard` 跨 `await`；`russh-sftp 3.0` 写文件必须走 `sftp.create()`；大文件流式完毕必须 `file.close().await` 刷完管线 ACK。

---

## 7. 构建、CI 与测试状态

### 7.1 工具链与常用命令

```bash
# 本机工具链不在默认 PATH 时先导入
export PATH="$HOME/tools/nodejs/bin:$HOME/.cargo/bin:$PATH"

npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsc && vite build
npm run tauri dev    # 桌面开发模式（macOS 通过 dev-runner.sh 自动 ad-hoc 签名）
npm run tauri build  # 发布构建（macOS 后必须跑 bash scripts/fix-macos-bundle.sh）
```

### 7.2 CI 自动发布（`.github/workflows/release.yml`）

- 触发条件：推送 `v*` Tag 或手动 `workflow_dispatch`。
- `build-macos`：构建 universal `.app` → 执行 `scripts/fix-macos-bundle.sh` → 打出修复后的 `.app.tar.gz` 与 `.dmg` 上传 GitHub Release。
- `build-windows`：在 `windows-latest` 构建并上传 `*-setup.exe` 与 `*.msi` 至同一 Release。

### 7.3 自动化测试情况（2026-11-13 最新实测）

- `npm run typecheck` + `npm run build`：通过（`tsc --noEmit` 与 `vite build` 均退出 0）。
- `cargo test --lib`：**54 passed, 0 failed**（含文件传输本地全流程/空目录/零字节/二进制/符号链接/自包含拦截、本地 `symlink_metadata` 悬空链接修复、WSL UNC 前缀/路径规范化、更新器资产匹配与 shell 转义）。
- `cargo test --test ssh_interop`（共 4 项，含新增 `interop_transfer_upload_and_download`）：编译与执行均退出 0，但因当前环境未安装 `ssh2` 运行 [server.js](../scripts/e2e-server/server.js) 且未配置 `GLANCE_SSH_TEST_PORT`，运行时自动跳过。
- `cargo test --test windows_platform`：既有测试第 79 行（`uri.to_windows_path()`）存在未修复的编译报错（属历史遗留）。
- 真机验证测试套：`cargo test --test macos_terminal`、`cargo test --test real_device`、`cargo test --test lsp_bridge`（需连接真实设备或本机环境配合环境变量执行）。

---

## 8. 代码地图

```
src/
  App.tsx                                  应用壳：布局、快捷键、多窗口守卫、更新重启确认
  components/
    common/                                TitleBar / ActivityBar / StatusBar / SettingsModal / TooltipLayer / Modal / ErrorBoundary / icons
    explorer/                              ExplorerPanel（含拖拽上传与右键菜单）/ TreeNode / TransferQueuePanel
    editor/                                EditorArea / TabBar / MonacoHost / GitDiffView / Dialogs
    search/                                SearchPanel（按 Unicode 标量偏移高亮）
    git/                                   GitPanel / CommitGraph
    remote/RemotePanel.tsx                 统一 SSH / WSL 面板
    ssh/                                   ConnectDialogs / ProfileDialog（SshPanel 为早期遗留）
    terminal/TerminalPanel.tsx             多窗格终端 + 任务 + 问题
    discovery/DiscoveryPanel.tsx           局域网设备扫描与直连
    markdown/MarkdownWysiwyg.tsx           Typora 风格所见即所得（MarkdownPreview 为早期遗留）
    wsl/WslPanel.tsx                       早期遗留组件
  lib/                                     format / models / monaco / platform / problems / domToMarkdown / windowState / lsp/remoteLsp
  stores/                                  explorer / transfer / tabs / git / settings / updater / tabDrag / ui
  services/                                files / ssh / terminal / git / discovery / lsp / updater / workspace / wsl
  types/                                   ipc / ssh / wsl

src-tauri/src/
  lib.rs                                   AppState / macOS NSMenu / invoke_handler / shutdown_runtime_sessions
  commands/                                app / discovery / fs / git / lsp / ssh / terminal / transfer / updater / workspace / wsl
  app_services/                            connection_profiles / discovery / lsp / search / ssh_sessions / terminal / transfer / wsl
  filesystem/                              provider / local / sftp / remote_uri
  ssh/                                     client / device_pool / host_key_verifier
  storage/                                 database / secret_store
```

---

## 9. 下一步待验证与后续规划

### 当前最优先验证（v0.1.3 实机收口）

1. **真实 SSH 环境文件/文件夹传输联调**：搭建本地 `ssh2` 环境启动 [server.js](../scripts/e2e-server/server.js) 跑通 `ssh_interop`，并在局域网真实 Linux/树莓派设备验证大文件拖拽上传、批量下载、途中取消与断网恢复。
2. **真实 Windows + WSL 环境联调**：验证 WSL `Stopped` 状态下直接访问/传输是否稳定唤醒、大文件夹经 UNC 传输速度与进度条精度、NSIS `/S /D=...` 静默升级重启表现。
3. **发布态原地更新实测**：在下一个版本 Tag 发布后，用旧版打包产物 `.app` / `-setup.exe` 实测从检测→进度下载→自动替换重启的完整升级链路。
4. 修复历史遗留测试 [windows_platform.rs](../src-tauri/tests/windows_platform.rs) 第 79 行失效方法调用。

### 中长期路线图

1. 第二台真实 SSH 设备补齐设备池安全验收（克隆 Host Key、同 IP 抢占、身份轮换）。
2. Device Identity 级凭据 override（同一设备不同账号独立凭证）。
3. 更多远程语言服务器（rust-analyzer / gopls / typescript-language-server）与工程识别支持。
4. 远程文件内容缓存与容量管理。
5. 正式商业代码签名与公证（macOS Developer ID + Notarization / Windows Authenticode）。
