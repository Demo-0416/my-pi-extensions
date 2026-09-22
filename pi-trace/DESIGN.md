# pi_extension 设计文档

两个 pi 扩展的开发目录：

| 扩展 | 形态 | 参考来源 |
|---|---|---|
| `better-claude-code-ui` | Claude Code 完整视觉身份：6 套主题 + chrome（欢迎盒/状态栏/spinner/标题）+ 工具与消息渲染。**替换已装的 `pi-claude-code-ui`** | `claude-code-main`（原版）、`dsh-tui`（已验证的 pi-tui 移植）、`pi-claude-code-ui`（借鉴实现，MIT） |
| `pi-trace` | 仿 deepseek-harness 轨迹页（Web+SSE 为主，TUI widget 为辅） | `deepseek-harness/packages/client/ui-trajectory` |

---

## 1. 目录结构与加载方式

```
pi_extension/
├── DESIGN.md
├── better-claude-code-ui/
│   ├── theme/
│   │   ├── claude-code-dark.json            # 层 1：CC dark 精确配色
│   │   ├── claude-code-light.json           #        CC light
│   │   ├── claude-code-dark-daltonized.json #        色盲友好 dark
│   │   ├── claude-code-light-daltonized.json
│   │   ├── claude-code-dark-ansi.json       #        仅 16 ANSI 色
│   │   └── claude-code-light-ansi.json
│   └── extension/
│       ├── index.ts            # 入口：层 2/3 装配 + 命令注册
│       ├── palette.ts          # CC 六色板（dark/light/daltonized/ansi）+ 主题感知
│       ├── banner.ts           # 层 2a：欢迎盒（移植 dsh-tui HeaderComponent → CC 版）
│       ├── status-line.ts      # 层 2c：状态栏（移植 CC StatusLine 字段）
│       ├── spinner.ts          # 层 2b：CC spinner 帧 + 动词（公共 API，不打补丁）
│       ├── turn-footer.ts      # 层 2d：✻ Worked for Ns（appendEntry + entry renderer）
│       ├── tools/              # 层 3：工具渲染（替换 pi-claude-code-ui）
│       │   ├── builtins.ts     #   read/bash/grep/find/ls/edit/write 的 renderCall/Result
│       │   ├── diff.ts         #   shiki diff + stat bar + hunk 折叠 + 词级高亮
│       │   ├── grouping.ts     #   连续工具调用分组 + 分支线 ├ └ │
│       │   ├── mcp.ts          #   MCP 工具渲染（hidden/summary/preview）
│       │   └── live-preview.ts #   运行中实时预览
│       └── commands.ts         # /cc-tools /cc-theme /cc-spinner
└── pi-trace/
    ├── package.json
    └── src/
        ├── index.ts
        ├── model.ts
        ├── collector.ts
        ├── store.ts
        ├── session-loader.ts
        ├── stats.ts
        ├── server.ts
        └── web/
            ├── index.html
            ├── app.ts
            ├── timeline.ts
            ├── ledger.ts
            ├── format.ts
            └── styles.css
```

**加载方式**（`~/.pi/settings.json`，支持 `/reload` 热更）：

```jsonc
{
  "packages": [ /* 移除 npm:pi-claude-code-ui，完成替换 */ ],
  "extensions": [
    "/Users/bytedance/ai_coding/my_agents/pi_extension/better-claude-code-ui/extension/index.ts",
    "/Users/bytedance/ai_coding/my_agents/pi_extension/pi-trace/src/index.ts"
  ],
  "themes": [
    "/Users/bytedance/ai_coding/my_agents/pi_extension/better-claude-code-ui/theme"
  ],
  "theme": "claude-code-light/claude-code-dark"
}
```

- `"theme": "claude-code-light/claude-code-dark"` 是 pi 的自动明暗对语法（`parseAutoThemeSetting`）：终端亮时用 light、暗时用 dark，随终端外观自动切换。
- 想固定一套：`"theme": "claude-code-dark"`。色盲用户换 daltonized 版。
- 主题文件编辑后 pi 自动热重载。
- **替换步骤**：从 `packages` 移除 `npm:pi-claude-code-ui` → 加入本扩展 → `/reload`。功能覆盖对照见 2.7。

---

## 2. better-claude-code-ui 设计

### 2.0 三家参考的分工

