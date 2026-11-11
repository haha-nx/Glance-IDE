# Glance IDE — 按钮与图标交互规范

> 适用范围：`src/components/**` 中所有可点击的 `<button>`。
> 目标：同类控件行为一致，用户无需猜测「这里能不能点」。
> 本文档是评审依据：新增/修改按钮时按此自查。
>
> 说明气泡由全局 `TooltipLayer` 统一渲染（悬停 250ms 出现），详见第 3 节。

---

## 1. 按钮分型

所有按钮先归入下面五类之一，再套用对应规则。

| 类型 | 定义 | 判定特征 |
|---|---|---|
| **A. 纯图标按钮** | 只有图标，没有可见文字 | `<svg>` 或 `<IconXxx />`，无文字节点 |
| **B. 图标 + 文字复合按钮** | 图标与文字同时出现，通常带边框 | 有 `<span>` 文字 + 图标 |
| **C. 纯文字按钮** | 只有文字 | 无图标 |
| **D. 窗口控制按钮** | 标题栏最小化/最大化/关闭 | 仅 Windows 自绘标题栏（macOS 用系统红绿灯） |
| **E. 菜单项** | 下拉菜单中的整行选项 | 位于菜单容器内，整行可点 |

---

## 2. 悬停（hover）规则

### 2.1 A 类：纯图标按钮 —— **必须加 hover 背景**

```tsx
// 标准图标按钮
className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"

// 主操作图标（连接、确认等）
className="flex h-6 w-6 items-center justify-center rounded text-sky-400 hover:bg-sky-500/15 hover:text-sky-300 transition-colors"

// 危险操作图标（删除、关闭）
className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400 transition-colors"
```

**硬性要求**

1. 必须有 `rounded`（图标背景需要有形状，不能是方块）。
2. 必须有 `hover:bg-*`：普通操作 `hover:bg-zinc-800`；主操作 `hover:bg-sky-500/15`；危险操作仍用 `hover:bg-zinc-800`，仅文字变红。
3. 必须有 `hover:text-*`，与背景变化同时生效。
4. 必须有 `transition-colors`，避免生硬切换。

> 这一条就是「为什么有的图标有 hover 背景、有的没有」的答案：以前图标按钮散落在各面板中，部分只改了文字颜色（`hover:text-*`），没有背景；现在统一为「图标按钮一律带背景反馈」。

### 2.2 B 类：图标 + 文字复合按钮 —— **不加图标式 hover 背景**

复合按钮本身已有边框/底色，悬停时改变容器外观，不再叠加第二层图标背景：

```tsx
className="... rounded border border-zinc-700/80 bg-zinc-950/80 ... hover:border-sky-500/50 hover:text-sky-300"
```

理由：再加 `hover:bg-*` 会与已有 border/background 叠成两层视觉，和 A 类混在一起反而更乱。

**例外**：复合按钮如果处于无边框形态（例如未来新增的纯文字+图标工具条项），按 C 类处理，使用文字/背景变化，不加边框。

### 2.3 C 类：纯文字按钮 —— **改变自身表面，不加图标背景**

- 主按钮：`bg-sky-600 hover:bg-sky-500 text-white`
- 次按钮：`border border-zinc-700 bg-zinc-800 hover:bg-zinc-700`
- 文本链接式：`text-zinc-400 hover:text-zinc-200`（无背景）

文字按钮不加 `hover:bg-zinc-800` 这种图标专用背景，避免与主/次按钮的层级混淆。

### 2.4 D 类：窗口控制按钮 —— **整高 hover 背景**

Windows 自绘标题栏专用：

- 最小化/最大化：`hover:bg-zinc-800/70 hover:text-zinc-100`
- 关闭：`hover:bg-[#e81123] hover:text-white`
- 尺寸固定 `h-full w-11`，不使用 A 类的 24px 规格。

### 2.5 E 类：菜单项 —— **整行 hover**

`hover:bg-sky-600 hover:text-white`，图标不单独加 hover。菜单项不属于「图标按钮」。

