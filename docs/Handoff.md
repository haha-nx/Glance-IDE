# Glance IDE — 项目交接与当前进度文档（Handoff）

> 基线版本：`v0.1.6`（包含 `v0.1.4` 多窗口隔离与传输调优、`v0.1.5` 编辑器报错显示开关、`v0.1.6` 标签栏优化及全栈 P0–P2 稳定性/安全性/性能重构与 CI 建设）
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
| **文件/文件夹上传下载（v0.1.3 / v0.1.6 并发升级）** | **已编码实现 + 并发升级，待实机 SSH/WSL 联调** | 256 KiB 分块流式传输、独立 SFTP 传输通道池（多文件扩展至最多 4 并发 Worker）、实时进度条队列（完成/取消 5s 自动隐藏）、OS 拖拽上传、冲突覆盖/跳过与取消清理；已通过 Rust 本地测试，待连真实 SSH/WSL 实测 |
| **无感原地/静默更新（v0.1.3 / v0.1.6 安全加固）** | **已编码实现 + 摘要/包体校验加固，待 CI 实包跨版本实测** | GitHub Releases 进度流下载（存应用缓存）、`SHA256SUMS.txt` 回退摘要校验、macOS 仅移除 `com.apple.quarantine` 并校验 Bundle ID 与代码签名、Windows NSIS/MSI 静默覆盖重启、未保存标签守卫、`release.yml` `--draft` 双端校验流水线 |
| **多窗口隔离与目录递归同步（v0.1.4）** | **已发布（`v0.1.4`）** | 原生菜单聚焦窗路由、各窗布局尺寸独立、SSH 断线按设备定位唯一活跃窗提醒；命令/焦点触发可见目录层级递归并行刷新 |
| **编辑器设置与标签体验（v0.1.5–v0.1.6）** | **已完成** | 「报错显示」开关（默认关闭）、「仅保留修改文件」标签替换开关（默认关闭）；标签栏改为 3px 细滚轮横向滚动条并禁纵轴滚动条 |
| **全栈 P0–P2 重构与 CI 建设（v0.1.6）** | **已完成（待发版验证）** | 退出前会话回收、最后终端关闭联动折叠底栏、SSH 凭据/LSP 隔离与通道防丢包；流式全文搜索、Vite 分块 + `React.lazy` 懒加载；Rust 轮转日志、前后端大文件模块化拆解、Toast/Modal 替代 `alert`/`prompt`、浅色对比度修复、历史集成测试修复与三端 PR CI |

---

## 4. 当前已实现功能详解

### 4.1 编辑器与工作区

- Monaco 多标签编辑，按「列 × 行」网格的多分组分屏，分隔条可拖拽调权；顶部标签栏采用 3px 细滚轮横向滚动条（禁用原生宽滚动条、纵轴滚动条及指针拖拽）
- 标签策略：设置内提供「仅保留修改文件」开关（默认关闭），开启后新开文件优先替换当前分组内的未修改标签，防止标签栏无限膨胀
- 标签拖拽：跨分组移动、拖到编辑区四边拆分新分组
- 保存冲突检测（`mtime`）、原子写、路径穿越防护
- 报错诊断开关：设置内提供「报错显示」开关（默认关闭），开启时启用 Monaco 内置校验及远程 LSP 诊断标记
- Markdown 所见即所得（Typora 风格）：原地编辑、表格行列调整、大纲、右键菜单、`document.execCommand` 原生撤销
- 全局搜索：前端按 Unicode 标量计算中文高亮偏移，后端 `search.rs` 使用 `BufReader` 逐行流式读取（4KB 二进制 `\0` 嗅探、64KB 超长行跳过、ASCII 零分配大小写匹配与复用小写缓冲）
- 问题面板：Problem Matcher（`gcc`/`clang`/`python`）→ 点击跳转源码位置
- 工作区/标签/`ui_state` 持久化；启动自动恢复（逻辑已抽离至 `hooks/useWorkspacePersistence.ts`）

### 4.2 资源管理器与文件传输