| 来源 | 抄什么 |
|---|---|
| `claude-code-main/src/utils/theme.ts` | **6 套主题的精确 RGB**（dark/light/daltonized/ansi 全量） |
| `claude-code-main/src/constants/figures.ts` + `Spinner/` | **字形与 spinner**：`⏺`/`✻`/`∴`、帧序列、~200 个趣味动词 |
| `claude-code-main/src/components/LogoV2/` + `StatusLine.tsx` | **欢迎盒与状态栏的信息架构** |
| `dsh-tui/src/components/transcript.ts` | **pi-tui 移植范本**：HeaderComponent（CC 形状欢迎盒）、UserMessageComponent、turnFooterRow、GUTTER 系统 |
| `dsh-tui/src/render/palette.ts` | **SGR 纪律**：每个 span 只关自己开的组（fg `39`、bg `49`），不用裸 `ESC[0m` |
| `pi-claude-code-ui/extensions/` | **借鉴实现并替换**：工具 renderCall/Result、shiki diff、分组分支线、状态点、MCP、live preview、命令体系。MIT 许可，node_modules 里可读，重写为干净版本 |

### 2.1 视觉分割（Layout）

```
┌─────────────────────────────────────────────┐
│  HEADER   欢迎盒（setHeader 替换内置 header）  │  ← 层 2a
├─────────────────────────────────────────────┤
│  TRANSCRIPT  消息流（pi 自渲染，主题色影响）    │  ← 层 1（主题）
│   ● 助手消息 / ⏺ 工具 / ∴ thinking          │
│   ✻ Worked for 45s（turn footer）           │  ← 层 2d
├─────────────────────────────────────────────┤
│  PROMPT  输入框（pi 自渲染，borderMuted 等）   │  ← 层 1（主题）
├─────────────────────────────────────────────┤
│  FOOTER  状态栏（setFooter 替换内置 footer）   │  ← 层 2c
└─────────────────────────────────────────────┘
```

### 2.2 层 1：六套主题

CC `THEME_NAMES` 全量六套，每套一个 JSON 文件。色值全部来自 `claude-code-main/src/utils/theme.ts`，不做臆造。

**CC 六色板总表**（RGB → hex）：

| 角色 | dark | light | dark-daltonized | light-daltonized | dark-ansi | light-ansi |
|---|---|---|---|---|---|---|
| claude | #D77757 | #D77757 | #FF9933 | #FF9933 | 9 | 9 |
| claudeShimmer | #EB9F7F | #F59575 | #FFB765 | #FFB765 | 11 | 11 |
| autoAccept | #AF87FF | #8700FF | #AF87FF | #8700FF | 13 | 13 |
| bashBorder | #FD5DB1 | #FF0087 | #3399FF | #0066CC | 13 | 13 |
| permission | #B1B9F9 | #5769F7 | #99CCFF | #3366FF | 12 | 4 |
| planMode | #48968C | #006666 | #669999 | #336666 | 14 | 6 |
| promptBorder | #888888 | #999999 | #888888 | #999999 | 15 | 15 |
| inactive (muted) | #999999 | #666666 | #999999 | #666666 | 15 | 8 |
| subtle (dim) | #505050 | #AFAFAF | #505050 | #AFAFAF | 15 | 8 |
| success | #4EBA65 | #2C7A39 | #3399FF | #006699 | 10 | 2 |
| error | #FF6B80 | #AB2B3F | #FF6666 | #CC0000 | 9 | 1 |
| warning | #FFC107 | #966C1E | #FFCC00 | #FF9900 | 11 | 3 |
| diffAddedBg（行底） | #225C2B | #69DB7C | #004466 | #99CCFF | 2 | 2 |
| diffRemovedBg（行底） | #7A2936 | #FFA8B4 | #660000 | #FFCCCC | 1 | 1 |
| diffAddedWord（词级） | #38A660 | #2F9D44 | #0077B3 | #3366CC | 10 | 10 |
| diffRemovedWord（词级） | #B3596B | #D1454B | #B30000 | #993333 | 9 | 9 |
| userMsgBg | #373737 | #F0F0F0 | #373737 | #DCDCDC | 8 | 15 |
| selectionBg | #264F78 | #B4D5FF | #264F78 | #B4D5FF | 4 | 6 |
| bashMsgBg（工具盒） | #413C41 | #FAF5FA | #413C41 | #FAF5FA | 0 | 15 |

ANSI 列是 xterm 256 色索引（0-15 = 基本 ANSI），pi 主题原生支持整数值。

