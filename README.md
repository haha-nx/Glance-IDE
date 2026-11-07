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

## 当前进度（M0–M5 主体完成，M6 部分，M7 打包完成）

- [x] Tauri 2 + React 19 + TS + Tailwind 4 工程骨架；单色 2D 线性图标集
- [x] Monaco ESM + Worker 全离线集成；多标签 / Markdown 预览 / Diff / 全局搜索（含 grep 式后端 + 防抖 UI）
- [x] 本地 FileSystemProvider（原子写 + 保存冲突检测 + 路径穿越防护）；ui_state 持久化（工作区/标签恢复）
- [x] **M2 SSH 设备池**：指纹计算（与 ssh-keygen 一致）、A/B/A 轮换、未知/变化阻断、Profile/Identity CRUD、Keychain 凭据、远程设备面板
- [x] **M3 SFTP 远程工作区**：统一 Provider + `remote://{device-uuid}/path` URI 调度、会话内 SFTP Channel 懒初始化、冲突检测
- [x] **M4 终端与构建**：PTY（xterm.js，resize/window-change）、exec 任务执行器（stdout/stderr 分离 + ExitStatus）、Problem Matcher（gcc/clang/python）、错误点击跳转、task_history
- [x] **M5 局域网发现**：mDNS（mdns-sd）+ CIDR TCP 扫描（并发/超时/取消）+ SSH banner 识别 + 候选预填新建连接
- [x] **M6 基础**：远程语言服务器检测（clangd/pyright，只读不安装）、ROS2/CMake/Python 工程识别、compile_commands.json 指纹
- [x] **M7 打包**：`npm run tauri build` → Glance IDE.app + dmg（49MB）；断网资源检查通过（无 CDN/外链请求）
- [ ] M6 剩余：monaco-languageclient ↔ SSH stdio 桥接（路线图 §6.4 要求先 Spike 冻结方案）

## 验证矩阵

| 层次 | 结果 |
|---|---|
| Rust 单元测试 | 32/32（指纹/设备池/文件系统/迁移/搜索/发现/CIDR） |
| SSH 互操作集成测试 | 3/3（身份轮换与认证 / SFTP 全流程 / exec+PTY） |
| 前端构建 | TS 严格模式 + Vite 8 全绿 |
| 端到端 UI 验收 | 新建配置→连接→指纹登记→会话建立（真实 UI 操作）✅ |
| 打包 | .app + .dmg 产出 ✅ |

## 本地 SSH 互操作测试

```bash
# 启动测试服务器（Node ssh2，127.0.0.1:2222，账号 pi/raspberry，sftp 直通 /usr/libexec/sftp-server）
node /tmp/glance-e2e/server/server.js /tmp/glance-e2e/keys/hostkey 2222

cd src-tauri
GLANCE_SSH_TEST_PORT=2222 \
GLANCE_SSH_TEST_HOSTKEY_PUB=/tmp/glance-e2e/keys/hostkey.pub \
cargo test --test ssh_interop
```

## 路线图状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 技术验证与骨架 | ✅ |
| M1 | 本地编辑器闭环 | ✅（Markdown/Diff/搜索/持久化） |
| M2 | SSH 身份与设备池 | ✅ 核心；§12.2 真机 8 项待跑 |
| M3 | SFTP 远程工作区 | ✅ 核心 |
| M4 | 终端与构建任务 | ✅ 核心 |
| M5 | 局域网发现 | ✅ |
| M6 | 远程语言智能 | 🔨 检测/识别完成；LSP 桥接待 Spike |
| M7 | 打包与发布 | ✅（签名/公证待证书） |

## 安全基线（不可妥协）

1. 未知或变化的 SSH Host Key 永不自动放行（ADR-007）。
2. SQLite 与日志不存明文凭据；秘密仅存 OS 凭据库（§9.2）。
3. 缓存、LSP、工程环境按 `device_identity_id` 隔离，不以 IP 为键（§9.3）。
4. 离线红线：不依赖 CDN、云服务、账号登录（§1.4/§10.2）。