- 本地 / `remote://` / `wsl://` 三类根目录统一懒加载（含悬空符号链接安全展示与安全删除）
- 新建文件/文件夹（使用应用内 `Modal` 替代原生 `prompt()` 并统一走 `joinChildPath`）、重命名、删除（统一走 `DangerButton` 确认）、刷新、空白处/条目右键菜单
- 多源自动同步：按展开层级递归并行刷新，终端命令提交及窗口聚焦后触发节流刷新，解决多级目录增删文件不更新问题
- 远程目录缓存按 `device_identity_id` 隔离，会话重连后自动失效重载
- **文件与文件夹传输（v0.1.3 + v0.1.6 并发升级）**：
  - 入口：资源管理器顶部工具栏（上传文件/上传文件夹）、节点与空白区右键菜单（上传到当前/所在目录、下载文件/文件夹）、系统文件管理器直接拖拽入资源管理器（通过 Tauri `onDragDropEvent` + DPR 换算定位具体目录高亮）
  - 后端：`app_services/transfer/`（已拆分为 `mod.rs` / `types.rs` / `scanner.rs` / `runner.rs`）+ `commands/transfer.rs`；支持目录递归预扫描（空目录、0 字节文件、跳过目录符号链接与悬空链接、禁止本地自包含拷贝）、256 KiB 分块流式拷贝、多文件任务打开最多 `CONCURRENT_FILE_WORKERS = 4` 条独立 SFTP 通道并由 `JoinSet` 并发执行、原子计数器 `SharedProgress` + 80ms 节流 `Channel` 进度推送、失败或取消立即中止关联 Worker 并 `cleanup_partial`
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
- 每个窗格独立标签栏，支持连续分屏、拖拽跨窗格重排、标签拖到窗格边缘拆分；仅剩最后一个终端关闭时销毁会话并自动关闭下边栏
- 终端最大化/还原；底栏高度与侧边栏宽度可拖拽并持久化
- 通道关闭采用 `close_flag` + `Notify` 防高吞吐背压丢包，进程退出时协调回收避免句柄泄漏
- Windows：`powershell.exe`，管道 + `CREATE_NO_WINDOW`，`\r` 自动补 `\n`
- macOS/Linux：`$SHELL` 经真实 PTY（`openpty` + `setsid` + `TIOCSCTTY`），`TIOCSWINSZ` 同步窗口尺寸

### 4.6 局域网发现

- 网段前三段 + `1→254` + 端口输入，自动填入本机物理网卡 IP
- 过滤代理 / VPN / 虚拟机网卡与保留网段；默认路由优先
- CIDR 并发 TCP 扫描 + SSH banner 分级；后端保留 mDNS 能力（当前面板以网段扫描为主）
- 结果只显示确认可连 SSH 的设备
- 点击连接：**命中已保存配置（host + port 一致）→ 直接在当前窗口发起连接**；未保存过 → 跳到远程面板并预填 IP/端口打开新建配置
- 首次扫描兜底：等待本机网段探测落定、使用真实网段；若首次零结果自动重试一次（兼容 macOS 首次局域网权限静默拦截与 ARP 冷启动）

### 4.7 设置、无障碍规范与无感更新

- 四套主题（`dark` / `midnight` / `nord` / `light`），全界面与 Monaco/终端同步；修复 `light` 主题下红/黄/绿状态色与搜索高亮的视觉对比度
- 字号 10–24px；侧边栏宽度、底栏高度按窗口持久化
- 交互一致性：全局引入 `ToastHost`（`stores/toast.ts`）与 `invokeIpc<T>`（`lib/ipc.ts`），移除全项目阻塞式原生 `alert()`/`prompt()`；`Modal` 统一提供 `role="dialog"`、`aria-modal="true"`、`aria-labelledby` 与 `Escape` 键关闭支持
- GitHub Releases 版本检测与带进度流下载（「自动检测」「自动下载」默认关闭）：
  - 更新包缓存在 `app_cache_dir/updates` 并清理旧包，不再污染 `~/Downloads`
  - 校验机制：优先验证 Release API 返回的 `asset.digest`，若未提供则回退拉取同版本 `SHA256SUMS.txt` 校验 SHA-256 摘要
  - 实时进度条 + 速率展示 + 随时取消（`cancel_update_download`）
  - **一键重启更新（`apply_update_and_restart`）**：
    - macOS：优先 `.app.tar.gz`/`.app.zip`，回退静默挂载 `.dmg` → 校验 `CFBundleIdentifier` 等于 `"com.glance.ide"` 与 `Contents/MacOS` 目录、存在签名时运行 `codesign --verify --deep --strict`、仅精准移除 `com.apple.quarantine` 属性 → 脱离式脚本等待退出后原子替换目标 `.app` 并重开
    - Windows：优先 NSIS `-setup.exe`（`/S /D=$installDir`），回退 `.msi`（`/passive /norestart`）→ UTF-8 BOM PowerShell 后台静默覆盖并重启
    - Linux：AppImage 就地替换并重开，其余格式回退系统打开
  - 重启更新与退出应用前均触发未保存标签守卫，并先调用 `shutdown_runtime_sessions_async` 优雅断开 SSH/终端/LSP/传输任务
