# Glance IDE — 项目文档（当前版本）

> 版本：v0.1.1 · 适用平台：Windows / macOS
> 本文档只描述当前版本的实际实现，不保留历史变更记录。历史细节可查 git log。

---

## 1. 项目概览

Glance IDE 是本地/远程一体化的桌面开发工作台。以本机为控制中心，统一处理：

- 本地文件与工程编辑
- WSL 子系统工作区
- 局域网 Linux 设备（树莓派等）的 SSH / SFTP 工作区
- 代码与 Markdown 编辑、Monaco Diff、全局搜索
- 本机 / WSL / SSH 终端，多窗格分屏
- Git 更改管理、提交图谱与工作树
- 局域网设备发现、远程构建任务、远程语言智能（LSP）

**核心数据模型（不可破坏）**：网络端点 / 连接配置 / 设备身份 / 远程工程环境 四层分离。

- 远程 SSH 资源以 `remote://{device-identity-uuid}/path` 编址
- WSL 资源以 `wsl://{distro_name}/path` 编址，Windows 侧映射到 `\\wsl.localhost\{distro}\{path}`
- 未知或变化的 SSH Host Key 永不自动放行
- 凭据只进 OS 钥匙串（macOS Keychain / Windows Credential Manager）

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 桌面容器 | Tauri 2（Windows WebView2 / macOS WKWebView） |
| 前端 | React 19 + TypeScript（strict）+ Vite 8 + Tailwind CSS 4 + zustand |
| 编辑器 | Monaco Editor（ESM + Worker 全离线打包） |
| 终端 | xterm.js + FitAddon |
| 后端 | Rust + Tokio |
| SSH/SFTP | russh / russh-sftp |
| 本机 PTY | libc `openpty`（仅 Unix） |
| 存储 | SQLite（rusqlite，PRAGMA user_version 迁移） |
| 凭据 | keyring 4（Keychain / Credential Manager） |
| 发现 | mdns-sd + 自建 CIDR TCP 扫描 |

离线红线：不依赖 CDN、在线字体、账号服务或远程中继；Monaco Worker 随安装包分发。

## 3. 当前功能

### 3.1 编辑器与工作区

- Monaco 多标签编辑，按「列 × 行」网格的多分组分屏，分隔条可拖拽调权
- 标签拖拽：跨分组移动、拖到编辑区四边拆分新分组
- 保存冲突检测（mtime）、原子写、路径穿越防护
- Markdown 所见即所得（Typora 风格）：原地编辑、表格行列调整、大纲、右键菜单、`document.execCommand` 原生撤销
- 全局搜索：中文高亮偏移按 Unicode 标量计算
- 问题面板：Problem Matcher（gcc/clang/python）→ 点击跳转源码位置
- 工作区/标签/ui_state 持久化；启动自动恢复

### 3.2 资源管理器

- 本地 / `remote://` / `wsl://` 三类根目录统一懒加载
- 新建文件/文件夹、重命名、删除、刷新、右键菜单
- 远程目录缓存按设备身份隔离，会话重连后失效重载

### 3.3 Git

- 侧边栏上下两栏：「更改」+「图形」，比例可拖拽
- 更改区：分支切换/新建、同步（Fetch/Pull/Push、超前落后计数）、提交/提交并推送/自动暂存、已暂存与工作区更改、暂存/取消暂存/放弃（单文件与全部）、工作树（Worktrees）管理
- 图形区：多分支拓扑 SVG 提交图谱、分支/远程/标签徽标、未提交虚拟节点、按提交查看变更文件
- Monaco Diff：工作区 vs 暂存区、暂存区 vs HEAD、提交 vs 父提交；支持并排/行内切换
- 支持本地、WSL、远程 SSH 仓库

### 3.4 远程连接（SSH / WSL）

