# CC 对齐规格（代码级对齐 claude-code-main）

> 本文是重写的唯一规格书。每个模块给出：CC 源码事实（ground truth）、pi API 支点、改动清单。
> 参考源码：`/Users/bytedance/ai_coding/my_agents/claude-code-main`（下称 CC）
> pi API：`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`

## 0. 总原则

1. **CC 正常模式下 thinking 块在消息流里完全不渲染**——唯一指示是 spinner 状态行的 `(thinking)` shimmer + 完成后 dim 的 "thought for Xs"（CC `Spinner/SpinnerAnimationRow.tsx:172`、`Spinner.tsx:136`）。transcript 模式（Ctrl+O）才内联展开 `∴ Thinking…` + dim 正文（`messages/AssistantThinkingMessage.tsx:62-69`）。
2. **工具卡无背景无边框**：CC 工具行就是 `⏺ Tool(detail)` 纯文本行（`messages/AssistantToolUseMessage.tsx:186-285`）。pi 侧用 `renderShell: "self"` 去掉 Box 外壳（types.d.ts:360）。
3. **thinking 文字一律 dim 灰**（CC `theme.inactive` rgb(102,102,102)），不用紫色。
4. 字形：macOS 用 `⏺`（BLACK_CIRCLE 实际是 U+23FA? 不——CC figures.ts: darwin=`⏺` U+23FA，其他=`●`）；thinking 折叠/展开标题用 `∴`；redacted thinking 用 `✻`；turn footer 用 `✻`；用户消息指针 `❯`；工具结果引导 `⎿`。
5. 只改显示：transformer/工具渲染都是 display-only，不污染 session/LLM 上下文。禁用 `message_end` 返回替换消息（会落盘）。

## 1. thinking.ts（新建，最优先）

**CC 事实**：
- 折叠态：`∴ Thinking` dim italic + `(ctrl+o to expand)`（`AssistantThinkingMessage.tsx:44`）——但正常模式不可达（父组件直接 return null，`Message.tsx:541`）。
- 展开态：`∴ Thinking…` dim italic 标题 + 空行 + `paddingLeft=2` 的 dimColor markdown 正文（`AssistantThinkingMessage.tsx:62-69`）。
- 流式：正常模式不渲染 thinking 块；spinner 行 `(thinking)` shimmer（rgb(153,153,153)↔(185,185,185) 正弦，3s 延迟 2s 周期，`SpinnerAnimationRow.tsx:198`）；结束后 dim "thought for Xs"（≥2s，`Spinner.tsx:136`）。
- redacted：`✻ Thinking…` dim italic（`AssistantRedactedThinkingMessage.tsx:16`）。

**pi 支点**：
- `registerMarkdownTransformer((md, {messageType, isStreaming, availableWidth}) => string)`，messageType 含 `"assistant-thinking"`（types.d.ts:841-846）。
- `ctx.ui.setHiddenThinkingLabel(label?)`（types.d.ts:94-95，默认 "Thinking..."）。
- `message_update` / `message_end` 事件追踪 thinking 时长（thinking delta 流）。
- `ctx.ui.setWorkingMessage(msg?)` 改 spinner 行文案。

**实现**：
1. `registerMarkdownTransformer`：messageType!=="assistant-thinking" 直接返回。否则：
   - 输出 = `∴ Thinking…` 标题行（ANSI：dim + italic，颜色用 palette `inactive`）+ `\n\n` + 原文。
   - **禁止**把 `∴` 拼在正文第一行行首（会破坏 markdown 语法，现状 bug）。
   - 不做正文缩进（pi markdown 会把行首空格当代码块/续行，不安全）。
   - isStreaming=true 时标题保持 `∴ Thinking…`；false 时不变（时长放活动行，不放标题——transformer 无 block 身份）。
2. thinking 时长追踪：`message_update` 里检测 thinking delta 开始/结束（pi 事件 payload 里 content block type），模块级 Map 记每消息的 thinkingMs；`message_end` 结算。
3. `setHiddenThinkingLabel`：session_start 设 `∴ Thinking`；每次 thinking 块结束后更新为 `∴ Thought for ${formatDuration(ms)}`（全局标签显示最近一块的时长——pi 标签是全局的，做不到 per-block，这是 API 上限）。
4. spinner 联动：thinking 块开始 → `setWorkingMessage("(thinking)")`（dim 灰）；结束 → 恢复动词文案（与 spinner.ts 协作，导出一个 hook 或由 thinking.ts 直接管 working message）。
5. redacted thinking：pi 侧无独立 messageType，跳过（不可达）。

