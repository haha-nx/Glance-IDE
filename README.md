# Glance IDE

本地 / 远程一体化开发工作台。以本机为控制中心，统一处理本地文件、WSL 子系统工作区、局域网 Linux 设备（树莓派等）、代码编辑、SSH 终端、SFTP 与工程构建。

> 完整项目交接与进度见 **[docs/Handoff.md](docs/Handoff.md)**（功能、架构、双端差异、测试与踩坑）。
> 工程与界面开发规范见 **[docs/开发规范.md](docs/开发规范.md)**（含前后端规范、安全红线与完整 UI 按钮规范）。

## 技术栈

Tauri 2 · React 19 + TypeScript · Vite · Tailwind CSS 4 · Monaco Editor（ESM + Worker 全离线）· xterm.js · Rust + Tokio · russh / russh-sftp · SQLite（rusqlite）· OS 凭据库（keyring）

## 环境准备

Node.js 22 LTS 与 Rust stable。本机若未加入 PATH：

```bash
export PATH="$HOME/tools/nodejs/bin:$HOME/.cargo/bin:$PATH"
```

- macOS 需要 Xcode Command Line Tools；Windows 需要 WebView2 Runtime 与 MSVC Build Tools。

## 常用命令

```bash
npm install              # 安装前端依赖
npm run dev              # 仅前端开发服务器（Vite :1420）
npm run tauri dev        # 桌面应用开发模式
npm run typecheck        # 仅 TypeScript 类型检查
npm run build            # 前端类型检查 + 构建（dist/，启用分块打包）
npm run check            # 前端 CI 标准检查（typecheck + vite build）
npm run tauri build      # 桌面应用打包
npm run tauri icon src-tauri/icons/app-icon.png   # 重新生成图标集
```

Rust 侧（在 `src-tauri/` 下）：

```bash
cargo check --tests      # 编译与集成测试检查
cargo test --lib         # 单元测试
cargo clippy --all-targets        # Rust Lint 检查
cargo test --test macos_terminal  # macOS 本机终端 PTY（仅 macOS）
```

macOS 打包后必须执行 `bash scripts/fix-macos-bundle.sh`（注入本地网络权限声明并重签）。

## 功能概览

- **编辑器**：Monaco 多标签（支持「仅保留修改文件」开关与 3px 细滚轮横向滚动条）、多分组分屏、标签拖拽拆分、Markdown 所见即所得、流式全局搜索、Problem Matcher、Git Diff；「报错显示」支持在设置中一键开关（默认关闭）
- **资源管理器**：本地 / `remote://` / `wsl://` 统一文件树；支持文件与文件夹多通道并发 SFTP 传输、队列进度与冲突预检，以及命令/焦点触发的目录递归同步
- **Git**：更改 + 提交图谱两栏；暂存/提交/同步/放弃、分支、工作树、提交 Diff
- **远程连接**：SSH 配置与设备身份（指纹登记/变更阻断/设备池、密码与私钥口令严格隔离）；WSL 发行版直连与自动唤醒（仅 Windows）
- **终端**：本机 / SSH / WSL（WSL 仅 Windows）；多窗格分屏、拖拽重排、最大化，仅剩最后一个终端关闭时同步收起底栏；Windows 走 PowerShell，macOS/Linux 走真实 PTY
- **局域网发现**：物理网卡网段探测 + SSH 端口扫描；已保存的 IP 直接连接，未保存的预填新建配置
- **设置与更新**：四套主题（含浅色语义对比度优化）、字号、面板尺寸独立持久化；GitHub Releases 版本检测、进度流下载、`SHA256SUMS.txt` 摘要/签名校验与原地/静默更新（自动检测默认关闭）
- **多窗口**：新窗口为空白工作台且布局与菜单操作互相隔离；SSH 掉线仅提醒关联活跃窗口，支持重连或断开
- **界面与工程规范**：统一非阻塞 Toast 提示、应用内 Modal（支持 `Escape` 与 ARIA 无障碍）、250ms 自定义 Tooltip；支持 PR / Push 三端 CI 自动化检查与草稿校验式双端发包

## 平台差异（摘要）

| 项 | Windows | macOS |
|---|---|---|
| 标题栏 | 无边框 + HTML 自绘单行暗色栏（Logo/菜单/终端按钮/窗口三键） | 原生 Overlay 标题栏 + 红绿灯；窗口内仅标题 |
| 菜单 | 窗口内菜单栏 | 系统顶部原生菜单（App/文件/编辑/查看/终端/窗口/帮助） |
| 本机终端 | `powershell.exe`（管道 + CREATE_NO_WINDOW） | `$SHELL` + 真实 PTY（openpty） |
| 凭据 | Credential Manager | Keychain |
| 打包 | MSI + NSIS | `.app`（+ 本地网络声明与重签） |
| WSL | 提供完整入口与终端 | 不显示 WSL 选项 |

## 安全基线

1. 未知或变化的 SSH Host Key 永不自动放行。
2. SQLite 与轮转日志不存明文凭据；秘密仅存 OS 凭据库且按认证方式严格隔离。
3. 远程缓存、LSP、工程环境按 `device_identity_id` 隔离，不以 IP 为键。
4. 应用内更新包严格校验 SHA-256 摘要（含 `SHA256SUMS.txt` 回退），macOS 原地升级仅精准清除 `com.apple.quarantine` 并校验证书签名与 Bundle ID。
5. 离线可用：不依赖 CDN、云服务、账号登录。