- 统一的远程连接面板：Windows 下左上角切换 SSH / WSL；**macOS 只显示 SSH**（不渲染 WSL 标签与视图）
- 活动栏入口在 macOS 上显示为「远程连接」，Windows 为「远程连接与 WSL」
- SSH：连接配置 CRUD；设备身份（Host Key 指纹）首次登记、变更阻断；一个配置可绑定多台设备身份（设备池）；连接替换语义（新握手成功才清旧会话）
- WSL：发行版探测（UTF-16LE 解码）、家目录直达；仅 Windows
- 连接动作：当前窗口直连（打开远程工作区）或新窗口连接
- 启动自动重连同配置；失败弹窗支持「打开远程配置 / 切换到本地 / 重试连接」

### 3.5 终端

- 底部面板：终端 / 任务 / 问题 三个页签
- 终端类型：本机、SSH 远程、WSL（WSL 仅 Windows）；按当前工作区上下文自动选择
- 每个窗格独立标签栏，支持连续分屏、拖拽跨窗格重排、标签拖到窗格边缘拆分
- 终端最大化/还原；底栏高度与侧边栏宽度可拖拽并持久化
- Windows：`powershell.exe`，管道 + `CREATE_NO_WINDOW`，`\r` 自动补 `\n`
- macOS/Linux：`$SHELL` 经真实 PTY（`openpty` + `setsid` + `TIOCSCTTY`），`TIOCSWINSZ` 同步窗口尺寸

### 3.6 局域网发现

- 网段前三段 + `1→254` + 端口输入，自动填入本机物理网卡 IP
- 过滤代理 / VPN / 虚拟机网卡与保留网段；默认路由优先
- CIDR 并发 TCP 扫描 + SSH banner 分级；后端保留 mDNS 能力（当前面板以网段扫描为主）
- 结果只显示确认可连 SSH 的设备
- 点击连接：**命中已保存配置（host + port 一致）→ 直接在当前窗口发起连接**；未保存过 → 跳到远程面板并预填 IP/端口打开新建配置
- 首次扫描兜底：等待本机网段探测落定、使用真实网段；若首次零结果自动重试一次（兼容 macOS 首次局域网权限静默拦截与 ARP 冷启动）

### 3.7 设置与更新

- 四套主题（dark / midnight / nord / light），全界面与 Monaco/终端同步
- 字号 10–24px
- 侧边栏宽度、底栏高度持久化
- GitHub Releases 版本检测与安装包下载；「自动检测」「自动下载」默认关闭
- 关于页：版本、平台、凭据存储位置说明

### 3.8 多窗口与会话生命周期

- `文件 → 新建窗口` 打开全新空白工作台（不继承主窗口工作区/标签/SSH 环境）
- 新窗口参数：`?open_folder=`、`?connect_ssh=`、`?connect_wsl=`
- 非最后窗口关闭不退出进程；最后一个窗口关闭才退出
- SSH 会话掉线监控：每 2s 探测传输状态，设备关机/断网时弹窗「重新连接 / 断开连接」
- 僵尸会话自动清理；按设备身份路由到最新活跃会话

### 3.9 远程语言智能

- 语言服务器检测（clangd / pylsp，只读不安装）
- ROS 2 / CMake / Python 工程识别与 `compile_commands.json` 指纹
- 远程 LSP 桥：SSH exec（无 PTY）通道 + Rust JSON-RPC 组帧 + Monaco 桥（补全/悬停/定义/诊断），按设备身份隔离

## 4. 架构

### 4.1 分层

```
前端 React
  components/   UI（TitleBar / EditorArea / TerminalPanel / GitPanel / RemotePanel / DiscoveryPanel / SettingsModal）
  stores/       zustand 状态（tabs / explorer / git / settings / updater / tabDrag）
  services/     对 Tauri Command 的封装
  lib/          Monaco 模型表、Problem Matcher、DOM→Markdown、窗口状态

Rust（src-tauri/src）
  commands/     薄命令层（参数校验 → 领域层调用）
  app_services/ 领域服务（ssh_sessions / connection_profiles / terminal / lsp / discovery / search / wsl）
  filesystem/   FileSystemProvider trait + local / sftp / remote_uri（含 WSL UNC）
  ssh/          russh 编排、Host Key 校验、设备池
  storage/      SQLite 迁移、OS 凭据库
```

### 4.2 IPC 与通道