**格式函数**：`formatDuration(ms)`：`<60s` → `Ns`；`<1h` → `Mm Ss`；否则 `Hh Mm Ss`（搬 turn-footer.ts 现成的）。

## 2. tools/builtins.ts（重写）

**CC 事实**：
- call 行四段：`[dot][bold 工具名][(detail)][tag]`（`AssistantToolUseMessage.tsx:186-285`）。dot 状态机：进行中=闪烁 dim ⏺、成功=success 绿 ⏺、失败=error 红 ⏺、queued=dim 静态 ⏺（`ToolUseLoader.tsx:19-33`）。
- 工具名映射（userFacingName）：Grep/Glob→`Search`、WebFetch→`Fetch`、WebSearch→`Web Search`、NotebookEdit→`Edit Notebook`、TodoWrite→`""`（不渲染）。
- Bash（`tools/BashTool/UI.tsx:26-173`、`BashToolResultMessage.tsx:100-169`）：detail=命令截断 2 行/160 字符；result：stdout 默认色、stderr error 红、无输出 dim `Done`、cwd reset dim；exit≠0 靠 stderr 红。
- Edit/Write（`FileEditToolUpdatedMessage.tsx:32-110`）：stat 行 `Added N lines, Removed M lines`（数字 bold）+ dashed subtle 上下边框 diff 框。
- Read/Grep/Glob：折叠态一行 `Read N lines` / `Found N files`（数字 bold）。
- Agent：`Done (N tool uses · M tokens · duration)` + Ctrl+O 展开。

**pi 支点**：`registerTool({name, renderShell: "self", renderCall, renderResult, execute 委托 SDK 工厂})`；`ToolRenderContext`：`{args, toolCallId, invalidate(), lastComponent, state, executionStarted, argsComplete, isPartial, expanded, isError}`（types.d.ts:315-340）。

**实现**：
1. 所有覆盖工具 `renderShell: "self"`，execute 委托 `createBashTool(cwd)` 等 SDK 工厂（参考官方示例 `examples/extensions/built-in-tool-renderer.ts`）。
2. call 行：`⏺ ` + bold(显示名) + `(` + detail + `)`；detail 模板：
   - bash：命令（截断 2 行/160 字符）
   - read：文件路径
   - edit/write：文件路径
   - grep：pattern（`"pattern"`）
   - glob：pattern
   - find：路径
   - ls：路径
3. result 第一行前缀 `⎿ `（dim），续行缩进对齐到 `⎿ ` 后（dsh-tui RESULT_INDENT）。
4. bash result：stdout 默认色；有 stderr 时 stderr 行 error 红；无输出 dim `Done`；exit≠0 时首行 `⎿ ` 改 error 色 + exit code。
5. read/grep/glob 折叠态：`⎿ Read N lines` / `⎿ Found N files`（数字 bold）；expanded 才出预览。
6. edit/write：stat 行 `⎿ Added N lines, Removed M lines`（数字 bold）+ diff（diff.ts 出品）。
7. live preview（bash 运行中）：tail N 行 + header 尾随 `(N lines)` 实时行数 + `... (N earlier lines)` 前缀（旧 ext 机制）；partial 进入时重新武装 blink；完成后折叠态保留 tail。
8. 渲染缓存：key = `${toolCallId}:${width}:${expanded}:${isPartial}`，值 = {lines}，避免每帧重包（dsh-tui CachedCardComponent 模式）。
9. 修 bug：`writeExistedBefore` 在 renderResult 错误分支也要 delete（builtins.ts:451）。
10. 修 bug：diff 宽度从 render 上下文取（pi render 回调有 width 参数），不要硬编码 100。

## 3. tools/diff.ts（增强）

**CC 事实**（`FileEditToolDiff.tsx:81-105`、`StructuredDiff/Fallback.tsx:80-417`）：
- stat 行 `Added N lines, Removed M lines`（数字 bold）。
- diff 外框：dashed subtle 上下边框（无左右框）。
- 行底色 diffAdded/diffRemoved；词级 diffAddedWord/diffRemovedWord（changeRatio<0.4 才用词级，否则整行 dim）。
- gutter = 行号 + sigil（`+`/`-`/` `）；hunk 之间 dim `...` 分隔。
- Write 新建文件：前 10 行 HighlightedCode + `… +N lines Ctrl+O`。