- 关于页：版本、平台、凭据存储位置及当前关键配置摘要说明

### 4.8 多窗口与会话生命周期

- `文件 → 新建窗口` 打开全新空白工作台（不继承主窗口工作区/标签/SSH 环境）；原生菜单命令仅投递至当前焦点窗口，各窗口侧栏/底栏尺寸独立
- 新窗口参数：`?open_folder=`、`?connect_ssh=`、`?connect_wsl=`
- 非最后窗口关闭不退出进程；最后一个窗口关闭先异步清理活跃会话再退出
- SSH 凭据隔离：密码（`glance://profile/`）与私钥口令（`glance://keypass/`）严格隔离存储，禁止跨认证模式串用
- SSH 会话掉线监控：每 2s 探测传输状态，设备关机/断网时仅向关联且当前活跃的唯一窗口弹窗「重新连接 / 断开连接」，任一窗口重连成功后自动关闭其他窗弹窗
- 僵尸会话通过 watchdog 安全回收（不在只读列举路径静默删表项）；按设备身份路由到最新活跃会话

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
npm run build        # tsc && vite build（启用 Monaco/xterm/markdown 手动分块）
npm run check        # tsc --noEmit && vite build（CI 前端标准检查）
npm run tauri dev    # 桌面开发模式（macOS 通过 dev-runner.sh 自动 ad-hoc 签名）
npm run tauri build  # 发布构建（macOS 后必须跑 bash scripts/fix-macos-bundle.sh）
```

### 7.2 CI 与自动发布

- **PR / Push CI（`.github/workflows/ci.yml`）**：
  - `frontend` 作业：`ubuntu-latest` 运行 `npm ci` + `npm run check`。
  - `rust` 作业：在 `ubuntu-latest`、`macos-latest`、`windows-latest` 三端矩阵运行 `cargo test --lib`、`cargo check --tests` 与 `cargo clippy --all-targets`。
- **自动发布（`.github/workflows/release.yml`）**：
  - 触发条件：推送 `v*` Tag 或手动 `workflow_dispatch`。
  - `prepare-release`：提取 `CHANGELOG.md` 对应版本说明并创建 `--draft` 草稿 Release。
  - `build-macos`：构建 universal `.app`（失败即报错，不回退单架构）→ 执行 `scripts/fix-macos-bundle.sh` → 打包 `.app.tar.gz` 与 `.dmg` 传至 workflow artifact。
  - `build-windows`：在 `windows-latest` 构建并收集 `*-setup.exe` 与 `*.msi` 传至 workflow artifact。
  - `publish-release`：汇总双端产物、统一生成 `SHA256SUMS.txt`、上传至 Release 并改为正式发布（`--draft=false`）。

### 7.3 自动化测试情况（2026-11-13 最新实测）

- `npm run check`（`tsc --noEmit` + `vite build`）：通过（0 错误；转换 1342 个模块，主入口 `index` 体积 `152.63 kB`）。
- `cargo test --lib`：**58 passed, 0 failed**（含流式搜索二进制/Unicode 测试、传输本地与并发测试、Git 解析、Updater `SHA256SUMS.txt` 解析与资产选择等）。
- `cargo check --tests`：全部集成测试编译通过（已修复 [windows_platform.rs](../src-tauri/tests/windows_platform.rs) `#[cfg(windows)]` 编译门控及 [real_device.rs](../src-tauri/tests/real_device.rs) 远端删除断言；集成测试存在 6 条历史 unused 告警）。
- `cargo test --test ssh_interop`（共 4 项，含 `interop_transfer_upload_and_download`）：编译通过，需配置 `ssh2` 运行 [server.js](../scripts/e2e-server/server.js) 与 `GLANCE_SSH_TEST_PORT` 方可执行实连；`macos_terminal`、`real_device`、`lsp_bridge` 需对应真实环境或设备。
- 注：本地 `stable-x86_64-apple-darwin` 未安装 `cargo-clippy`，由 `.github/workflows/ci.yml` 在三平台 CI 中运行 `cargo clippy --all-targets`。