**dark 主题完整 JSON**（`claude-code-dark.json`）：

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "claude-code-dark",
  "vars": {
    "claude": "#D77757", "claudeShimmer": "#EB9F7F",
    "autoAccept": "#AF87FF", "bashBorder": "#FD5DB1",
    "permission": "#B1B9F9", "planMode": "#48968C",
    "promptBorder": "#888888", "inactive": "#999999", "subtle": "#505050",
    "success": "#4EBA65", "error": "#FF6B80", "warning": "#FFC107",
    "diffAddedWord": "#38A660", "diffRemovedWord": "#B3596B",
    "userMsgBg": "#373737", "selectionBg": "#264F78", "bashMsgBg": "#413C41"
  },
  "colors": {
    "accent": "claude", "border": "subtle", "borderAccent": "claude",
    "borderMuted": "promptBorder",
    "success": "success", "error": "error", "warning": "warning",
    "muted": "inactive", "dim": "subtle", "text": "", "thinkingText": "inactive",
    "selectedBg": "selectionBg", "scrollbarThumb": "selectionBg",
    "searchMatchBg": "selectionBg", "searchMatchText": "",
    "userMessageBg": "userMsgBg", "userMessageText": "",
    "customMessageBg": "userMsgBg", "customMessageText": "", "customMessageLabel": "claudeShimmer",
    "toolPendingBg": "bashMsgBg", "toolSuccessBg": "bashMsgBg", "toolErrorBg": "bashMsgBg",
    "toolTitle": "claude", "toolOutput": "inactive",
    "mdHeading": "", "mdLink": "permission", "mdLinkUrl": "subtle",
    "mdCode": "claudeShimmer", "mdCodeBlock": "", "mdCodeBlockBorder": "subtle",
    "mdQuote": "inactive", "mdQuoteBorder": "subtle", "mdHr": "subtle", "mdListBullet": "claude",
    "toolDiffAdded": "diffAddedWord", "toolDiffRemoved": "diffRemovedWord", "toolDiffContext": "inactive",
    "syntaxComment": "#6A9955", "syntaxKeyword": "#569CD6", "syntaxFunction": "#DCDCAA",
    "syntaxVariable": "#9CDCFE", "syntaxString": "#CE9178", "syntaxNumber": "#B5CEA8",
    "syntaxType": "#4EC9B0", "syntaxOperator": "#D4D4D4", "syntaxPunctuation": "#808080",
    "thinkingOff": "subtle", "thinkingMinimal": "subtle", "thinkingLow": "planMode",
    "thinkingMedium": "permission", "thinkingHigh": "autoAccept",
    "thinkingXhigh": "bashBorder", "thinkingMax": "bashBorder",
    "bashMode": "bashBorder"
  },
  "export": { "pageBg": "#1E1E1E", "cardBg": "#373737", "infoBg": "#413C41" }
}
```

**light 主题**（`claude-code-light.json`）：同结构，vars 换成 light 列色值，差异点：

- `text: ""`（终端默认前景，亮终端下即深色）——CC 原版写死黑，pi 里用默认前景更稳
- `mdHeading: ""`、`mdCodeBlock: ""` 同 dark（CC 排版克制）
- `syntax*` 用亮底可读的 GitHub Light 盘：comment `#6A737D`、keyword `#D73A49`、function `#6F42C1`、variable `#005CC5`、string `#032F62`、number `#005CC5`、type `#22863A`
- `export`: `{ "pageBg": "#FFFFFF", "cardBg": "#F0F0F0", "infoBg": "#FAF5FA" }`

**daltonized 两套**：vars 换 daltonized 列（success→蓝、error→纯红、warning→橙、claude→#FF9933），syntax 用色盲友好盘。

**ansi 两套**：vars 全部用 0-15 整数索引（上表 ANSI 列），供无 truecolor 的终端。

映射要点（小细节）：

- **工具盒三色合一**：CC 工具卡背景是中性灰（dark `#413C41` / light `#FAF5FA`），成功/失败靠标题行 `⏺` 颜色区分，不靠背景染色 → `toolPendingBg/toolSuccessBg/toolErrorBg` 都映射 `bashMsgBg`。
- **diff 双层色**：CC diff 是「行底 + 词级高亮」两层。pi 主题只有 `toolDiffAdded/Removed/Context` 三个前景位 → 词级色进主题，行底色（`diffAddedBg/RemovedBg`）进扩展 `palette.ts`，由 diff 渲染层用 `bgAnsi` 实现（dsh-tui `render/diff.ts` 已有现成实现可搬）。
- **thinking 级别边框**（pi 特有，CC 无）：按 CC 模式色语义映射 plan→teal、permission→蓝紫、auto-accept→紫、最高→粉。
- **mdHeading 用正文色**：CC 层级靠加粗不靠颜色。

### 2.3 层 2a：欢迎盒（banner.ts）

移植 `dsh-tui/src/components/transcript.ts` 的 `HeaderComponent`（本身就是"in the shape of Claude Code's welcome box"），两处改造：