| 场景 | 机制 |
|---|---|
| 文件/目录/配置读写 | Tauri Command（短请求-响应） |
| 终端输出、扫描结果、LSP | `tauri::ipc::Channel` 流式推送 |
| 会话状态、菜单动作 | Tauri Event（`glance:*` 为前端 DOM 事件） |

**通道分离**：PTY（交互终端）、exec（构建任务）、LSP 各自独立，互不复用。

### 4.3 数据流要点

- 文件操作统一走 `FileSystemProvider`，由 URI 前缀决定 provider
- 远程会话权威状态在 Rust；前端只持有会话列表视图
- 远程文件缓存、LSP 进程、工程环境以 `device_identity_id` 为键，不以 IP 为键
- 长任务均有 `channel_id` / `session_id`，支持取消与关闭回收

### 4.4 数据库

SQLite（`app_data_dir/glance.db`），当前 schema v2，迁移前自动备份为 `.db.bak-v<旧版本>-<时间戳>`。

主要表：`connection_profiles`、`device_identities`、`profile_identity_bindings`、`remote_environments`、`ui_state` 等。
新增迁移：在 `storage/database.rs` 追加常量 → 加入 `MIGRATIONS` → 补一条迁移测试。

## 5. 双端差异与注意事项

### 5.1 窗口与标题栏

| | Windows | macOS |
|---|---|---|
| 窗口装饰 | `decorations: false`（全局配置） | `tauri.macos.conf.json` 覆盖为 `decorations: true` |
| 标题栏 | HTML 自绘 30px 单行暗色栏 | `titleBarStyle: "Overlay"` + `hiddenTitle: true` + 原生红绿灯叠加 |
| 标题栏内容 | Logo + 文件/编辑/查看/终端菜单 + 终端直达按钮 + 最小化/最大化/关闭 | 仅标题文字（Logo、菜单组、终端按钮、窗口三键全部隐藏） |
| 红绿灯留白 | — | 标题栏左侧 `pl-[76px]` |
| 主题 | 跟随应用主题 | 应用主题变化时调用 `setTheme` 同步原生标题栏（需 `core:window:allow-set-theme`） |

**平台配置合并**：`tauri.conf.json` 是全局的，`tauri.macos.conf.json` 按 JSON 合并覆盖。
`app.windows` 是数组，平台文件里重写时必须给出完整窗口对象（label / 尺寸 / 最小尺寸）。

### 5.2 菜单

| | Windows | macOS |
|---|---|---|
| 菜单位置 | 窗口内 HTML 菜单栏 | 系统顶部菜单栏（原生 NSMenu） |
| 结构 | 文件(F) / 编辑(E) / 查看(V) / 终端 | App 菜单 / 文件 / 编辑 / 查看 / 终端 / 窗口 / 帮助 |
| 终端入口 | 「终端」直达按钮 | 「终端」菜单，仅一项「新建终端」（⌘⇧\`）；「切换底部终端」在「查看」 |
| 快捷键文案 | Ctrl / Alt | ⌘ / ⇧ / ⌥（快捷键仍用 `CmdOrCtrl` 统一注册） |
| 退出 | 文件 → 退出（Alt+F4） | App 菜单 → 退出 Glance IDE（⌘Q，走未保存确认） |

**AppKit 两条硬约束**：
1. 主菜单的**第一个子菜单恒为应用菜单**，标题会被替换为进程名，必须单独构造；
2. **顶层菜单项没有子菜单时不会被渲染**，因此无法在系统菜单栏做「点击即执行」的按钮，终端菜单必须保留下拉。

### 5.3 终端

| | Windows | macOS / Linux |
|---|---|---|
| Shell | `powershell.exe -NoLogo` | `$SHELL`（默认 `/bin/zsh`） |
| 实现 | 管道 + `CREATE_NO_WINDOW`（无黑框） | `openpty` 真实 PTY + `setsid` / `TIOCSCTTY` |
| 回车 | `\r` → `\r\n` | PTY 行规程处理 |
| Resize | 无 PTY，忽略 | `TIOCSWINSZ` 生效 |
| 环境 | — | `TERM=xterm-256color` |

**为什么必须用 PTY**：管道模式下 bash 退回非交互，没有提示符、不回显输入。`\r` 也不会被行规程转换成换行，命令根本不会执行。

### 5.4 凭据

- macOS：Keychain（`keyring` 4.x，默认 feature 已含）
- Windows：Credential Manager
- SQLite 只存 `credential_ref`（形如 `glance://profile/<id>`），不存明文

