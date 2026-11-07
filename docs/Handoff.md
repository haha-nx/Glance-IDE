# Glance IDE — 工作交接文档（Handoff）

> 生成日期：2026-11-08 · 基于技术架构 v3.0 与开发计划 v1.0
> 读者：接手本项目的开发者。读完本文档应能独立运行、测试、打包并继续开发。

---

## 0. 2026-11-08 Windows 端交付会话摘要（最新）

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
核心能力：本地与 SFTP 远程文件编辑（Monaco）、SSH 设备池（同 IP 多设备轮换身份识别）、
PTY 终端、远程构建任务与错误跳转、局域网设备发现、远程语言环境检测。

**核心数据模型（不可破坏）**：网络端点 / 连接配置 / 设备身份 / 远程环境 四层分离（ADR-003~007）。
一切远程资源以 `remote://{device-identity-uuid}/path` 编址；未知/变化的 Host Key 永不自动放行；
凭据只进 OS 钥匙串。

## 2. 当前状态（截至本次交接）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 技术验证 | ✅ | Monaco ESM+Worker 全离线；russh/russh-sftp/rusqlite 锁定；**Windows 编译通过** |
| M1 本地编辑器 | ✅ | 文件树/多标签/Markdown 预览/Diff/全局搜索/ui_state 持久化；**Windows 渲染验证** |
| M2 SSH 设备池 | ✅ 核心 | 指纹计算与 ssh-keygen 一致；A/B/A 轮换；未知/变化阻断；Profile/Identity CRUD；Keychain；**Windows 凭据管理器验证** |
| M3 SFTP 远程工作区 | ✅ 核心 | 统一 Provider + URI 调度 + 会话内 SFTP 通道懒初始化 + 冲突检测；**canonicalize 修复后 Windows 真机验证** |
| M4 终端与构建 | ✅ 核心 | PTY(xterm.js) + exec 任务(stdout/stderr 分离+ExitStatus) + Problem Matcher + 错误跳转 |
| M5 局域网发现 | ✅ | mdns-sd + CIDR TCP 扫描（并发/超时/取消）+ SSH banner 分级；**Windows 网卡枚举验证** |
| M6 远程语言智能 | ✅ | 检测/工程识别/compile_commands 指纹 + **LSP 桥接完成**（§5.4 Spike 结论；真机 clangd 握手/hover/隔离通过） |
| M7 打包发布 | ✅ | macOS .app + **Windows MSI + NSIS 安装包**；断网资源检查通过（两端） |

**测试**：Rust 单元 37/37 · loopback 互操作 3/3 · 真机互操作 5/5（Ubuntu 20.04，Windows 客户端）
· **LSP 桥真机 2/2** · **Windows 平台专项 3/3**（凭据管理器/中文密码/网卡）
· 前端 TS 严格模式构建全绿 · UI 走查：macOS 全量；Windows 关键路径（见 §5.6）。

**用户已实机复测反馈并修复的 6 项**：SSH 连不通/扫不到设备（macOS 本地网络权限根因，见 §5.1）、
全屏切窗口布局丢失、Diff 方向、Markdown 预览交互（现为双按钮 + 全屏预览 + 浮动编辑抽屉）、
原生文件菜单缺失。

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
  `src-tauri/target/release/bundle/macos/Glance IDE.app`

## 4. 测试体系与命令

```bash
# 全部单元测试
cd src-tauri && cargo test --lib

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

### 5.2 遗留工作清单（2026-11-08 更新）
1. ~~M6 LSP 桥接~~ ✅ 已完成（§5.4）。后续可选增强：completionItem/resolve 懒解析、
   documentSymbol/重命名、增量 didChange、会话断线自动重开 LSP。
2. **dmg 打包失败**：`bundle_dmg.sh` 报 Finder AppleEvent 超时（-1712），本机 Finder 脚本执行
   环境问题，与代码无关。.app 本身可靠产出；dmg 可换机器/重启 Finder 后重试。
3. ~~Windows 侧全部未验证~~ ✅ 已完成（§0/§5.5）。Windows 需补装 NASM（aws-lc-sys）。
4. **§12.2 真机 8 项验收**：已自动化 3 项 + 单设备 UI 全流程；克隆 Host Key 检测、
   同 IP 抢占等 5 项需两台真实设备。
5. vite dev 首启竞态：lockfile 变化后首次加载可能白屏（Re-optimizing 竞态），刷新即可；
   仅 dev 存在。
6. 屏幕控制（CUA）权限代理挂起：macOS/Windows 均存在（§5.6）。UI 回归建议人工执行。

### 5.3 踩坑速查（代码层面）
| 坑 | 结论 |
|---|---|
| serde 枚举序列化 | `#[serde(tag, rename_all)]` 只改变体名；变体字段需 `rename_all_fields = "camelCase"`（已加回归测试 `connect_outcome_serializes_camel_case`） |
| monaco-editor 0.5x 包导出 | exports map `./*`→`./esm/vs/*`，深路径写 `monaco-editor/editor/editor.worker`（无 `vs` 前缀） |
| base64 crate | STANDARD 引擎解码要求规范填充；指纹（43 字符无填充）需 `DecodePaddingMode::Indifferent`（`host_key_verifier.rs` 的 `B64` 引擎） |
| russh 0.65 | 通道 IO 用 `channel.split()` → read_half.wait() 处理 `ChannelMsg::{Data,ExtendedData,ExitStatus,Eof,Close}`；写用 `write_half.data_bytes()`；**不要**持 std MutexGuard 跨 await（会污染 async command 的 Send） |
| russh-sftp 3.0 | `session.write()` 只带 WRITE 标志不 CREATE——写文件必须用 `sftp.create()`（CREATE\|TRUNCATE\|WRITE）；write_file 在 `filesystem/sftp.rs` |
| keyring 4.x | 默认 feature 已含 Keychain/Credential Manager，不要加 `apple-native`（v3 的 feature，4.x 会编译失败） |
| Rust 通道模型 | Tauri 长输出用 `tauri::ipc::Channel`；产品层用 `EventSink = Arc<dyn Fn(Value)+Send+Sync>` 抽象（测试可传闭包），见 `app_services/terminal.rs` |