### 2.6 明确「不加 hover 背景」的位置

| 位置 | 原因 |
|---|---|
| 品牌 Logo / 标题文字 | 不是按钮，仅拖拽区域 |
| 菜单项（E 类） | 整行高亮，图标背景无意义 |
| 纯文字按钮（C 类） | 有自己的表面样式 |
| 复合按钮（B 类） | 已有边框/底色，悬停改变容器 |
| 禁用的图标按钮 | 仍保留 hover 样式但 `disabled:opacity-*`，不可点时视觉应明显变淡 |
| 拖拽手柄 / 分隔条 | 只改 `cursor` 与颜色，不套按钮规范 |

---

## 3. 说明气泡（Tooltip）规则

### 3.0 为什么不用原生 `title`

原生 `title` 的显示延迟由**操作系统 / WebView** 决定，应用无法配置：

- macOS WKWebView 通常要 1–2 秒，系统繁忙时更久；
- Windows WebView2 约 0.5–1 秒；
- 样式、位置、换行都不可控，深色界面里通常是系统浅色气泡。

所以本项目用一个全局 `TooltipLayer`（`src/components/common/TooltipLayer.tsx`）：

1. 组件挂载后把所有 `title` 批量迁移为 `data-tooltip`，同时补 `aria-label` 保留无障碍语义；
2. `MutationObserver` 兜底后续动态出现的 `title`；
3. 悬停 **250ms** 后显示自定义气泡，移出立即隐藏；
4. 定位规则：
   - **活动栏主按钮**（资源管理器/搜索/源代码管理/远程连接/局域网发现）：气泡在按钮**右侧**，通过 `data-tooltip-side="right"` 标记；
   - **面板内子按钮**（刷新、新建、连接、关闭等）：气泡默认在按钮**下方**；
   - 右侧/下方空间不足时自动翻转到可用方向，并做贴边收敛；
5. 点击、滚动、窗口失焦时自动收起。

**开发约定：代码里照常写 `title="…"` 即可**；需要放在右侧的气泡额外加 `data-tooltip-side="right"`，运行时会自动被接管；不要再用 `aria-label` 代替 `title`。

### 3.1 硬性要求

**所有 A 类纯图标按钮必须有 `title` 属性。**

```tsx
<button title="刷新源代码管理" ...>
  <IconRefresh size={14} />
</button>
```

- 没有可见文字的按钮，用户无法从界面得知用途，`title` 是唯一说明。
- `title` 使用简短动宾短语：`新建文件`、`刷新列表`、`关闭终端面板`。
- 有动态状态时写动态文案：
  ```tsx
  title={isMaximized ? "还原终端面板" : "最大化终端面板"}
  title={isMaximized ? "还原" : "最大化"}
  ```
- 带快捷键的按钮在气泡里附带快捷键：`title="提交更改 (Ctrl+Enter)"`。
- 带额外上下文的按钮可在气泡中补充一句：`title="向右拆分编辑器（也可拖动标签到编辑区四边进行分屏）"`。

### 3.2 其他类型

| 类型 | 是否需要 `title` |
|---|---|
| A 纯图标 | **必须** |
| B 图标 + 文字 | 可选；文字含义不完整时补充（如 `管理 Git 工作树 (Worktrees，共 N 个)`） |
| C 纯文字 | 不需要，文字本身即说明 |
| D 窗口控制 | 必须（`最小化` / `最大化` / `关闭`） |
| E 菜单项 | 不需要，菜单文字即说明 |

### 3.3 反例

```tsx
// ❌ 图标按钮没有说明
<button onClick={refresh}><IconRefresh /></button>

// ❌ 用 aria-label 代替 title（桌面端用户看不到 tooltip）
<button aria-label="刷新"><IconRefresh /></button>

// ✅ 正确
<button title="刷新列表" onClick={refresh}><IconRefresh /></button>
```

如需兼顾读屏软件，可同时写 `title` 与 `aria-label`，但 **`title` 不可省略**。