---

## 8. 代码地图

```
src/
  App.tsx                                  应用壳：布局、快捷键、多窗口事件监听（已缩减至 ~670 行）
  hooks/useWorkspacePersistence.ts         启动恢复、工作区/标签防抖持久化、关闭前脏检查守卫
  components/
    common/                                TitleBar / ActivityBar / StatusBar / SettingsModal / AppOverlays / ToastHost / TooltipLayer / Modal / ErrorBoundary / icons
    explorer/                              ExplorerPanel（含拖拽上传与右键菜单）/ TreeNode / TransferQueuePanel
    editor/                                EditorArea（懒加载 Diff/Markdown） / TabBar（细滚轮滚动条） / MonacoHost / GitDiffView / Dialogs
    search/                                SearchPanel（按 Unicode 标量偏移高亮）
    git/                                   GitPanel / GitModals / gitPanelParts / CommitGraph
    remote/RemotePanel.tsx                 统一 SSH / WSL 面板
    ssh/                                   ConnectDialogs / ProfileDialog
    terminal/                              TerminalPanel / TerminalSubViews / terminalTypes
    discovery/DiscoveryPanel.tsx           局域网设备扫描与直连
    markdown/                              MarkdownWysiwyg / MarkdownOverlays
  lib/                                     ipc / format / models / monaco / platform / problems / domToMarkdown / windowState / lsp/remoteLsp
  stores/                                  explorer / transfer / tabs / git / settings / updater / tabDrag / toast / ui
  services/                                files / ssh / terminal / git / discovery / lsp / updater / workspace / wsl（统一经 invokeIpc）
  types/                                   ipc / ssh / wsl

src-tauri/src/
  lib.rs                                   AppState / 日志初始化 / macOS NSMenu / invoke_handler / shutdown_runtime_sessions_async
  logging.rs                               零外部依赖轮转文件日志（2 MiB × 2 备份 + 调试期 stderr）
  commands/                                app / discovery / fs / git/{mod,types,cli,parsers,inspect,actions} / lsp / ssh / terminal / transfer / updater/{mod,types,github,platform} / workspace / wsl
  app_services/                            connection_profiles / discovery / lsp / search / ssh_sessions / terminal / transfer/{mod,types,scanner,runner} / wsl
  filesystem/                              provider / local / sftp / remote_uri
  ssh/                                     client / device_pool / host_key_verifier
  storage/                                 database / secret_store
```

---

## 9. 下一步待验证与后续规划

### 当前最优先验证（v0.1.6 实机收口）

1. **真实 SSH 环境文件/文件夹并发传输联调**：搭建本地 `ssh2` 环境启动 [server.js](../scripts/e2e-server/server.js) 跑通 `ssh_interop`，并在局域网真实 Linux/树莓派设备验证多文件并发上传下载、途中取消与断网恢复。
2. **真实 Windows + WSL 环境联调**：验证 WSL `Stopped` 状态下直接访问/传输唤醒、大文件夹经 UNC 传输速度与进度精度、`light` 主题对比度及 NSIS `/S /D=...` 静默升级重启表现。
3. **发布态 `SHA256SUMS.txt` 与原地更新实测**：在 `v0.1.6` Release 流水线生成 `SHA256SUMS.txt` 后，用旧版打包产物 `.app` / `-setup.exe` 实测摘要校验与自动替换重启完整升级链路。

### 中长期路线图

1. 第二台真实 SSH 设备补齐设备池安全验收（克隆 Host Key、同 IP 抢占、身份轮换）。
2. Device Identity 级凭据 override（同一设备不同账号独立凭证）。
3. 更多远程语言服务器（rust-analyzer / gopls / typescript-language-server）与工程识别支持。
4. 远程文件内容缓存与容量管理。
5. 正式商业代码签名与公证（macOS Developer ID + Notarization / Windows Authenticode）。