1. **品牌换成 CC**：DeepSeek 鲸鱼 ASCII → CC 的 `✻` 大字标（或 Clawd，`claude-code-main/src/components/LogoV2/Clawd.tsx`）；wordmark 从 `DEEPSEEK HARNESS` → `pi ✻` 风格（保留 pi 身份，CC 风格）。
2. **身份行照 CC StatusLine 字段**：model、cwd、git branch、resumed id。

三档宽度响应（dsh-tui 已实现，直接搬）：

```
宽 (≥76 列)                    中 (40-75 列)                 窄 (<40 列)
╭─ pi ✻ ────────────────╮      ╭──────────────────╮
│      ✻✻✻        [Skills] │    │  ✻✻✻             │      pi ✻
│    ✻✻✻✻✻   skill-a, ... │    │  ✻✻✻             │      model
│      ✻✻✻                │    │  pi ✻            │      ~/cwd
│   model                 │    │  model           │
│   ~/cwd                 │    │  ~/cwd           │
╰────────────────────────╯      ╰──────────────────╯
```

实现：`ctx.ui.setHeader((tui, theme) => ...)`，参照 `examples/extensions/custom-header.ts`。SGR 纪律搬 dsh-tui `palette.ts`。

### 2.4 层 2b：spinner（spinner.ts）

**不用 pi-claude-code-ui 的 Loader 原型补丁方案**，用 pi 公共 API：

```typescript
// 帧序列：claude-code-main/src/components/Spinner/utils.ts
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"]
const SPINNER = [...FRAMES, ...[...FRAMES].reverse()]  // 正放 + 倒放

// 动词：claude-code-main/src/constants/spinnerVerbs.ts（~200 个）
const VERBS = ["Accomplishing", "Baking", "Brewing", "Cooking", ...]

pi.on("session_start", (_e, ctx) => {
  ctx.ui.setWorkingIndicator({
    frames: SPINNER.map(ch => ctx.ui.theme.fg("accent", ch)),
    intervalMs: 170,
  })
})
pi.on("turn_start", () => { verb = sample(VERBS) })           // 每 turn 采样一次
pi.on("agent_start", (_e, ctx) => ctx.ui.setWorkingMessage(`${verb}…`))
pi.on("agent_settled", (_e, ctx) => ctx.ui.setWorkingMessage())
```

细节：

- **170ms 间隔**（pi-claude-code-ui 实测值，比 CC 原版 250ms 轻快）。
- **Ghostty 特例**：`TERM === 'xterm-ghostty'` 时最后一帧用 `*` 代替 `✽`（字形偏移），CC `getDefaultCharacters()` 有判断，搬过来。
- **动词每 turn 采样一次**，re-render 不重采（dsh-tui `turnCompletionVerb()` 注释明确的语义）。
- **停滞动画**（CC `useStalledAnimation`：超时后 spinner 向错误色插值）：v2。

### 2.5 层 2c：状态栏（status-line.ts）

CC `StatusLine.tsx` 字段 → pi `ctx.ui.setFooter()`：

| 字段 | CC 来源 | pi 取数 |
|---|---|---|
| model | `renderModelName(runtimeModel)` | `ctx.model` |
| cwd | `getCwd()` | `ctx.cwd` |
| git branch | worktree branch | `pi.exec("git", ["branch","--show-current"])` 缓存 |
| context% | `calculateContextPercentages` | `ctx.getContextUsage()` |
| cost | `getTotalCost()` | 累加 `message_end` 的 `usage.cost.total` |
| 200k 警告 | `exceeds200kTokens` | `usage.tokens > 阈值` 时 warning 色 |
| permission mode | `permissionMode` | pi 无直接对应，显示 thinking level 或跳过 |

配色全用主题 token（`muted`/`dim`/`accent`/`warning`），与 CC 的 dim 状态栏一致。

### 2.6 层 2d：turn footer（turn-footer.ts）

CC 的 turn 收尾行（dsh-tui `turnFooterRow` 已移植）：

```
✻ Worked for 45s
```

- dim 色，`✻` 在 gutter 列（与消息 `●` 同列）
- 只在 turn 时长 > 阈值时显示（dsh-tui `TURN_FOOTER_MIN_MS`）
- 动词从 `TURN_COMPLETION_VERBS` 采样（"Worked"/"Cooked"/"Baked"...），每 turn 一次

pi 实现：`turn_end` 算时长 → `pi.appendEntry("cc-turn-footer", {ms, verb})` → `pi.registerEntryRenderer("cc-turn-footer", ...)` 渲染 dim 行。持久化在 session 里，resume 后仍可见。

### 2.7 层 3：工具与消息渲染（替换 pi-claude-code-ui）

**目标：完整覆盖已装扩展的功能面，用户卸载 `npm:pi-claude-code-ui` 后无感知缺失。** 借鉴其 MIT 实现，重写为干净版本。