---

## 4. 尺寸与圆角

| 场景 | 尺寸 | 圆角 |
|---|---|---|
| 面板工具栏 / 卡片操作 | `h-6 w-6` | `rounded` |
| 紧凑列表行（Git、终端标签） | `h-5 w-5` | `rounded` |
| 标签页关闭、表格弹窗关闭 | `p-0.5` / `p-1` | `rounded` |
| Windows 窗口控制 | `h-full w-11` | 无（贴边） |
| 主/次文字按钮 | `h-7 px-3` | `rounded` |

同一面板内保持一致；不要在同一行混用 `h-5` 与 `h-6`。

---

## 5. 状态规则

| 状态 | 表现 |
|---|---|
| **hover** | 按第 2 节规则 |
| **active / 选中** | 用底色表达：`bg-zinc-800 text-sky-400`（如活动栏、活动标签） |
| **disabled** | `disabled:opacity-50`（图标）/ `disabled:opacity-40`（文字），保留 hover 样式但不可点 |
| **加载中** | 图标替换为 `animate-spin` 圆环，按钮保持原尺寸，`disabled` |
| **危险操作** | hover 仅文字变红 `hover:text-red-400`，背景仍为 `hover:bg-zinc-800`；不要整块红色背景，除非是「确认删除」类主按钮 |

---

## 6. 代码模板

### 6.1 标准工具图标按钮

```tsx
<button
  title="刷新源代码管理"
  disabled={busy}
  onClick={refresh}
  className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 transition-colors"
>
  <IconRefresh size={14} />
</button>
```

### 6.2 主操作图标按钮（无边框）

```tsx
<button
  title="在当前窗口连接并打开工作区"
  onClick={connect}
  className="flex h-6 w-6 items-center justify-center rounded text-sky-400 hover:bg-sky-500/15 hover:text-sky-300 transition-colors"
>
  <IconArrowRight size={13} />
</button>
```

### 6.3 危险图标按钮

```tsx
<button
  title="删除配置"
  onClick={remove}
  className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400 transition-colors"
>
  <IconTrash size={13} />
</button>
```

### 6.4 复合按钮（带边框）

```tsx
<button
  title="切换或新建分支"
  className="... rounded border border-zinc-700/80 hover:border-zinc-600 ..."
>
  <IconGitBranch size={12} />
  <span>{branch}</span>
</button>
```

---

## 7. 评审自查清单

新增或修改按钮时逐条确认：

- [ ] 已归入 A–E 某一类
- [ ] A 类：有 `title`
- [ ] A 类：有 `rounded` + `hover:bg-*` + `hover:text-*` + `transition-colors`
- [ ] B 类：悬停只改容器（border/文字），不叠图标背景
- [ ] C 类：只改自身表面，不加图标背景
- [ ] D 类：整高、关闭按钮红色 hover
- [ ] 动态标题使用三元表达式，而不是写死
- [ ] disabled 状态有透明度变化
- [ ] 同一面板内尺寸一致
- [ ] 没有用 `aria-label` 替代 `title`

---

## 8. 本次统一结果

- 说明气泡：原生 `title` 延迟 1–2 秒 → 改为全局自定义气泡（250ms）
- 全仓库 157 个按钮，其中 38 个为纯图标按钮（另有 2 个图标+文字复合按钮被审计脚本误判，已在规则中说明）
- 统一前：3 个缺 `title`，13 个只有文字变色、没有 hover 背景
- 统一后：**38/38 纯图标按钮均有 `title` 与 `hover:bg-*`**；`GitPanel` 的分支选择与工作树计数属于 B 类复合按钮，按规则只改边框/文字
- 涉及文件：`TitleBar.tsx`、`TerminalPanel.tsx`、`ExplorerPanel.tsx`、`DiscoveryPanel.tsx`、`RemotePanel.tsx`、`MarkdownWysiwyg.tsx`、`GitPanel.tsx`、`SshPanel.tsx`、`WslPanel.tsx`