## 6. 代码地图（关键入口）

```
src/                            # 前端（React）
  components/editor/EditorArea.tsx   # 编辑器区：模式切换/菜单事件/设置弹窗
  components/ssh/SshPanel.tsx        # 远程设备面板：Profile CRUD/连接/指纹登记/环境检测
  components/terminal/TerminalPanel.tsx  # 底部面板：xterm 终端/任务运行/问题列表
  components/discovery/DiscoveryPanel.tsx # 局域网发现
  lib/models.ts                  # Monaco Model 注册表（URI 唯一性）
  lib/problems.ts                # Problem Matcher（gcc/clang/python）
  stores/                        # zustand：tabs/explorer/ui
src-tauri/src/
  lib.rs                         # AppState/菜单/命令注册/退出清理
  commands/                      # 薄层：fs(URI 调度)/ssh/terminal/discovery/lsp/workspace
  filesystem/                    # provider trait + local.rs + sftp.rs + remote_uri.rs
  ssh/                           # client.rs(russh 编排) / host_key_verifier.rs / device_pool.rs
  app_services/                  # connection_profiles/ssh_sessions/terminal/discovery/lsp/search
  storage/                       # database.rs(迁移 v1→v2) / secret_store.rs(keyring)
scripts/
  fix-macos-bundle.sh            # 打包后 Info.plist 补丁+重签（必跑）
  dev-runner.sh                  # cargo runner 自动签名
  e2e-server/                    # 本地 SSH 测试服务器
  gen_icon.py                    # 图标源图生成
docs/
  Glance-IDE_技术架构与实施路线图_v3.0.md   # 架构权威文档
  开发计划_v1.0.md                          # 里程碑与验收映射
```

## 7. 数据库与迁移

SQLite（app_data_dir/glance.db，PRAGMA user_version 管理）。当前 v2。
**新增迁移的正确姿势**：在 `storage/database.rs` 追加 `MIGRATION_V3` 常量 + 加入 MIGRATIONS 数组 +
写一条「旧版本库→新版」迁移测试（参照 `migration_v2_adds_key_path_column`）。
迁移前自动备份为 `.db.bak-v<旧版本>-<时间戳>`。

## 8. 下一步建议（优先级）

1. **M6 LSP 桥 Spike**（§6.4）：先做 WebSocket 方案 PoC（127.0.0.1+令牌+会话结束即关），
   对比 Tauri Channel 延迟；冻结后接入 monaco-languageclient，实现远程 clangd 补全/诊断。
2. **真机 8 项验收补全**：找第二台设备做克隆 Host Key/同 IP 抢占场景（§12.2）。
3. **Windows 环境**：跑 `npm run tauri build`，验证 keyring/WebView2；修复平台差异。
4. **dmg 修复**：换环境或排查 Finder AppleScript。
5. **设置面板实质化**：主题/字号/终端外观（现为止占位弹窗）。
6. **凭据体验**：Device Identity 级凭据 override（§4.5 同设备不同凭据场景）。

## 9. 安全红线（每次改动自查）

1. 未知/变化 Host Key 不自动放行（ADR-007）——`device_pool.rs` 逻辑勿绕过。
2. SQLite/日志无明文凭据——密码只经 keyring；`credential_ref` 形如 `glance://profile/<id>`。
3. 缓存/LSP/构建历史以 `device_identity_id` 为键，不以 IP。
4. 离线红线：不引入 CDN/在线字体/账号服务；Monaco Worker 随包分发。
5. 扫描不认证不建信任；PTY 与 exec/LSP 通道分离。