功能覆盖对照表：

| 功能 | pi-claude-code-ui 现状 | 本扩展方案 |
|---|---|---|
| 内置工具紧凑渲染 | 重注册 read/bash/grep/find/ls/edit/write，自定义 renderCall/Result | 同方案，代码重写（`tools/builtins.ts`） |
| edit/write diff | shiki 高亮 + split/unified + 词级 + stat bar + hunk 折叠 | 搬 `render/diff.ts`（dsh-tui）+ shiki 集成（`tools/diff.ts`） |
| apply_patch 预览 | call 阶段渲染解析后的文件补丁 | 同 |
| 连续工具分组 | 分组头 + 每工具 glance 行 + 分支线 `├ └ │` | 同（`tools/grouping.ts`），分支线用 bare 形态（1.0.69 后的样式） |
| 状态点 | pending 闪烁 `●`、成功绿/失败红、15s stale 看门狗 | 同（`tools/grouping.ts` 内） |
| 文件类型图标 | 语言身份色图标 | 同 |
| MCP 工具 | hidden/summary/preview 三模式 | 同（`tools/mcp.ts`） |
| 运行中实时预览 | bash 最新 N 行，持续到下一个工具/文本活动 | 同（`tools/live-preview.ts`） |
| thinking 标签 | 流式 + 最终消息的 `∴` 标记，上下文清洗 | `registerMarkdownTransformer` 实现 |
| `✻ Turn took Ns` | 最终消息行，含会话总计 + turn 数 | 层 2d 的 turn footer 覆盖并增强 |
| 命令 | `/cc-tools` `/cc-theme` `/cc-spinner` | 同名保留（`commands.ts`），降低迁移成本 |
| Ctrl+Shift+O | 额外详情档（预览上限 4000→12000 行） | 同 |
| 主题自适应 | 从活动 pi 主题派生颜色 | **我们自己就是主题**：按主题名查 `palette.ts` 六色板，未知主题回退 token 派生 |
| 工具背景模式 | default/transparent/border | 同，配置项保留 |
| RTK 集成 | rewrite 通知折进 bash 行 + `(RTK)` 徽章 | 同 |
| subagent 完成通知 | 重样式为 CC 工具行 | 同 |

配置项（`~/.pi/settings.json`，与旧扩展同名同义，迁移零成本）：

```jsonc
{
  "toolBackground": "border",        // default | transparent | border
  "readOutputMode": "preview",       // hidden | summary | preview
  "searchOutputMode": "preview",
  "mcpOutputMode": "preview",
  "bashOutputMode": "opencode",      // opencode | summary | preview
  "previewLines": 8,
  "groupToolCalls": true,
  "liveToolPreview": true,
  "diffTheme": "github-dark"         // shiki 主题，随明暗主题自动切 github-light
}
```

### 2.8 小细节清单（照抄表）

| 细节 | CC 做法 | 来源 | 本扩展 |
|---|---|---|---|
| 消息 bullet | `⏺`（macOS）/`●`（其他平台） | `figures.ts` `BLACK_CIRCLE` | pi 自渲染用户/助手消息，glyph 不可换；主题色影响 |
| spinner glyph | `✻` teardrop asterisk | `figures.ts` `TEARDROP_ASTERISK` | `setWorkingIndicator` 帧序列 |
| thinking marker | `∴` | dsh-tui transcript | markdown transformer 给 thinking 块加前缀（v2） |
| gutter 对齐 | 所有 bullet 在 2 列 gutter 内对齐 | CC `<Box minWidth={2}>`、dsh-tui `GUTTER` | pi 自渲染不可控；turn footer 用 entry renderer 对齐 |
| 用户消息盒 | dark `#373737` / light `#F0F0F0` | CC `userMessageBackground` | 主题 `userMessageBg` |
| 选中色 | dark `#264F78` / light `#B4D5FF` | CC `selectionBg` | 主题 `selectedBg` |
| bash 边框粉 | dark `#FD5DB1` / light `#FF0087` | CC `bashBorder` | 主题 `bashMode` |
| plan 模式 teal | dark `#48968C` / light `#006666` | CC `planMode` | 主题 `thinkingLow` |
| auto-accept 紫 | dark `#AF87FF` / light `#8700FF` | CC `autoAccept` | 主题 `thinkingHigh` |
| 权限蓝紫 | dark `#B1B9F9` / light `#5769F7` | CC `permission` | 主题 `mdLink` |
| spinner 动词 | ~200 个趣味动词 | `spinnerVerbs.ts` | 搬全量 |
| turn 动词 | 过去式动词表 | dsh-tui `TURN_COMPLETION_VERBS` | 搬 |
| 欢迎盒 sweep reveal | 左到右扫入 | dsh-tui `setRevealWidth` | v2 |
| 终端标题 | `✻ <cwd>` | CC 惯例 | `ctx.ui.setTitle()` |
| 分支线形态 | bare `├`/`└` 无横臂 | pi-claude-code-ui 1.0.69 | 搬 |
| Agent 工具呼吸 | `● → • → · → 空` 尺寸循环 | pi-claude-code-ui 1.0.72 | 搬 |