**实现**：
1. 保留现有 shiki + 词级 + unified/split 自适应骨架（831 行已验证）。
2. 加 stat 行（数字 bold）。
3. 加 dashed 上下边框（dim 色，`╌` 或 `─` 虚线——用 `╌`）。
4. hunk 间 dim `...` 行。
5. shiki 主题按 palette.scheme 自动切 `github-dark`/`github-light`（修 diff.ts:355 硬编码）。
6. 宽度参数化（调用方传入 availableWidth）。

## 4. tools/grouping.ts（增强）+ collapse.ts + mcp.ts

**CC 事实**（活动摘要行，用户截图）：
```
Thought for 4m 36s, searched for 2 patterns, read 1 file, listed 6 directories (ctrl+o to expand)
  ⎿  13 skills available
```
- 连续工具活动压缩成一行：动词 + 数量，时态/单复数正确。
- `(ctrl+o to expand)` 提示。
- `⎿` 子行挂系统消息/详情。
- CC 分组树字符（AgentProgressLine）：`├─` `└─` `│` `⏿`。

**实现**：
1. 保留现有事件驱动分组骨架（leader 渲染整组、非 leader 0 行）。
2. 摘要动词表对齐 CC（见 §10 补充侦察结果，待填）：read→`read N files`、grep→`searched for N patterns`、ls→`listed N directories`、edit/write→`edited N files`、bash→`ran N commands`、thinking→`Thought for X`（放最前）。
3. 折叠行格式：`⏺ ` + 摘要（dim）+ ` (ctrl+o to expand)`（dim italic）。
4. blink 看门狗四件套（旧 ext）：15s stale 泄漏回收、agent 心跳保活、executionStarted 门控（历史 isPartial 不闪）、MAX 5 并发。
5. 修死开关：`/cc-tools group off` 要真正生效（import commands 的状态或读 settings）。
6. 模块级单例（tools/groups/turnToolOrder）加 session 隔离或接受现状（pi 单 session，注释说明）。
7. mcp.ts：label 改 bold 默认色（去 toolTitle 橙）、状态点改 `⏺`（darwin）与内置统一。

**对抗式验收修复（2026-08-18，grouping 模块）**：
- settled 组即使有成员报错也不显示错误点（CC `CollapsedReadSearchContent.tsx:450` settled 渲染 `<Box minWidth={2}/>`，2 空格无 glyph）；active 组的错误点改 dim+error（`dim(fg(palette.cc.error, ⏺))`），静态不闪——已 resolve 的错误显示状态而非 pending blink。
- 摘要计数全部 bold（CC `<Bold>` 包每个 count）；`collapsedSummary` 加 `styleCount` 回调，bold 的 `22m` 只复位强度属性，不影响 settled 行的 dim 前景色（`38;2`），可安全嵌套。
- bash hint：命令首行 `# comment` 时显示注释文本（去 `#`，无 `$ ` 前缀），CC BashTool 用人话标签而非原命令；分类前 `stripLeadingComments` 剥离前导注释行，否则 `#` 首词让分类器 bail。
- 多行 hint 续行缩进到列 5（2 lead + `⎿` + 2 gap），不再列 0 参差。

## 5. banner.ts（改）

**CC 事实**（`components/LogoV2/`）：三形态——CondensedLogo 单行 / Compact 窄屏盒 / Horizontal 宽屏双栏盒；圆角边框 claude 橙 rgb(215,119,87)。
**实现**：
1. 补第三档：40<=width<76 用 boxed 档（dsh-tui transcript.ts:642-667 renderBoxed，常量 MIN_BOXED_WIDTH=40/FULL_MIN_WIDTH=76）。
2. 修死字段：resumed（resume/fork 的 session id 前 8 位）渲染进顶栏（CC resume 时显示），或删除。
3. 品牌保持 pi ✻ 身份，CC 形状。

## 6. spinner.ts（改）