### 5.5 WSL

- 仅 Windows 提供完整入口：活动栏「远程连接与 WSL」、面板内 WSL 标签页、WSL 终端
- **macOS 完全不显示 WSL 选项**：活动栏文案为「远程连接」、面板固定 SSH 视图、不调用 WSL 探测、不创建 WSL 终端；后端调用返回「WSL 终端仅在 Windows 环境下可用」
- 发行版列表来自 `wsl.exe -l -v`，输出是 UTF-16LE，需按 `u16` 解码
- WSL 路径映射为 UNC，文件操作走本地 provider（极速），不走 SFTP

### 5.6 macOS 本地网络权限（重要）

macOS 26 按**代码签名归属**判定局域网访问权。未签名/未声明的二进制连局域网设备会被**静默拒绝**（`EHOSTUNREACH / No route to host`），本机回环不受影响。

三件套缺一不可：

1. 应用 `Info.plist` 含 `NSLocalNetworkUsageDescription`（打包后由 `scripts/fix-macos-bundle.sh` 注入）
2. 二进制有签名：dev 由 `scripts/dev-runner.sh`（cargo runner）自动 ad-hoc 签名；release 由 `fix-macos-bundle.sh` 重签
3. 用户在 系统设置 → 隐私与安全性 → 本地网络 中允许应用

授权状态重置：`tccutil reset LocalNetwork com.glance.ide`

### 5.7 打包

| | 产物 | 备注 |
|---|---|---|
| Windows | MSI + NSIS | 需 WebView2 Runtime 与 MSVC Build Tools |
| macOS | `.app` | `npm run tauri build` 后**必须**执行 `bash scripts/fix-macos-bundle.sh` |

- dmg 生成受本机 Finder AppleEvent 超时影响（-1712），与代码无关；`.app` 可靠产出
- Release 下窗口关闭受 Tauri capability 限制，需显式授权并配合 `exit_app` 兜底

### 5.8 其他跨平台点

- 路径统一正斜杠规范化；`list_dir` 必须保留 `remote://` / `wsl://` 前缀
- 快捷键展示文案按平台切换，但注册统一用 `CmdOrCtrl`
- 多窗口共享 `localStorage`：空白窗口（`?blank=1`）不读取历史工作区、不按历史设备建终端、也不反向写入工作区状态
- SSH 会话是进程级的，空白窗口的「新建终端」固定为本机终端

## 6. 环境与工具链

```bash
# 本机工具链不在默认 PATH
export PATH="$HOME/tools/nodejs/bin:$HOME/.cargo/bin:$PATH"
```

- Node.js 22 LTS，Rust stable
- macOS 需要 Xcode Command Line Tools；Windows 需要 WebView2 Runtime 与 MSVC Build Tools

```bash
npm install
npm run dev            # 仅前端（Vite :1420）
npm run tauri dev      # 桌面开发模式
npm run build          # tsc + vite build
npm run typecheck      # 仅类型检查
npm run tauri build    # 打包
```

## 7. 测试

```bash
cd src-tauri
cargo test --lib                    # 单元测试（47 项）
cargo test --test macos_terminal    # macOS 本机终端 PTY（提示符/回显/执行/cwd）
cargo test --test windows_platform  # Windows 平台专项（凭据/网卡/WSL）
cargo test --test ssh_interop       # loopback 互操作（需先起测试服务器）
cargo test --test real_device       # 真机互操作（REAL_SSH_* 环境变量）
cargo test --test lsp_bridge        # 远程 LSP 桥（真机 + clangd）
```

loopback 测试服务器：