### 2.9 实施分期

| 期 | 内容 | 依赖 |
|---|---|---|
| M1 | 6 套主题 JSON（2.2），热重载目视迭代 | 无，可独立交付 |
| M2 | spinner + 标题 + turn footer（2.4/2.6） | M1 |
| M3 | 欢迎盒（2.3） | M1 |
| M4 | 状态栏（2.5） | M1 |
| M5 | 工具渲染层（2.7）：builtins + diff + grouping | M1 |
| M6 | MCP + live preview + 命令 + Ctrl+Shift+O（2.7 剩余） | M5 |
| M7 | 卸载 pi-claude-code-ui，全量替换验收 | M2-M6 |

---

## 3. pi-trace 设计

### 3.1 架构

```
pi 事件流
   │
   ▼
Collector ──► TraceRecord ──► sidecar JSONL（~/.pi/agent/traces/<sessionId>.jsonl）
   │                                │
   ├─► TUI Widget（统计行，turn_end 刷新）│
   ▼                                ▼
HTTP + SSE Server（127.0.0.1:43110）◄─ 历史 session JSONL 回放（降级精度）
   │
   ▼
Web 前端：甘特图（4 泳道）+ 统计栏 + 按 Turn 分组流水账 + 搜索
```

核心决策：

1. **采集与展示分离**：Collector 只认 pi 事件，输出统一 TraceRecord；Web/TUI/历史回放都是 TraceRecord 的消费者。
2. **sidecar 而非 session 文件**：富时序数据（TTFT、精确时长）写 `~/.pi/agent/traces/<sessionId>.jsonl`，不污染 session JSONL，不进 LLM 上下文。
3. **两级精度**：sidecar 存在 = rich（精确时长/TTFT）；不存在 = 从 session JSONL 重建（timestamp 精确，duration 用相邻记录间隔推断，TTFT 不可得显示 `—`）。
4. **Web 为主、TUI 为辅**：完整轨迹在网页，TUI 只放一行统计 widget；`ctx.ui.custom()` 全屏 TUI 轨迹暂缓。

### 3.2 数据模型（model.ts）

```typescript
export type RecordKind = 'system' | 'user' | 'assistant' | 'tool' | 'compaction';

export interface TraceRecord {
  id: string;
  kind: RecordKind;
  turn: number | null;
  startedAt: number;          // epoch ms
  durationMs: number | null;  // rich 精确；重建为推断；user/system 为 null
  text: string;               // 摘要
  isError: boolean;
  model?: string;
  provider?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; costTotal: number };
  ttftMs?: number | null;
  toolName?: string;
  args?: unknown;
  result?: unknown;           // 截断后
  exitCode?: number;
}

export interface TraceTurn {
  turn: number;
  startedAt: number;
  endedAt: number | null;
  records: TraceRecord[];
}

export interface TraceSession {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  turns: TraceTurn[];
  records: TraceRecord[];
  precision: 'rich' | 'reconstructed';
}
```

### 3.3 事件映射（collector.ts）

| pi 事件 | 动作 |
|---|---|
| `session_start` | 定位 session 文件 → 有 sidecar 则加载，否则 `session-loader` 重建并落 sidecar；惰性启动 HTTP server |
| `turn_start` `{turnIndex, timestamp}` | 开 turn |
| `before_provider_request` | 记 LLM 调用起点（payload 里取 model） |
| `message_update` | 首个 content delta 的时间 = 首 token 时间（算 TTFT） |
| `message_end`（role=user） | 追加 `user` 记录 |
| `message_end`（role=assistant） | 闭合 LLM span：`durationMs = now - 调用起点`，`ttftMs = 首token - 起点`，取 `usage` |
| `tool_execution_start` `{toolCallId, toolName, args}` | 开 `tool` 记录（startedAt） |
| `tool_execution_end` `{toolCallId, result, isError}` | 闭合 tool 记录（durationMs/isError） |
| `tool_result` | 取最终 content/details（截断后存入，供展开查看） |
| `turn_end` | 闭合 turn；刷新 TUI widget；广播 SSE `stats` |
| `session_compact` | 追加 `compaction` 记录 |
| `session_shutdown` | flush sidecar（server 随进程退出，不单独关） |

