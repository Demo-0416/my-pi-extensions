# better-claude-code-ui — 实现说明

Claude Code 完整视觉身份的 pi 扩展：6 套主题 + chrome（欢迎盒/spinner/状态栏/turn footer）+ 工具渲染层。

## 目录结构

```
better-claude-code-ui/
├── package.json                 # deps: diff, @shikijs/cli; pi.extensions/themes 声明
├── theme/                       # 层 1：6 套 CC 主题（M1）
│   ├── claude-code-dark.json
│   ├── claude-code-light.json
│   ├── claude-code-dark-daltonized.json
│   ├── claude-code-light-daltonized.json
│   ├── claude-code-dark-ansi.json
│   └── claude-code-light-ansi.json
└── extension/
    ├── index.ts                 # 入口：装配所有模块 + thinking ∴ 标记
    ├── palette.ts               # CC 六色板 + 主题名查表 + SGR 纪律
    ├── spinner.ts               # 层 2b：CC spinner（M2）
    ├── turn-footer.ts           # 层 2d：✻ Worked for Ns（M2）
    ├── banner.ts                # 层 2a：欢迎盒（M3）
    ├── status-line.ts           # 层 2c：状态栏（M4）
    ├── commands.ts              # /cc-tools /cc-theme /cc-spinner + Ctrl+Shift+O
    └── tools/                   # 层 3：工具渲染（M5+M6）
        ├── collapse.ts          # 折叠组分类 + 摘要措辞（移植 dsh-tui）
        ├── diff.ts              # shiki diff + stat bar + hunk 折叠 + 词级高亮（移植 dsh-tui）
        ├── grouping.ts          # 事件驱动分组追踪 + 折叠摘要 + 分支线 + 状态点
        ├── builtins.ts          # read/bash/grep/find/ls/edit/write renderCall/Result
        └── mcp.ts               # MCP 工具 hidden/summary/preview 三模式
```

## 已实现

### 层 1：6 套主题（M1）
- 6 个 JSON 全部通过 pi `loadThemeFromPath` schema 验证（51 个必填 color token）。
- 色值严格照 DESIGN.md 2.2 节六色板总表，来源 `claude-code-main/src/utils/theme.ts` 的 darkTheme/lightTheme/darkDaltonizedTheme/lightDaltonizedTheme/darkAnsiTheme/lightAnsiTheme。
- ANSI 两套用 0-15 整数索引（pi 主题原生支持）。
- 工具盒三色合一：`toolPendingBg/toolSuccessBg/toolErrorBg` 都映射 `bashMsgBg`。
- thinking 级别边框按 CC 模式色语义映射（plan→teal、permission→蓝紫、auto-accept→紫、最高→粉）。

### 层 2：chrome
- **spinner.ts**：帧序列 `['·','✢','✳','✶','✻','✽']` 正放+倒放，170ms 间隔；~190 个趣味动词全量搬自 `spinnerVerbs.ts`；每 turn 采样一次不重采；Ghostty 特例（`TERM=xterm-ghostty` 末帧 `*`）；`ctx.ui.setWorkingIndicator` + `setWorkingMessage`，无 Loader 原型补丁；终端标题 `✻ <cwd>`。
- **turn-footer.ts**：`✻ Worked for Ns`，dim 色，仅 turn > 30s 显示；`appendEntry` + `registerEntryRenderer` 持久化；过去式动词表 + `formatTurnDuration` 搬自 dsh-tui。
- **banner.ts**：移植 dsh-tui `HeaderComponent`（三档宽度响应：≥76 双栏 / 40-75 徽章盒 / <40 纯栈）；品牌换成 pi ✻（`pi ✻` wordmark + ✻ 像素标）；身份行 model/cwd/resumed。
- **status-line.ts**：`ctx.ui.setFooter`，字段 model/cwd/git branch/context%/cost；branch 用 `footerData.getGitBranch()`；context 超 90% 变 warning 色；cost 累加 `message_end` 的 `usage.cost.total`。

