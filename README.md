# Glance IDE

本地 / 远程一体化开发工作台。以本机为控制中心，统一处理本地文件、WSL 子系统工作区、局域网 Linux 设备（树莓派等）、代码编辑、SSH 终端、SFTP 与工程构建。

> 接手开发请先读 **[docs/Handoff.md](docs/Handoff.md)**（工作交接：状态/坑/测试/下一步）。
> 技术架构见 [docs/Glance-IDE\_技术架构与实施路线图\_v3.0.md](docs/Glance-IDE_技术架构与实施路线图_v3.0.md)；
> 里程碑与任务分解见 [docs/开发计划\_v1.0.md](docs/开发计划_v1.0.md)。

## 技术栈

Tauri 2 · React 19 + TypeScript · Vite · Tailwind CSS 4 · Monaco Editor（ESM + Worker 全离线）· Rust + Tokio · russh / russh-sftp · SQLite（rusqlite）· OS 凭据库（keyring）

## 环境准备

Node.js 22 LTS 与 Rust stable（rustup）。本机若未加入 PATH：

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

- [x] Tauri 2 + React 19 + TS + Tailwind 4 工程骨架；单色 2D 线性图标集；**VS Code 风格单行沉浸式暗色标题栏**（Logo + 菜单组\[文件/编辑/查看/终端/帮助] + 文件菜单支持新建文件/新建文件夹/新建窗口 + 设置快捷项 + 随主题变色 + 拖拽标题 + 窗口控制）
- [x] Monaco ESM + Worker 全离线集成；多标签 / **代码左右分屏** / **Markdown 所见即所得编辑**（表格行列选择器、右上角行/列精确增删与尺寸重设、划词快捷浮动菜单、选中转代码块、原生 Ctrl+Z 撤销重做、正文段落旁大纲侧边栏与平滑定位） / Diff / 全局搜索
- [x] 本地 FileSystemProvider（原子写 + 保存冲突检测 + 路径穿越防护）；ui\_state 持久化（工作区/标签恢复）；多窗口独立关闭（非最后窗口不退出全进程）
- [x] **远程连接与 WSL 极简合并面板**：统一侧边栏入口与左上角下拉切换；SSH 极简两行与 WSL 单行布局；新窗口与当前窗口操作图标化；新建配置名称选填（默认回退 IP）；点击当前窗口直连并自动打开工作区资源管理器
- [x] **WSL 原生子系统工作区直连**：`wsl://` 统一协议 + 本地极速 UNC 路径映射、无控制台黑框弹出（`CREATE_NO_WINDOW`）、静默探测发行版与家目录
- [x] **全环境多终端与分屏最大化（M4）**：终端 UI 移至侧边栏右侧（不侵占侧边栏高度）；新建终端(+)、分屏(|)与最大化(□/❐)统一靠右；**智能上下文终端创建**（本机工作区新建 PowerShell，SSH 工作区新建 SSH 远程终端，WSL 工作区新建 Linux 终端）；支持终端左右分屏与单/双终端独立隔离
- [x] **M2 SSH 设备池**：指纹计算（与 ssh-keygen 一致）、A/B/A 轮换、未知/变化阻断、Profile/Identity CRUD、凭据库（macOS Keychain / Windows Credential Manager）
- [x] **M3 SFTP 远程工作区**：统一 Provider + `remote://{device-uuid}/path` URI 调度、会话内 SFTP Channel 懒初始化、冲突检测、标准 realpath 解析、正斜杠跨平台规范化（彻底解决远程文件打开与黑屏卡死，SFTP 自动过滤 `.` / `..` 相对目录，Monaco 异常状态卡片与恢复重试）
- [x] **M5 局域网发现与 IP 搜索**：网段三框格式（前三段 + `1->254` + 端口 22 输入框）+ 自动填入本机真实 IP + 仅展示确认具有 SSH 对应端口的主机候选 + mDNS 监听
- [x] **M6 远程语言智能**：语言服务器检测（clangd/pylsp，只读不安装）、ROS2/CMake/Python 工程识别、compile\_commands.json 指纹、**LSP 桥接**（SSH exec 无 PTY + Rust JSON-RPC 组帧 + 自建 Monaco 桥：补全/悬停/定义跳转/诊断，按设备身份隔离）
- [x] **M7 打包与稳定性**：Windows MSI + NSIS 安装包（修复 Release capability 权限与 `close_window` 独立窗口关闭逻辑，彻底解决打包后无法退出与连带关闭）；macOS .app；断网资源检查通过（无 CDN/外链请求）

## 验证矩阵

| 层次                          | 结果                                                             |
| --------------------------- | -------------------------------------------------------------- |
| Rust 单元测试                   | 38/38（指纹/设备池/文件系统/WSL URI/迁移/搜索/发现/CIDR/LSP 组帧）                |
| SSH 互操作集成测试                 | 3/3（身份轮换与认证 / SFTP 全流程 / exec+PTY）                             |
| 真机互操作（Windows→Ubuntu 20.04） | 5/5（身份认证 / exec / SFTP / PTY / LSP 检测）                         |
| LSP 桥真机测试                   | 2/2（clangd 握手+hover / 双通道隔离）                                   |
| Windows 平台专项                | 4/4（Credential Manager 往返 / 中文+emoji 凭据 / 网卡枚举 / WSL 发行版探测与解码） |
| 前端构建                        | TS 严格模式 + Vite 8 全绿                                            |
| 端到端 UI 验收                   | 新建配置→连接→指纹登记→会话建立（真实 UI 操作）✅                                   |
| 打包                          | Windows MSI + NSIS ✅ · macOS .app ✅                            |

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

| 里程碑 | 内容              | 状态                                                      |
| --- | --------------- | ------------------------------------------------------- |
| M0  | 技术验证与骨架         | ✅（双平台编译）                                                |
| M1  | 本地编辑器闭环         | ✅（Markdown Typora 风格所见即所得/单行暗色标题栏/Diff/搜索/持久化）          |
| M2  | SSH 身份与设备池      | ✅；§12.2 剩克隆 Host Key/同 IP 抢占需第二台设备                      |
| M3  | SFTP 远程工作区与 WSL | ✅（修复远程文件打开；原生 WSL UNC 映射与管理）                            |
| M4  | 终端与构建任务         | ✅（任务超时延至 30 分钟）                                         |
| M5  | 局域网发现           | ✅                                                       |
| M6  | 远程语言智能          | ✅（检测/识别/LSP 桥接完成；真机 clangd 验证）                          |
| M7  | 打包与发布           | ✅（Windows MSI/NSIS；修复 Release 沙箱退出；macOS .app；签名/公证待证书） |

## 安全基线（不可妥协）

1. 未知或变化的 SSH Host Key 永不自动放行（ADR-007）。
2. SQLite 与日志不存明文凭据；秘密仅存 OS 凭据库（§9.2）。
3. 缓存、LSP、工程环境按 `device_identity_id` 隔离，不以 IP 为键（§9.3）。
4. 离线红线：不依赖 CDN、云服务、账号登录（§1.4/§10.2）。