pi 的一个 turn = 一次 LLM 响应 + 其工具调用，所以 **LLM Calls 泳道每个 turn 恰好一个 span**。自动重试产生新 turn，天然可见。

### 3.4 甘特图（timeline.ts）——对齐 dsh 截图的 4 泳道

| 泳道 | 颜色 | span 来源 |
|---|---|---|
| Duration | 灰 | 整个会话（或当前过滤范围）的总跨度 |
| Turns | 蓝/绿交替 | 每个 turn 的 [startedAt, endedAt] |
| LLM Calls | 紫 | 每个 assistant 记录的 [startedAt, startedAt+durationMs]，span 内标 TTFT 刻度线 |
| Tools | 橙（错误红） | 每个 tool 记录的执行区间 |

时间投影（仿 dsh，v1 做前两个）：

- `duration`（默认）：按真实时长比例，压缩空闲间隙
- `time`：真实墙钟，空闲如实留白
- `sequence`（v2）：每条记录等宽
- `actual`（v2）：真实时长不压缩

交互：点击/拖拽框选甘特图区间 → 下方 ledger 只显示落在区间内的记录；hover span → tooltip（起止时间、duration、TTFT、tokens、费用、exit code）。

### 3.5 流水账（ledger.ts）

按 Turn 分组（`Turn N` 分组头，可折叠），每条记录一行：

```
Turn 3
  ● USER      tell me about cli 设计                    12:03:22
  ● ASSISTANT claude-sonnet-4 · 47 tok/s · TTFT 5.5s   12:03:34 · 8.2s
  ● TOOL      bash {"command":"ls ..."}          [0]    12:03:42 · 0.3s
```

- 徽章配色：USER 蓝、ASSISTANT 紫、TOOL 橙、SYSTEM 灰、COMPACTION 黄
- 点击行展开：tool 看 args/result 全文，assistant 看正文 + thinking + usage 明细
- 搜索框：纯前端过滤（tool 名、命令、文本），与甘特框选可叠加
- 虚拟滚动：记录数 > 200 时启用窗口化渲染

### 3.6 统计栏（stats.ts）——对齐 dsh 底部口径

```
5 轮 · 11 步 · LLM 3m09s · 工具 0.5s · 首 token 平均 5.5s · 47 tok/s · 缓存命中 81% · 输入 244K tok · 输出 6K tok · $0.12
```

| 指标 | 口径 |
|---|---|
| 轮数 | turn 数 |
| 步数 | record 数 |
| LLM 总时长 | Σ assistant.durationMs |
| 工具总时长 | 各 tool span **并集**（并行工具不重复计时） |
| 平均 TTFT | Σ ttft / N（仅 rich） |
| 输出速率 | Σ output / Σ decodeMs，**只取合格样本**（见下） |
| 缓存命中率 | Σ cacheRead / Σ (input + cacheRead) |
| 输入/输出 | Σ usage.input / Σ usage.output |
| 费用 | Σ usage.cost.total |

**输出速率（tok/s）的分子分母必须来自同一批记录。** 旧逻辑会把时长未知的最后一条回复的 token 加进分子，却没有对应的时长，导致速率虚高。TUI、SSE 和网页现共用 `stats.ts`。一条 assistant 记录只有同时满足下列条件才作为速率样本，其 output 与 decodeMs 成对入账：

- `durationMs` 为非负有限数（时长未知的记录，其 token 也不进分子）
- 若有 TTFT，必须为有限数且位于 `[0, durationMs]`
- `decodeMs ≥ 50ms`（测量窗口下限，不是 TPS 上限；网页单条请求也使用该限制）
- `output` 为正有限数，且请求未失败或中断（不完整 usage 不用于速率）
- 记录 kind 为 assistant —— 工具自带的 `usage`（subagent 等嵌套 LLM 调用）计入 `outputTokens` 与费用，但单列 `nestedOutputTokens`，**绝不进速率分子**

有 TTFT 时，`decodeMs = durationMs − ttftMs`；无 TTFT 时使用完整请求时长，得到包含等待时间的平均速率，不能与纯解码速率直接比较。**例外**：`usage.reasoning > 0` 但 thinking 正文为空（如 model_hub/es1_orange_o50，推理只在服务端进行、不随流式增量下发）时，ttft 到 message_end 的窗口不包含推理生成时间，而 output 含推理 token，扣减 ttft 会使速率虚高数倍（实测 408 vs 端到端 65 tok/s）。这类记录退回整段 `durationMs`，与 reconstructed 口径一致。无合格样本时 `tokPerSec = null`，统计栏省略 TPS；`tokPerSecSamples` 提供样本数。工具文本不用于估算 output token，工具嵌套 usage 单独计入总量。