### 层 3：工具渲染
- **palette.ts**：CC 六色板按活动主题名查表（`claude-code-*` 前缀），未知主题回退 pi token 派生；SGR 纪律（fg 关 39、bg 关 49，不用裸 ESC[0m）。
- **tools/collapse.ts**：移植 dsh-tui `core/collapse.ts` 的 shell 命令分类（search/read/list）、MCP 查询检测、`collapsedSummary`（时态/单复数一致、thinking <1s 不显示、行尾 `(ctrl+o to expand)`）。
- **tools/diff.ts**：移植 dsh-tui `render/diff.ts`：unified + split 双布局、词级高亮、stat bar、hunk 折叠（`sep` 行）、shiki 集成（`@shikijs/cli` 可选依赖，缺失时降级纯文本）。
- **tools/grouping.ts**：事件驱动分组追踪（`tool_execution_start/end` + `message_update` thinking 归因）；折叠组 = 一个 turn 内连续 ≥2 个只读调用 + 紧邻 thinking；leader 渲染整组（折叠摘要行 / 展开 glance 行），非 leader 成员渲染 0 行（`renderShell:"self"` + 空内容）；分支线 bare 形态 `├ └ │`；pending 状态点闪烁（500ms 全局 blink 定时器）。
- **tools/builtins.ts**：read/bash/grep/find/ls/edit/write 的 `renderCall`/`renderResult`，execute 委托 pi 内置工厂；edit/write 带 diff 预览（parseDiff + renderUnified/Split）；分组感知（非 leader 隐藏）。
- **tools/mcp.ts**：`mcp__*` 工具包装，hidden/summary/preview 三模式。
- **commands.ts**：`/cc-tools`（group/detail/mcp 子命令）、`/cc-theme`、`/cc-spinner`；`Ctrl+Shift+O` 额外详情档（预览上限 8→4000 行）。
- **thinking ∴ 标记**：`registerMarkdownTransformer` 给 assistant-thinking 块加 `∴ ` 前缀。

## 未实现 / v2

| 项 | 原因 |
|---|---|
| 欢迎盒 sweep reveal（左到右扫入） | DESIGN 标注 v2；`setRevealWidth` 已预留 |
| spinner 停滞动画（超时向错误色插值） | DESIGN 标注 v2 |
| 文件类型 Nerd Font 图标 | 旧扩展有，本版用纯文本标签 |
| RTK 集成（rewrite 通知折进 bash 行 + (RTK) 徽章） | 旧扩展有，本版未搬 |
| subagent 完成通知重样式 | 旧扩展有，本版未搬 |
| apply_patch 预览 | 旧扩展有，本版未搬 |
| 工具背景模式 default/transparent/border 配置 | 本版固定 transparent（分组工具）+ theme bg（edit/write） |
| Ctrl+O 三态循环（折叠→预览→完整） | pi 内置 Ctrl+O 是二态 toggle；本版 collapsed↔preview 用 Ctrl+O，full 用 Ctrl+Shift+O |

## 与 DESIGN.md 2.7 对照表

| 功能 | 状态 | 说明 |
|---|---|---|
| 内置工具紧凑渲染 | ✅ | read/bash/grep/find/ls/edit/write renderCall/Result |
| edit/write diff | ✅ | shiki 高亮 + unified/split + 词级 + stat bar + hunk 折叠 |
| 连续工具分组 + 分支线 | ✅ | 分组头 + glance 行 + bare `├ └ │` |
| 状态点 | ✅ | pending 闪烁 ●、成功绿/失败红 |
| 折叠组摘要（thinking+工具） | ✅ | collapsedSummary，时态随状态，(ctrl+o to expand) |
| MCP 三模式 | ✅ | hidden/summary/preview |
| 运行中实时预览 | ✅ | bash partial 时显示最新 N 行 |
| thinking ∴ 标记 | ✅ | registerMarkdownTransformer |
| 命令 | ✅ | /cc-tools /cc-theme /cc-spinner |
| Ctrl+Shift+O 详情档 | ✅ | 8→4000 行 |
| 主题自适应 | ✅ | 按主题名查 palette，未知回退 token 派生 |
| 文件类型图标 | ❌ | 未搬 |
| RTK 集成 | ❌ | 未搬 |
| subagent 通知 | ❌ | 未搬 |
| apply_patch 预览 | ❌ | 未搬 |
| 工具背景模式配置 | ❌ | 固定 transparent |

## 测试方法

### 加载扩展 + 主题（禁用其他扩展）

```bash
pi -ne \
  -e /Users/bytedance/wailmer/workspaces/pi_extension/cc-ui-impl/better-claude-code-ui/extension/index.ts \
  --theme /Users/bytedance/wailmer/workspaces/pi_extension/cc-ui-impl/better-claude-code-ui/theme \
  --use-theme claude-code-dark
```

- `-ne`：禁用扩展发现（不加载已装的 pi-claude-code-ui），只加载 `-e` 指定的本扩展
- `--theme`：加载本扩展的 6 套主题目录
- `--use-theme claude-code-dark`：指定主题；换 light 用 `claude-code-light`，自动明暗用 `claude-code-light/claude-code-dark`

### 目视验证清单

1. **欢迎盒**：启动后顶部应见 pi ✻ 徽章盒（≥76 列双栏带 [Skills] 区，40-75 列单栏，<40 列纯栈）
2. **spinner**：发一条消息，流式时应见 `· ✢ ✳ ✶ ✻ ✽` 正放+倒放 + 趣味动词（Cooking…/Brewing…）
3. **状态栏**：底部应见 `model · ~/cwd · ⎇ branch · ctx N% · $0.00`
4. **turn footer**：跑一个 >30s 的 turn，结束后应见 dim 色 `✻ Worked for Ns`
5. **工具渲染**：让模型读 2+ 个文件 → 应折叠成一行 `● Thought for Xs, read 2 files (ctrl+o to expand)`；Ctrl+O 展开见 glance 行 + 分支线
6. **diff**：让模型 edit/write 一个文件 → 应见 stat bar `+N -M [━━━]` + 行底色 + 词级高亮
7. **命令**：`/cc-tools status`、`/cc-theme`、`/cc-spinner` 应正常响应
8. **Ctrl+Shift+O**：展开工具后按 → 预览行数从 8 增到 4000

### 主题热重载

编辑 `theme/claude-code-dark.json` 后 pi 自动热重载，可即时目视迭代。

### 类型检查

```bash
cd better-claude-code-ui && npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck extension/index.ts
```

### 替换验收（M7，用户操作）

1. 从 `~/.pi/settings.json` 的 `packages` 移除 `npm:pi-claude-code-ui`
2. `extensions` 加入本扩展路径，`themes` 加入 theme 目录
3. `/reload`
4. 全量回归对照 2.7 表