```bash
node scripts/e2e-server/server.js /tmp/glance-e2e/keys/hostkey 2222 &
GLANCE_SSH_TEST_PORT=2222 GLANCE_SSH_TEST_HOSTKEY_PUB=/tmp/glance-e2e/keys/hostkey.pub \
  cargo test --test ssh_interop
```

真机测试环境变量：`REAL_SSH_HOST` / `REAL_SSH_PORT` / `REAL_SSH_USER` / `REAL_SSH_PASS` / `REAL_SSH_HOSTKEY_PUB`。
Host Key 获取：`ssh-keyscan -t ed25519 <ip>`（测试已做输出归一化）。

## 8. 关键坑速查

| 坑 | 结论 |
|---|---|
| Tauri capability 窗口关闭 | Release 下 `window.destroy()/close()` 需在 `capabilities/default.json` 显式授权，否则被静默拦截；配合 Rust `exit_app` 兜底 |
| Windows 无边框 | `decorations: false` 后需 HTML 层 `data-tauri-drag-region` + 自研标题栏；该配置**不能直接用于 macOS** |
| macOS 无边框 | `decorations: false` 会让 tao 走 `NSWindowStyleMask::Borderless`，红绿灯/圆角/阴影全消失；应使用 Overlay 标题栏 |
| AppKit 应用菜单 | 主菜单第一个子菜单恒为应用菜单，标题被进程名替换，需单独构造 |
| AppKit 顶层菜单项 | 无子菜单的顶层项不会被渲染，不能做「点击即执行」按钮 |
| `theme` 配置值 | CLI schema 只接受 `"Dark"` / `"Light"`（大写）；运行时再做 `to_lowercase` |
| 平台配置合并 | `app.windows` 数组在平台文件中需完整重写（不是按索引合并） |
| 双击标题栏 | `data-tauri-drag-region` 已由 Tauri 内置 `drag.js` 处理双击最大化，**不要再绑 `onDoubleClick`**，否则会切换两次（放大后立刻缩回） |
| localStorage 多窗口共享 | 空白窗口必须忽略历史 `glance.recentRoot` / `lastSshProfileId`，否则继承主窗口的 SSH 工作区 |
| SSH 会话进程级共享 | 「有活跃会话就建 SSH 终端」的分支对空白窗口必须跳过 |
| 事件时序 | 切面板后再派发预填事件会丢失（组件未挂载），应暂存数据由目标组件挂载时消费 |
| 开发期 StrictMode 卸载清理 | 组件卸载清理里无条件调用 `discovery_cancel`，会在 StrictMode「挂载→清理→再挂载」时取消用户首次扫描；清理前需判断本实例是否真的发起过扫描 |
| monaco-editor 0.5x 导出 | exports map `./*` → `./esm/vs/*`，深路径不带 `vs` 前缀 |
| `serde` 枚举 | `#[serde(tag, rename_all)]` 只改变体名，变体字段需 `rename_all_fields = "camelCase"` |
| base64 指纹 | 43 字符无填充，解码需 `DecodePaddingMode::Indifferent` |
| russh 0.65 | `channel.split()` + `wait()` 处理 `ChannelMsg`；**不要**持 std MutexGuard 跨 await |
| russh-sftp 3.0 | `session.write()` 不带 CREATE；写文件必须 `sftp.create()` |
| keyring 4.x | 默认 feature 已含 Keychain / Credential Manager，不要加 `apple-native` |
| 全局搜索偏移 | Rust `pos` 是字节偏移，中文需转 `chars().count()` |
| WSL 输出编码 | `wsl.exe -l -v` 是 UTF-16LE，需按 `u16` 解码 |
| 长输出 IPC | 用 `tauri::ipc::Channel`；领域层抽象为 `EventSink` 便于测试传闭包 |

## 9. 代码地图