### 3.7 历史会话回放（session-loader.ts）

Web 端扫描 `~/.pi/agent/sessions/**/*.jsonl`，live 时序保留在内存中，不写 sidecar。

- assistant 的时长估计为 `entry.timestamp − message.timestamp`：前者为持久化时刻，后者通常为 provider 创建响应对象的时刻。此口径覆盖最后一条回复，但可能包含队列、扩展处理等开销，不等于精确解码时间。
- tool 按 `toolCallId` 关联发起调用的 assistant。窗口起点为该 assistant 的持久化时刻，终点为 `toolResult.timestamp`，不借用其他 assistant 的时间。
- 缺失、倒序或无效的时间戳不生成时长；不再用相邻记录间隔兜底。零时长保留，但不计入 TPS。
- `completed` 与 `durationMs` 分离：历史记录即使时长未知，也不显示为正在生成。
- TTFT 不可从历史记录恢复；精度标记为 `reconstructed`。

> JSONL 不记录逐工具的执行起点，派发到返回的窗口可能包含排队、审批、串行等待或批次收尾开销。并集避免重复计时，但仍是估计值；更精确的执行时序需要 live 的 `tool_execution_start/end` 事件。

### 3.8 HTTP / SSE API（server.ts）

| 路由 | 说明 |
|---|---|
| `GET /` 及静态资源 | 前端文件（从扩展目录 serve） |
| `GET /api/sessions` | 会话列表（含 cwd/时间/turn 数/精度） |
| `GET /api/session/{id}` | 全量 TraceSession |
| `GET /api/events?session={id}` | SSE：`hello`（全量快照）→ `record` / `turn` / `stats`（增量） |
| `GET /api/from-file?path=<jsonl>` | 任意 session 文件即时重建（**路径限制在 sessions 目录内**） |

- 端口：默认 `43110`，占用则向后试 10 个；实际端口写入 `~/.pi/agent/traces/.port`
- 只绑 `127.0.0.1`，无鉴权（localhost 信任模型）
- server 在首次 `session_start` 惰性启动，pi 进程生命周期内常驻

### 3.9 前端技术选型

**无构建 vanilla JS ESM**：零构建，扩展自包含、无 node_modules。甘特图用绝对定位 div，虚拟滚动手写窗口化（约 40 行）。若组件复杂度失控（预估 > 1500 行），再迁 React + esbuild 预构建。

### 3.10 TUI 形态

- **TUI widget**（`ctx.ui.setWidget("pi-trace", [...], {placement:"aboveEditor"})`）：一行统计，`turn_end` / `tool_execution_end` 时刷新：
  `✻ 5 轮 · LLM 3m09s · 工具 0.5s · 47 tok/s · 缓存 81% · $0.12`
- **命令**：
  - `/trace` → `pi.exec("open", [url])` 打开当前会话的网页
  - `/trace pick` → `ctx.ui.select` 列出历史会话，选完打开
- **全屏 TUI 轨迹**（`ctx.ui.custom()`）：暂缓。

### 3.11 安全边界

- server 仅绑 loopback；`/api/from-file` 的 path 必须 resolve 后位于 `~/.pi/agent/sessions/` 下，否则 403
- tool args/result 落 sidecar 前截断（单字段 ≤ 8KB）
- sidecar 权限 `0600`

---

## 4. 实施计划总览

| 里程碑 | 内容 | 交付物 |
|---|---|---|
| M0 骨架 | 目录、settings 加载、hello 验证 `/reload` | 可加载的空扩展 |
| M1 CC 六主题 | 6 个主题 JSON（2.2），热重载目视迭代 | 可用主题（独立交付） |
| M2 CC chrome | spinner + 标题 + turn footer（2.4/2.6） | CC 感 spinner |
| M3 CC 欢迎盒 | banner.ts（2.3） | CC 欢迎盒 |
| M4 CC 状态栏 | status-line.ts（2.5） | 完整 CC chrome |
| M5 CC 工具层 | builtins + diff + grouping（2.7） | 工具行 CC 化 |
| M6 CC 工具层完 | MCP + live preview + 命令 + Ctrl+Shift+O | 功能对齐旧扩展 |
| M7 替换验收 | 卸载 pi-claude-code-ui，全量回归 | 替换完成 |
| M8 trace 核心 | model + collector + sidecar + server + 最小 Web | 能看实时流水账 |
| M9 trace 甘特 | 4 泳道甘特、统计栏、历史回放、搜索 | 对齐 dsh 体验 |
| M10 trace TUI | widget 统计行、`/trace` 命令 | 完整形态 |

M1 与 M8+ 无依赖，可并行。