**CC 事实**：6 帧 ping-pong 12 帧、**120ms/帧**（现 170ms，改）、186 动词（已全）、3s 无新 token 渐变红（v2，做简单版：stalled 时帧色插值到 error 色）。
**实现**：
1. INTERVAL_MS 改 120。
2. thinking 阶段文案交给 thinking.ts 管（spinner.ts 导出 verb 访问器或 thinking.ts 直接 setWorkingMessage）。
3. stalled 简单版：记录最后活动时间，3s 无活动把帧色从 accent 插值到 error（每帧重设 setWorkingIndicator）。

## 7. status-line.ts（改）+ turn-footer.ts（保留）

- status-line：字段 model/cwd/git/context%/cost 保持；加会话总计时间 + turn 数（旧 ext `Total time · N turns` 语义）。
- turn-footer：已对齐（`✻ Verb for Xs`，30s 阈值，8 动词），不动。

## 8. commands.ts（改）+ prompt-editor.ts（删除或接线）

1. `/cc-tools group off` 死开关修复（§4.5）。
2. Ctrl+Shift+O 详情档持久化到 ~/.pi/settings.json（旧 ext writeSettingsKey 模式），档位 4000→12000。
3. prompt-editor.ts：无人 import 且 `this.borderColor` 可能 TypeError。pi 无公共编辑器替换 API → **删除**。

## 9. theme JSON（小改）

- 6 套主题保持六色板（已验证）。
- `toolPendingBg/toolSuccessBg/toolErrorBg`：我们自己的工具走 renderShell:"self" 不受影响；保留 bashMsgBg 映射给未覆盖工具。
- thinking 等级色（thinkingLow..Max）保留 pi 特性。

## 10. 活动摘要动词（CC `CollapsedReadSearchContent.tsx:345-413`）

| 工具 | 进行时 | 完成时 | 单数 | 复数 |
|---|---|---|---|---|
| search (grep/glob) | Searching for | Searched for | pattern | patterns |
| read | Reading | Read | file | files |
| list (ls/find) | Listing | Listed | directory | directories |
| bash | Running | Ran | bash command | bash commands |
| mcp | Querying | Queried | (server label) | + `N times` |

规则：第一个 fragment 首字母大写，后续小写；活跃态 glyph=闪烁 ⏺ 默认色，**settled 态无 glyph（2 空格占位）+ dimColor**（现实现若 settled 也画 glyph 要改）；错误态红 ⏺；活跃时尾部 `…` + `(ctrl+o to expand)`。
进行时 hint 行：`  ⎿  ` + 最近一次操作的路径/pattern/命令，最少显示 700ms。
hook 摘要行：`  ⎿  Ran N PreToolUse hooks (Xs)`。
thinking 时长前缀 `Thought for Xm Ys`：CC 新版才有，本扩展已实现（collapse.ts:333-337），保留。
git 操作动词（committed/pushed/merged）：CC 仅 fullscreen 模式计入，pi 无 fullscreen 概念，**不做**。

## 11. `⎿` 系统响应行（CC `MessageResponse.tsx`）

CC：`paddingLeft=2` + `⎿  `（⎿ + 2 空格）+ dimColor，用于附件/hook 错误/命令回显/升级提示/活动 hint。
pi 侧：扩展自产的系统行（如 hook 摘要、turn 统计）用 `appendEntry("cc-response", {text})` + `registerEntryRenderer` 输出 `  ⎿  {text}`（dim）。pi 自渲染的系统消息（"N skills available"）无钩子，**不做**。

## 12. 中途用户消息

pi 原生 `sendUserMessage(text, {deliverAs:"followUp"})` 已支持排队到当前 turn 结束；样式 pi 自渲染不可控。**验证原生行为即可，不做定制**。

## 13. 明确不做（pi API 上限）

- CC transcript/normal 双模式（pi 无此概念，hideThinkingBlock 全局开关替代）。
- per-block thinking 折叠 toggle（pi 全局开关）。
- 消息 bullet/gutter 列对齐（pi 自渲染消息，扩展不可控）。
- 中途用户消息内联样式（pi 自渲染）。
- `⎿ 13 skills available` 这类系统消息的重样式（pi 自渲染系统消息，无钩子）。
- thinking 正文 2 列缩进（pi markdown 行首空格不安全）。
- spinner shimmer 正弦波（pi 帧是静态字符串数组，用 dim 文案替代）。
- 分组的 turn 作用域：分组是 turn 级骨架，展开上一 turn 的组会把它解除折叠（CC 按 message 持久化折叠态，pi 无对应 API）。接受现状。
