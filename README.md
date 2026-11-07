# Glance IDE

本地 / 远程一体化开发工作台。以本机为控制中心，统一处理本地文件、局域网 Linux 设备（树莓派等）、代码编辑、SSH 终端、SFTP 与工程构建。

> 接手开发请先读 **[docs/Handoff.md](docs/Handoff.md)**（工作交接：状态/坑/测试/下一步）。
> 技术架构见 [docs/Glance-IDE_技术架构与实施路线图_v3.0.md](docs/Glance-IDE_技术架构与实施路线图_v3.0.md)；
> 里程碑与任务分解见 [docs/开发计划_v1.0.md](docs/开发计划_v1.0.md)。

## 技术栈

Tauri 2 · React 19 + TypeScript · Vite · Tailwind CSS 4 · Monaco Editor（ESM + Worker 全离线）· Rust + Tokio · russh / russh-sftp · SQLite（rusqlite）· OS 凭据库（keyring）

## 环境准备

- Node.js 22 LTS 与 Rust stable（rustup）。本机若未加入 PATH：

```bash
export PATH="$HOME/tools/nodejs/bin:$HOME/.cargo/bin:$PATH"
```

- macOS 需要 Xcode Command Line Tools；Windows 需要 WebView2 Runtime 与 MSVC Build Tools。

## 常用命令

```bash
npm install              # 安装前端依赖
npm run dev              # 仅前端开发服务器（Vite :1420）
npm run tauri dev        # 桌面应用开发模式
npm run build            # 前端类型检查 + 构建（dist/）
npm run tauri build      # 桌面应用打包
npm run tauri icon src-tauri/icons/app-icon.png   # 重新生成图标集
```

Rust 侧（在 `src-tauri/` 下）：

```bash
cargo check              # 编译检查
cargo test               # 单元测试（指纹、设备池、文件系统、数据库迁移）
```

## 当前进度（M0–M7 全部完成，Windows + macOS 双平台）

- [x] Tauri 2 + React 19 + TS + Tailwind 4 工程骨架；单色 2D 线性图标集
- [x] Monaco ESM + Worker 全离线集成；多标签 / Markdown 预览 / Diff / 全局搜索（含 grep 式后端 + 防抖 UI）
- [x] 本地 FileSystemProvider（原子写 + 保存冲突检测 + 路径穿越防护）；ui_state 持久化（工作区/标签恢复）
- [x] **M2 SSH 设备池**：指纹计算（与 ssh-keygen 一致）、A/B/A 轮换、未知/变化阻断、Profile/Identity CRUD、凭据库（macOS Keychain / Windows Credential Manager）、远程设备面板
- [x] **M3 SFTP 远程工作区**：统一 Provider + `remote://{device-uuid}/path` URI 调度、会话内 SFTP Channel 懒初始化、冲突检测（标准 realpath 解析主目录）
- [x] **M4 终端与构建**：PTY（xterm.js，resize/window-change）、exec 任务执行器（stdout/stderr 分离 + ExitStatus）、Problem Matcher（gcc/clang/python）、错误点击跳转、task_history
- [x] **M5 局域网发现**：mDNS（mdns-sd）+ CIDR TCP 扫描（并发/超时/取消）+ SSH banner 识别 + 候选预填新建连接
- [x] **M6 远程语言智能**：语言服务器检测（clangd/pylsp，只读不安装）、ROS2/CMake/Python 工程识别、compile_commands.json 指纹、**LSP 桥接**（SSH exec 无 PTY + Rust JSON-RPC 组帧 + 自建 Monaco 桥：补全/悬停/定义跳转/诊断，按设备身份隔离）
- [x] **M7 打包**：Windows MSI + NSIS 安装包；macOS .app（dmg 受本机 Finder 环境问题阻塞）；断网资源检查通过（无 CDN/外链请求）

## 验证矩阵

| 层次 | 结果 |
|---|---|
| Rust 单元测试 | 37/37（指纹/设备池/文件系统/迁移/搜索/发现/CIDR/LSP 组帧） |
| SSH 互操作集成测试 | 3/3（身份轮换与认证 / SFTP 全流程 / exec+PTY） |
| 真机互操作（Windows→Ubuntu 20.04） | 5/5（身份认证 / exec / SFTP / PTY / LSP 检测） |
| LSP 桥真机测试 | 2/2（clangd 握手+hover / 双通道隔离） |
| Windows 平台专项 | 3/3（Credential Manager 往返 / 中文+emoji 凭据 / 网卡枚举） |
| 前端构建 | TS 严格模式 + Vite 8 全绿 |
| 端到端 UI 验收 | 新建配置→连接→指纹登记→会话建立（真实 UI 操作）✅ |
| 打包 | Windows MSI + NSIS ✅ · macOS .app ✅ |

## 本地 SSH 互操作测试

```bash
# 启动测试服务器（Node ssh2，127.0.0.1:2222，账号 pi/raspberry；
# macOS sftp 直通 /usr/libexec/sftp-server；Windows 经 WSL 直通真实 sftp-server）
GLANCE_E2E_SFTP_SERVER=linux:/usr/lib/openssh/sftp-server \
  node scripts/e2e-server/server.js /tmp/glance-e2e/keys/hostkey 2222

cd src-tauri
GLANCE_SSH_TEST_PORT=2222 \
GLANCE_SSH_TEST_HOSTKEY_PUB=/tmp/glance-e2e/keys/hostkey.pub \
cargo test --test ssh_interop
```

## 真机与 LSP 桥测试

```bash
cd src-tauri
REAL_SSH_HOST=<ip> REAL_SSH_PORT=22 REAL_SSH_USER=<user> REAL_SSH_PASS=<pass> \
  REAL_SSH_HOSTKEY_PUB=/tmp/real/hostkey.pub \
  cargo test --test real_device --test lsp_bridge
# hostkey.pub 获取：ssh-keyscan -t ed25519 <ip>（测试已做输出归一化）
# lsp_bridge 需设备预装 clangd；不静默安装是产品红线，测试环境请手动部署
```

## 路线图状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 技术验证与骨架 | ✅（双平台编译） |
| M1 | 本地编辑器闭环 | ✅（Markdown/Diff/搜索/持久化） |
| M2 | SSH 身份与设备池 | ✅；§12.2 剩克隆 Host Key/同 IP 抢占需第二台设备 |
| M3 | SFTP 远程工作区 | ✅ |
| M4 | 终端与构建任务 | ✅ |
| M5 | 局域网发现 | ✅ |
| M6 | 远程语言智能 | ✅（检测/识别/LSP 桥接完成；真机 clangd 验证） |
| M7 | 打包与发布 | ✅（Windows MSI/NSIS；macOS .app；签名/公证待证书） |

## 安全基线（不可妥协）

1. 未知或变化的 SSH Host Key 永不自动放行（ADR-007）。
2. SQLite 与日志不存明文凭据；秘密仅存 OS 凭据库（§9.2）。
3. 缓存、LSP、工程环境按 `device_identity_id` 隔离，不以 IP 为键（§9.3）。
4. 离线红线：不依赖 CDN、云服务、账号登录（§1.4/§10.2）。