```
src/
  App.tsx                              应用壳：面板布局/快捷键/会话事件/恢复与持久化
  components/common/TitleBar.tsx       跨平台标题栏（Windows 自绘完整栏；macOS 仅标题）
  components/editor/                   多分组编辑器、标签栏、Monaco、Git Diff
  components/explorer/                 文件树
  components/search/                   全局搜索
  components/git/                      更改面板 + 提交图谱
  components/remote/RemotePanel.tsx    统一 SSH / WSL 面板
  components/terminal/TerminalPanel.tsx 终端多窗格 + 任务 + 问题
  components/discovery/DiscoveryPanel.tsx 局域网发现
  components/common/SettingsModal.tsx  设置中心
  lib/windowState.ts                   空白窗口判定 + 待消费的预填/直连数据
  lib/platform.ts                      平台判定（IS_MAC，供窗口/菜单/WSL 分支复用）
  components/common/TooltipLayer.tsx   全局说明气泡（title → data-tooltip，250ms 显示）
  lib/models.ts / problems.ts          Monaco 模型表 / Problem Matcher
  stores/                              zustand 状态
  services/                            Command/Channel 封装
src-tauri/
  lib.rs                               AppState / macOS 菜单 / 命令注册 / 退出清理
  tauri.macos.conf.json                macOS 窗口覆盖（Overlay 标题栏 + 深色外观）
  commands/                            app / fs / ssh / terminal / git / discovery / lsp / workspace / updater / wsl
  app_services/                        ssh_sessions / connection_profiles / terminal / lsp / discovery / search / wsl
  filesystem/                          provider trait / local / sftp / remote_uri
  ssh/                                 client / host_key_verifier / device_pool
  storage/                             database（迁移）/ secret_store（keyring）
  tests/                               单元外的集成测试
scripts/
  dev-runner.sh                        cargo runner：编译产物自动 ad-hoc 签名
  fix-macos-bundle.sh                  打包后注入本地网络声明并重签（必跑）
  e2e-server/                          本地 SSH 测试服务器
  gen_icon.py                          图标源图生成
```

## 9.1 界面按钮规范

图标按钮统一要求：**必须有 `title` 说明气泡 + `hover:bg-*` 背景反馈 + `rounded` + `transition-colors`**。
纯文字、复合按钮、窗口控制、菜单项各有独立规则，详见 [UI按钮规范.md](UI按钮规范.md)。

说明气泡不使用原生 `title`（系统延迟 1–2 秒且不可配置），由全局 `TooltipLayer` 接管：
挂载后把 `title` 迁移为 `data-tooltip` 并补 `aria-label`，悬停 250ms 显示自定义气泡。
定位规则：活动栏主按钮放右侧（`data-tooltip-side="right"`），面板内子按钮默认放下方，空间不足自动翻转。

## 10. 安全红线

1. 未知或变化的 SSH Host Key 永不自动放行。
2. SQLite / 日志 / 崩溃报告 / 终端历史不得出现明文密码或私钥口令；秘密只经 OS 凭据库。
3. 远程缓存、LSP、工程环境、构建历史以 `device_identity_id` 为键，不以 IP 为键。
4. 局域网扫描不输入密码、不尝试默认账号、不建立信任；发现 ≠ 信任。
5. PTY、exec、LSP 三类通道严格分离。
6. 离线可用：不引入 CDN、在线字体、账号服务。

## 11. 已知限制与后续方向

**已知限制**

- dmg 打包受本机 Finder AppleEvent 超时影响；`.app` 正常
- 设备池专项验收中的「克隆 Host Key」「同 IP 抢占」需要第二台真实设备
- 远程 LSP 依赖目标设备已安装 clangd/pylsp（产品红线是不静默安装）
- GUI 自动化测试受 macOS 辅助功能授权与前台应用抢占影响，终端输入链路以集成测试覆盖
- 未编译进 UI 的遗留组件：`components/ssh/SshPanel.tsx`、`components/wsl/WslPanel.tsx`、`components/markdown/MarkdownPreview.tsx`（由 `RemotePanel` / 当前 Markdown 编辑器取代）

**后续方向**

1. 第二台设备补齐设备池安全验收（克隆 Host Key、同 IP 抢占、身份轮换）
2. Device Identity 级凭据 override（同一设备不同账号）
3. 更多语言服务器与工程类型支持
4. 远程文件内容缓存与容量管理
5. 代码签名 / 公证（macOS）与 Windows 安装包签名
