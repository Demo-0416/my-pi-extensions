# better-claude-code-ui 对账

对 `pi_extension/better-claude-code-ui` 的一次完整审计：既比对它与 Claude Code 的视觉/交互差距，也查它自身的实现缺陷。

- **审计对象**：`extension/`（13 个 TS 文件，4493 行）+ `theme/`（6 套主题）
- **对照基准**：`claude-code-main/src`（Claude Code 2026-03 源码快照，React + Ink）
- **能力边界**：`@earendil-works/pi-coding-agent` 的扩展 API 与运行时
- **方法**：4 条并行工作流，34 个独立视角取证 → 对抗式反驳 → 按 `file:line` 聚类去重；OOM 部分附实测脚本数据
- **产出**：167 条原始发现 → **72 条唯一缺陷**；**126 项** 与 CC 的差距；**1 个已定罪的 OOM 根因**
- **原始数据**：`scratchpad/cc-ui-audit-raw.json`（973KB）、`scratchpad/clusters.json`

> 一条重要提醒：`ALIGNMENT.md` 和 `IMPLEMENTATION.md` 里有若干**事实性错误**（见第 3 节）。它们不能再当作规格来用，需要先修文档再改代码。

---

## 1 · 结论

| | 数量 |
|---|---|
| P0（崩溃 / 卡死 / 内存） | 4 |
| P1（用户一眼可见） | 16 |
| P2 | 33 |
| P3 | 23 |
| 与 CC 的差距 | 126（跨 10 个维度） |

三件事按这个顺序做：

1. **止血**（P0 四条）—— 其中一条会在一个会话里的**第一次 edit/write** 就锁死整个 TUI 并在 73 秒内吃满 4GB 堆。不修这条，其它都白搭。
2. **清理死代码**（第 4 节六条）—— `IMPLEMENTATION.md` 记为 ✅ 但从未生效的功能。先让已写的代码真的跑起来，收益远大于新写。
3. **修正规格**（第 3 节）—— 三处被写错的前提，其中一条让整个 `thinking.ts` 建在错误方向上。

---

## 2 · P0：会崩、会卡死、会烧内存的四条

### P0-1 · `diff.ts:466` + `palette.ts:167` — 同步死循环，OOM 的元凶

**现象**：pi 卡死；或者 73 秒内 `FATAL ERROR: Ineffective mark-compacts near heap limit`，堆 4GB 耗尽。

**机制**：`setDiffPalette` 一边遍历 `highlightCache.keys()`，一边对每个 key 调 `warmHighlightCache`。后者虽是 `async`，但**缓存命中分支在第一个 `await` 之前**（`diff.ts:439-440`）就同步执行了 `touchCache` → `delete(key)` + `set(key)`。按 JS Map 规范，删除后重新插入会把该 key 挪到迭代序末尾，迭代器于是**再次访问它** —— 循环永不结束。

本该挡住这一切的守卫是 `diff.ts:460` 的 `if (p === activeSgrPalette) return`，但 `resolvePalette`（`palette.ts:167`）每次返回**新的对象字面量**，引用相等恒假。

**实测**（工作流写脚本量化）：83,340 圈/秒，2.6 GB/s 垃圾，96 字节/圈净留存（永远排不上队的 microtask reaction job）。73 秒 ≈ 583MB 留存叠加垃圾洪流 → 打满 4GB。

**触发路径**：会话里第一个 edit/write 的结果渲染。第 1 次 `renderResult` 时缓存为空、循环空转；`warmHighlightCache` 落盘一条缓存（即使 `@shikijs/cli` import 失败，`diff.ts:452` 的 catch 里照样 `touchCache`）→ 它的 `.then` 里 `c.invalidate()` 同步重跑 `renderResult` → 第 2 次 `setDiffPalette` 时缓存已有 1 条 → 死循环。Go 项目必中：`.go` 在 `EXTENSION_LANGUAGES`（`diff.ts:383`）里有映射。

**修法**：两处都要改。
1. `setDiffPalette` 先 `const keys = [...highlightCache.keys()]` 快照再遍历。
2. 守卫改成值比较（比 `paletteKey` 或 `scheme` 字段），或让 `resolvePalette` 对同一主题名返回同一实例（memo）。

---

### P0-2 · `builtins.ts:745` — write 新文件的 invalidate 乒乓

**机制**：

```ts
c.state._wwk = key;
void warmHighlightCache(...).then(() => {
    if (c.state._wwk !== key) return;   // key 不变 → 守卫永远放行
    c.invalidate();
});
```

`c.invalidate()` → `tool-execution.js:182-184` → `updateDisplay()` → `tool-execution.js:257` 重新调用 `renderResult` → 又挂一个 `.then` → 微任务 → 无限。每轮开销 O(文件大小)：`parseDiff`（`:724` 在分支判断之前**无条件**执行）+ `content.split("\n")` + 一次 32KB 键的 `Map.get` flatten。

`edit`（`:840-844`）和 write 改已有文件（`:769-773`）都有 `last instanceof DiffCardComponent && last.diffKey === key` 的组件身份检查提前 return，不受影响。只有写新文件这条走 `cachedText()`，没有保护。

**修法**：把「是否已预热过」记进 state，而不是比 key：

```ts
// 只在本组件尚未为这个 key 预热过时才挂重绘回调 —— 否则 .then 里的
// invalidate 会重跑 renderResult，再挂一个 .then，形成微任务自激循环。
if (c.state._wwk !== key) {
	c.state._wwk = key;
	void warmHighlightCache(shown.join("\n"), lang, shikiThemeForPalette(palette)).then(() => {
		if (c.state._wwk !== key) return;
		c.invalidate();
	});
}
```

---

### P0-3 · `builtins.ts:691` — 无上限 `readFileSync`

这是扩展**唯一**真正绕过 pi 输出保护的地方。pi 在 `core/tools/truncate.js:10` 把 bash stdout 砍到 50KB / 2000 行（实测喂 51MB stdout 只吃 25MB 堆），但 `write` 的旧内容快照直接 `readFileSync` 整份文件，无上限。一个 20MB 的 `kitex_gen` `.go` 文件 = 至少 20MB 常驻，外加 `parseDiff` 对大文件超线性的中间态。

而且同一份旧内容会被存**三份**：`writeOldContent.get` + `DiffCardComponent` build 闭包捕获的 `old` + `diff.lines` 里 del 行的 content。

**修法**：读之前先 `statSync` 判大小，超过阈值（建议 1MB）直接跳过 diff、退化成 `Wrote N lines`。同时 `writeOldContent` 在 `tool_execution_end` 后清，别留到 `session_start`（`:670`）。

---

### P0-4 · `builtins.ts:750` / `:270` — `cachedText` 类型崩溃

write 新文件的结果行 Ctrl+O 展开（变成 `DiffCardComponent`）再收起时，`cachedText` 对它无检查地调 `setText` → `TypeError: setText is not a function`，结果行退化成 pi 兜底原文。

**修法**：`cachedText` / `makeText` 加 `instanceof` 检查，类型不符就新建组件。

---

**已排除的嫌疑**（有实测数据）：

- bash 巨量输出 —— pi 层已截断到 50KB/2000 行，全速压测 73 秒峰值只到 142MB。
  —— 补充（后来的发现）：峰值安全取决于输出的**形状**而不只是大小。同样 50KB，
  2000 短行只渲染 9 行；2 个 minified 长行（`grep -rn` 打到 bundle）渲染 654 行、
  heapΔ 27.9MB。因为旧预览预算数的是逻辑行。已按 CC `terminal.ts:71` 改成视觉行
  预算 + 折行前预截断（见 §6 P1 已修条目）。
- `renderShell: "self"` 绕过 pi 截断 —— 它只是外框样式开关，不改数据流。
- pi 裸跑 OOM —— pi 默认 bash 渲染器比扩展重 70 倍，两者都内存稳定。

**pi 侧的结构性隐患**（不是本次元凶，也**够不着**，别照这条去提 issue）：`pi-tui/dist/utils.js:869` 的 `breakLongWord` 为超长行的**每个字符**物化一个 `{type,value}` 对象，实测 100~130 字节堆/输入字符 —— 理论上约 30MB 的单行就能打满 4GB。`utils.js:245` 的 `widthCache` 只限 512 条不限字节。

但**触发不了**：pi 的工具层把 bash stdout 卡在 50KB（`core/tools/truncate.js:10-11`），要递 30MB 单行进去没有路径。实测 50KB 单行走 pi 自己的 `truncateToVisualLines` 是 9ms / 内部折 500 个视觉行（只显示最后 5 行）—— 浪费但可控。除非哪天发现一条不设上限的内容路径，否则这条不构成 pi 的 bug。

---

## 3 · 规格里的三处事实性错误

改代码之前先改文档，否则会照着错的规格继续写。

### 3-1 · `ALIGNMENT.md §0.1` / `§1` — CC 普通模式的 thinking 前提写反了

文档写的是：

> CC 正常模式下 thinking 块在消息流里完全不渲染 —— 唯一指示是 spinner 状态行的 `(thinking)` shimmer

**实际**：`Message.tsx:449-463` 里 `case 'thinking'` 渲染 `AssistantThinkingMessage`，`hideInTranscript={isTranscriptMode && !isLastThinking}`。普通模式下 `isTranscriptMode=false` → `hideInTranscript=false` → 组件渲染；而 `shouldShowFullThinking = isTranscriptMode || verbose` 也是 false → 走折叠分支，**每个 thinking 块在消息流里就地留一行** `∴ Thinking (ctrl+o to expand)`（dim + italic，`AssistantThinkingMessage.tsx:44`）。

CC 的 thinking 实际是**四层**：

| 层 | 何时 | 显示 | 源码 |
|---|---|---|---|
| 消息流（普通模式） | thinking 块存在时一直在 | 单行 `∴ Thinking (ctrl+o to expand)`，不显示内容 | `AssistantThinkingMessage.tsx:44` |
| spinner 行 | 流式中 → 结束后 2s | `thinking`（3s 延迟 / 2s 周期正弦 shimmer）→ `thought for 18s` → 清空 | `SpinnerAnimationRow.tsx:172`、`Spinner.tsx:145-147` |
| 流式面板 | **仅** transcript 模式 | 消息流最底部挂全文 thinking 面板，流完后**再留 30 秒** | `Messages.tsx:442-449, 997-1010` |
| transcript 展开 | Ctrl+O | 只展开**最后一个** thinking 块，历史块全部隐藏 | `Message.tsx:449-463`、`Messages.tsx:455-481` |

`streamingThinking` 只传给 transcript 模式的 `<Messages>`（`REPL.tsx:4402`），普通模式那棵树（`:4570`）没有。

**后果**：`thinking.ts` 把消息流那一行让给了 pi 的**全局** `hiddenThinkingLabel`（全会话一个标签、只能显示最近一块的时长），于是产出 `∴ 15s` 这种既不是折叠行、也不是 spinner 行的四不像 —— 而且写一次会把历史里所有 thinking 行同时改成同一个时长。

> 快照与线上的偏差：这份 2026-03 快照里折叠行是 `∴ Thinking (ctrl+o to expand)`，**不带时长**。线上更新版把时长并进了折叠行（`Thought for 18s (ctrl+o to expand)`），快照里查不到。

### 3-2 · pi 的 turn ≠ 一次用户请求

`pi-agent-core/dist/agent-loop.js:43-131` 的实际时序：

```
agent_start
  turn_start                      ← 第 1 轮
    message_start / update / end     assistant 消息
    tool_execution_start / end ×N    工具执行
  turn_end(message, toolResults)  ← 工具跑完之后才发
  turn_start                      ← 第 2 轮
  ...
agent_end
```

一次用户请求 = 1 个 `agent_start` + **N 个** `turn_start`/`turn_end` + 1 个 `agent_end`。

**受影响的代码**：
- `turn-footer.ts:48-59` —— 计时口径变成单轮 LLM 调用，而且页脚会插在一次请求的**中间**。CC 的口径是 `Date.now() - loadingStartTimeRef - totalPausedMsRef`（`REPL.tsx:4004`，扣掉暂停时间），条件是 `> 30000 && !aborted && !proactiveActive`，追加到消息列表末尾。应改挂 `agent_start`/`agent_end`。
- `spinner.ts:87-89` —— 每轮重采样动词，配合 `thinking.ts:106,128` 的 `setWorkingMessage` 刷新，动词会在一次请求中途乱跳。
- `grouping.ts:391-403` —— 每轮清空 `groups`，见 P1 表。

### 3-3 · `grouping.ts:425-426` 的注释写反了

> `// Do NOT clear on turn_end — a turn ends when the assistant message finishes, BEFORE its tools run.`

实际 `turn_end` 携带 `toolResults`，在工具跑完**之后**才发（`agent-loop.js:131`）。注释错误正是 3-2 那一串问题的根源。

---

## 4 · 死代码：`IMPLEMENTATION.md` 记 ✅ 但从未生效

| 位置 | 实情 |
|---|---|
| `diff.ts:444` | 代码读 `codeToAnsi`，`@shikijs/cli` 实际导出 `codeToANSI`。**语法高亮 100% 从未工作过**，一直走纯文本降级 |
| `diff.ts:646` | warm 用整份文件内容当 key，渲染时用 hunk 行拼接当 key —— 缓存永远 miss，删除侧从头到尾没被 warm 过 |
| `diff.ts:287` | stat bar `+N -M [━━━]` 整套函数没有任何调用者，对照表却记为 ✅ |
| `mcp.ts:100` | `pi.getAllTools()` 返回的 `ToolInfo` 不含 `execute`，包装循环每次 `continue` —— **MCP 三模式整层从未注册过** |
| `collapse.ts:387` / `grouping.ts:266` | `GroupInfo.thinkingSince` 从头到尾没有任何赋值点，进行时 `thinking for Xs` 分支与实时秒表都是死代码 |
| `commands.ts:71` | `ccToolsExtraDetail` 持久化了但启动时不回灌给 `builtins`，重启后开关显示 on 实际 off，第一次按 Ctrl+Shift+O 反而关掉 |

---

## 5 · 缺陷全表（72 条）

`收敛` 列 = 有多少个独立视角各自发现了这一条。×5 以上的基本可以直接动手，不必再复核。

| 收敛 | 级别 | 类别 | 位置 | 缺陷 |
|---|---|---|---|---|
| ×9 | P1 | crash | `tools/diff.ts:466` | setDiffPalette 的 re-warm 循环在遍历 Map 时删除并重插同一 key，导致主线程死循环冻结 TUI |
| ×7 | P1 | formatting | `tools/builtins.ts:368` | 展开态（ctrl+o）下分组 leader 的 glance 行被 renderCall 和 renderResult 各画一遍，整组内容重复 |
| ×7 | P1 | state-leak | `tools/grouping.ts:311` | 组每加一个成员就整体重建，thinkingMs 没被继承，≥3 个连续只读调用时 “Thought for Xs” 永远不出现 |
| ×6 | P1 | state-leak | `tools/grouping.ts:399` | turn_start 清空组状态 + Ctrl+O 全局重渲染，导致之前所有 turn 的折叠组永久炸开成散行 |
| ×6 | P1 | crash | `tools/builtins.ts:746` | write 新建文件的 renderResult 每次渲染都重新挂 warmHighlightCache().then(invalidate)，形成微任务无限重渲染，TUI 卡死 |
| ×5 | P1 | correctness | `turn-footer.ts:48` | turn footer 按 pi 的每次 LLM 调用打印，一次提问会刷出多条 `✻ Worked for Ns` |
| ×4 | P1 | layout-width | `banner.ts:375` | compact 档欢迎盒内容行比上下边框宽 2 列，右边框整体错位 |
| ×3 | P1 | correctness | `tools/mcp.ts:115` | MCP 工具会被分进折叠组，但 mcp.ts 的渲染器完全不认组，导致 MCP 当 leader 时整组消失 |
| ×3 | P1 | layout-width | `tools/diff.ts:197` | diff 换行/补白按 UTF-16 码元计宽，CJK 行既不换行又被二次加宽，实际列数翻倍撑破 diff 卡片 |
| ×3 | P1 | dead-code | `tools/builtins.ts:778` | edit 覆盖丢了 prepareArguments，模型把 edits 发成 JSON 字符串或用 oldText/newText 旧格式时直接校验失败 |
| ×3 | P1 | dead-code | `tools/mcp.ts:100` | MCP 三模式整层是死代码：pi.getAllTools() 不返回 execute，包装循环每次都 continue |
| ×2 | P1 | layout-width | `tools/builtins.ts:241` | `⎿` 结果体只对显式换行补 5 列缩进，pi-tui Text 词换行产生的续行全部掉回第 0 列 |
| ×2 | P1 | dead-code | `tools/diff.ts:646` | warm 用整份文件内容做 key，查询用 hunk 行拼接做 key，缓存永远 miss；old 侧从头到尾没被 warm 过 |
| ×2 | P1 | dead-code | `tools/diff.ts:444` | shiki 导出名写错（codeToAnsi vs codeToANSI），diff 语法高亮是彻底的死代码 |
| ×1 | P1 | correctness | `tools/grouping.ts:493` | 新建组从来不会主动刷新 leader，leader 已结束时整组只剩第一行、后续成员的行彻底消失 |
| ×1 | P1 | api-contract | `tools/builtins.ts:403` | 覆盖 7 个内置工具时没有透传 promptSnippet/promptGuidelines，system prompt 里 read/bash/edit/write/grep/find/ls 的说明和准则全部消失 |
| ×11 | P2 | state-leak | `commands.ts:71` | ccToolsExtraDetail 持久化了但启动时从不推给 builtins，状态栏说 on 实际是 off，第一次快捷键还是空按 |
| ×5 | P2 | resource-leak | `tools/builtins.ts:670` | writeOldContent / writeExistedBefore 整会话只增不减，每次 write 都长期驻留一份旧文件全文 |
| ×5 | P2 | correctness | `tools/builtins.ts:440` | read 带 limit 参数时 "Read N lines" 把 pi 追加的续读提示多算 2 行 |
| ×3 | P2 | dead-code | `tools/collapse.ts:387` | GroupInfo.thinkingSince 从未被赋值，“thinking for” 现在时和实时走秒表全是死代码 |
| ×3 | P2 | layout-width | `tools/grouping.ts:754` | 折叠组最后一个成员用 └ 收口，但它的结果行仍用 │ 续接，树线在收口后继续往下画 |
| ×3 | P2 | dead-code | `tools/diff.ts:281` | maxLineNumber 对 ctx 行只看 oldNum，但渲染时 ctx 显示 newNum，位数变多时 gutter 溢出一列 |
| ×2 | P2 | correctness | `tools/grouping.ts:596` | ⎿ 提示行取的是第一个 pending 成员而不是最新的，并行批次里会卡在第一个文件上；leader 是 ls 时提示行直接消失 |
| ×2 | P2 | correctness | `tools/grouping.ts:347` | /cc-tools group off 写 homedir() 但 grouping.ts 读 process.env.HOME，HOME 缺失时开关失效；且切换后不重绘 |
| ×2 | P2 | ansi-color | `tools/grouping.ts:199` | blink 每 tick 只 invalidate 最近 5 个，预算外的 pending 行会冻结在“空格相位”，状态点直接消失 |
| ×2 | P2 | formatting | `tools/diff.ts:248` | wrapAnsi 按 UTF-16 code unit 推进，换行点会把 emoji 的代理对劈成两半 |
| ×2 | P2 | formatting | `tools/builtins.ts:120` | Bash 头部 detail 按 code unit 截断，中文命令头能撑到 320 列，且会切断代理对 |
| ×2 | P2 | layout-width | `tools/diff.ts:942` | DiffCardComponent.invalidate 只清宽度缓存，buildFn 闭包仍持有旧 palette，换主题后 diff 卡片颜色不跟随 |
| ×2 | P2 | crash | `tools/builtins.ts:270` | cachedText/makeText 无类型校验就调 setText，write 新文件折叠↔展开来回切会抛 TypeError 掉回原始输出 |
| ×2 | P2 | formatting | `tools/mcp.ts:36` | humanizeToolName 用 [^_]+ 匹配 server 名，含下划线的 MCP server 前缀剥不掉，标签变成 "Mcp Claude Ai Google Drive Authenticate" |
| ×2 | P2 | ansi-color | `tools/diff.ts:182` | wrapAnsi 的 ansiState 回放了 fg/bg/bold/italic 但漏了 dim(SGR 2)，diff 上下文行折行后第二行不再变暗 |
| ×2 | P2 | formatting | `tools/diff.ts:904` | split 布局中较短一侧的补齐行用 BG_DEFAULT 填充，add/del 色块断裂 |
| ×2 | P2 | correctness | `tools/builtins.ts:531` | bash 成功结果的展开分支仍然用 previewLimit()=8，ctrl+o 从最后 8 行变成前 8 行，不是展开而是换了个窗口 |
| ×2 | P2 | formatting | `tools/builtins.ts:388` | 展开态成员结果预览取的是输出尾部 8 行，却按“前 8 行 + 还有 N 行”的措辞渲染 |
| ×2 | P2 | state-leak | `tools/builtins.ts:712` | write 的旧内容快照只在 execute 里写入，/resume 后历史 Write 全被当成新建文件渲染 |
| ×2 | P2 | api-contract | `tools/builtins.ts:465` | execute 里用 createXToolDefinition(ctx.cwd) 重建工具，丢掉宿主传的 shellPath/commandPrefix/autoResizeImages |
| ×2 | P2 | ansi-color | `palette.ts:191` | 回退调色板把 diffAddedBg 和 diffAddedWord 映射到同一个 token，非 CC 主题下词级 diff 高亮完全看不见 |
| ×1 | P2 | correctness | `tools/grouping.ts:449` | 同一条 assistant 消息里第二段及以后的 thinking 全被记成 0ms |
| ×1 | P2 | layout-width | `tools/collapse.ts:423` | 折叠组的 `⎿` 进行中提示只有 300 字符硬上限、完全不看终端宽度，长命令折成一大块 |
| ×1 | P2 | ansi-color | `tools/diff.ts:523` | CRLF 文件的 \r 原样进入渲染行，回车把已经画好的 gutter 冲掉 |
| ×1 | P2 | formatting | `status-line.ts:66` | HOME 未设置时 `String.replace("", "~")` 会在 cwd 前面凭空插一个 `~` |
| ×1 | P2 | correctness | `tools/builtins.ts:158` | "Found N files" 把 pi 的 notices 尾注和 context 行都算成了文件 |
| ×1 | P2 | correctness | `tools/builtins.ts:499` | bash 结果用正则从合并输出里抓 exit code，命令自己打印 "exit code: N" 就被误判成失败 |
| ×1 | P2 | correctness | `tools/builtins.ts:571` | grep/find/ls 的计数把 pi 追加的 [xxx limit reached] 提示行也算进去，达上限时统计全部 +1 |
| ×1 | P2 | correctness | `tools/builtins.ts:817` | edit 的 diff 把 edits[] 拼成假文档来 diff，行号一律从 1 开始，且丢弃了 pi 提供的真实 patch |
| ×1 | P2 | api-contract | `commands.ts:180` | Ctrl+Shift+O 在非 Kitty 协议终端收不到，按下去反而触发 pi 内置的 Ctrl+O 展开 |
| ×1 | P2 | ansi-color | `palette.ts:221` | palette.ts 无视 theme.getColorMode()，永远发 24 位真彩转义；连 *-ansi 两套主题的 diff chrome 也是硬编码 RGB |
| ×1 | P2 | correctness | `palette.ts:139` | paletteKeyForThemeName 把 pi 内置的 "dark"/"light" 主题误判成 CC 主题，且 isLightThemeName 用 includes("light") 子串匹配 |
| ×1 | P2 | api-contract | `thinking.ts:77` | setHiddenThinkingLabel 是全局标签（会刷写 chatContainer 里所有历史 AssistantMessageComponent），被当成 per-block 用，历史 thinking 标签被整体改写 |
| ×3 | P3 | formatting | `tools/grouping.ts:722` | glance 行把 bash 命令硬切到 72 字符且不加省略号，看起来像命令本身就是那样 |
| ×2 | P3 | layout-width | `tools/diff.ts:372` | shouldUseSplit 用 .length 数「会换行的行」，CJK diff 被误判为窄行从而选中 split 布局 |
| ×2 | P3 | formatting | `banner.ts:79` | truncatePath 对绝对路径产出 `//…/name`，对带尾斜杠的路径产出 `//…/`（信息全丢） |
| ×2 | P3 | crash | `banner.ts:392` | 极窄终端下 compact 欢迎盒的顶边框冲出盒外，width≤3 时 "─".repeat(负数) 直接抛 RangeError |
| ×2 | P3 | layout-width | `tools/mcp.ts:139` | MCP summary 模式按字符 slice(0,79)，会把工具输出里的转义序列拦腰截断 |
| ×2 | P3 | correctness | `spinner.ts:87` | spinner 动词在 agent_start 之后的 turn_start 才重新采样，显示出来的永远是上一轮的动词 |
| ×2 | P3 | dead-code | `tools/grouping.ts:266` | GroupInfo.thinkingSince 只读不写：进行时「Thinking for Xs」分支和 groupThinkingMs 的开区间累加都是死代码 |
| ×1 | P3 | dead-code | `tools/grouping.ts:40` | GroupInfo.thinkingSince 从头到尾没有任何赋值点，“thinking for Xs”现在时分支和 active 判定都是死代码 |
| ×1 | P3 | formatting | `tools/diff.ts:733` | unified 把配对行交错输出，未配对的余量却追加在 additions 之后，同一 hunk 内顺序自相矛盾 |
| ×1 | P3 | dead-code | `tools/diff.ts:843` | split 的 sep 分支与 fit() 整个是不可达代码 |
| ×1 | P3 | correctness | `tools/builtins.ts:611` | find/ls 的结果计数把 pi 的 notices 尾注算成一条结果 |
| ×1 | P3 | formatting | `tools/builtins.ts:315` | 预览省略提示不做单复数，剩 1 行时显示 "1 more lines" / "1 earlier lines" |
| ×1 | P3 | formatting | `tools/diff.ts:349` | diff 折叠提示剩 1 行时显示 "1 more diff lines" |
| ×1 | P3 | formatting | `tools/builtins.ts:426` | 进行中文案用 ASCII 三点 `...`，同屏其它文案用 `…` |
| ×1 | P3 | formatting | `tools/grouping.ts:701` | 同一次 grep 在折叠展开视图里叫 "Grep"，独立渲染时叫 "Search" |
| ×1 | P3 | state-leak | `tools/grouping.ts:372` | /cc-tools group off 只清缓存不重绘，已渲染的被隐藏成员行永久留空 |
| ×1 | P3 | correctness | `commands.ts:88` | /cc-tools group off 已不是死开关，但切换后不触发任何重绘，屏幕上像没生效 |
| ×1 | P3 | correctness | `tools/grouping.ts:157` | settleLeakedGroups 把所有未结束的工具一律标成 success，Esc 中断的工具显示绿点 |
| ×1 | P3 | correctness | `thinking.ts:114` | thinking.ts 的 message_end 没有过滤 role，user / toolResult 消息也会重置 working message 和隐藏标签 |
| ×1 | P3 | correctness | `status-line.ts:41` | status line 的 cost 从历史累加、时长和 turn 数却从 resume 那一刻从零开始，同一行两半互相矛盾 |
| ×1 | P3 | resource-leak | `banner.ts:176` | BannerComponent.invalidate() 是空实现且 render() 无缓存，欢迎盒在流式期间每帧整体重算 |
| ×1 | P3 | ansi-color | `spinner.ts:74` | setWorkingIndicator 的帧颜色在 session_start 时就烧死，换主题后 spinner 一直是旧主题的 accent |
| ×1 | P3 | ansi-color | `tools/grouping.ts:577` | 展开分组后 pending 成员的状态点没有任何前景色，比其他地方的 pending 点亮一档 |

---

## 6 · 与 Claude Code 的差距（126 项）

`可行性` 三档：**可做** = 现有 pi API 能补上；**有损** = 只能做近似；**卡死** = pi 无钩子，要改 pi 本体或放弃。


### 工具结果行（⎿ 结果、折叠预览、错误态）

> pi 扩展把 `  ⎿  ` 前缀、5 空格续行缩进、`Read N lines` / `Found N files` / `Added N lines, removed M lines` 这些一行式统计文案都复刻对了，数字也 bold 了，这部分基本无差距。真正的差距集中在**结果体的截断策略**上：CC 折叠时取「前 3 行（按终端宽度换行后计数）」+ dim `… +N lines (ctrl+o to expand)`，pi 取「后 8 行」+ muted `... (N earlier lines)` / `... (N more lines)` 且完全没有 ctrl+o 提示；更严重的是 pi 的 `previewLimit()` 不随 `expanded` 变化，按 ctrl+o 展开后仍然只有 8 行，CC 展开是全文。错误态也整体不同：CC 走统一的 FallbackToolUseErrorMessage（整段红、`Error: ` 前缀、10 行上限、`… +N lines (ctrl+o to see all)`），pi 自造了红色 `Exit N` 首行 + dim 尾部预览，且中断（esc）被渲染成红色 `Operation aborted`，CC 是 dim 的 `Interrupted · What should Claude do instead?`。此外 pi 给每个工具都打了 `Reading...` / `Searching...` 进行中占位行，CC 除 Bash 外根本不渲染进行中结果行。

| 级别 | 可行性 | 工作量 | 差距 |
|---|---|---|---|
| P1 | 可做 | M | 折叠 bash 输出：CC 取前 3 行（按终端宽度换行计数），pi 取后 8 行 |
| P1 | 可做 | S | 截断尾行文案/配色全不一样：CC `… +N lines (ctrl+o to expand)` 全 dim，pi `... (N more lines)` muted 且无 ctrl+o |
| P1 | 可做 | S | ctrl+o 展开后仍然只有 8 行，CC 展开是全文 |
| P1 | 可做 | M | bash 失败：CC 是整段红 + `Error: ` 前缀 + 前 10 行；pi 是红色 `Exit N` 首行 + dim 尾 8 行 |
| P2 | 可做 | S | 进行中占位行：CC 只有 Bash 有（`Running…`），pi 给每个工具都打了一行 `Reading...` / `Searching...` |
| P2 | 可做 | S | Grep/Glob 结果行缺 `(ctrl+o to expand)`，空结果 CC 说 `Found 0 files` 而 pi 说 `no matches`；find 少了 `Found` 前缀 |
| P2 | 可做 | S | 用户 esc 打断工具：CC 显示 dim `Interrupted · What should Claude do instead?`，pi 显示红色 `Operation aborted` / `Error` |
| P2 | 可做 | S | pi 预览会丢掉输出中间的所有空行，CC 只裁首尾空行 |
| P2 | 可做 | M | 通用错误体缺 `Error: ` 前缀、10 行上限与 `(ctrl+o to see all)` |
| P2 | 可做 | M | bash 流式预览形态不同：CC 尾 5 行 + 下方 `+N lines (耗时) (字节数)`，pi 是 `Running...` 头 + 上方 `... (N earlier lines)` + 尾 8 行 |
| P2 | 可做 | S | 新建文件预览：CC 的 `… +N lines (ctrl+o to expand)` 是同一行 dim 且只在有剩余时出现，pi 拆成两行且提示无条件输出 |
| P2 | 有损 | S | Read 的非文本结果：CC 有 image/PDF/notebook/unchanged 四种专用文案，pi 只有一条且用错了 Bash 的字符串 |
| P3 | 有损 | S | bash 无输出时 CC 有 `Done` / 退出码语义 / 后台任务三种文案，pi 恒为 `(No output)` |

### Spinner 状态行

> pi 扩展只对齐了 spinner 的"静态外形"——12 帧乒乓字符序列、120ms 间隔、187 个 fun verb、30s 阈值的 turn footer，这几项确实抄对了。但 CC 的 spinner 行本质是一个 20fps 自绘动画行（SpinnerAnimationRow 里 useAnimationFrame(50) 驱动 glimmer 扫光、stalled 渐变红、token 计数缓动、thinking 正弦辉光、渐进宽度降级），pi 扩展这一层几乎为零：verb 被 pi 的 Loader 强制染成 muted 灰（CC 是 claude 橙）、没有扫光、没有计时器、没有 `↓ N tokens`、没有 stalled 变红、thinking 时直接把 verb 整个替换掉。关键可行性结论：pi 的 Loader.setMessage 会调 ui.requestRender（loader.js:38-41,59-67），所以扩展完全可以自己开 50ms 定时器逐帧重写 message；再配合 `frames: []` 关掉内置指示器、把 glyph 画进 message 首字符，CC 这一整行的动画在 pi 上是可以完整复刻的（不需要改 pi 本体）。目前差距的主因是"没做"，不是"做不了"。

**已对齐**：帧序列完全对齐 CC：`['·','✢','✳','✶','✻','✽']` 正向 + 反向共 12 帧乒乓（spinner.ts:15-17 vs Spinner/utils.ts:5-11 + SpinnerGlyph.tsx:13-16），且 ghostty 下末帧换 `*` 的特判也抄到了；帧间隔 120ms 与 CC 的 `Math.floor(time / 120)` 一致（spinner.ts:19 vs SpinnerAnimationRow.tsx:133）；fun verb 表逐字对齐：与 constants/spinnerVerbs.ts 的 SPINNER_VERBS 完全一致（187 条，逐条 diff 无差异），且每轮 turn_start 只重抽一次、渲染不重掷（spinner.ts:87-89 对应 CC 的 useState 初始化语义）；glyph 颜色走 accent，而扩展主题把 accent 映射到 CC 的 claude 橙 #D77757（theme/claude-code-dark.json:24 + palette.ts:58），glyph 这一半的品牌色是对的；turn footer 的 30s 阈值、`✻ <过去式动词> for <时长>`、8 个 TURN_COMPLETION_VERBS 与 CC 的 constants/turnCompletionVerbs.ts、REPL.tsx:2974 完全一致；formatTurnDuration 在 <60s / <1h / >=1h 三档上与 CC 的 formatDuration 输出相同；turn footer 用 appendEntry + registerEntryRenderer 落盘，能跨 reload/resume 存活——这一点比单纯打印更接近 CC 把它做成 session message 的做法

| 级别 | 可行性 | 工作量 | 差距 |
|---|---|---|---|
| P1 | 可做 | S | spinner verb 是灰色，CC 是 claude 品牌橙 |
| P1 | 可做 | M | 完全没有 glimmer 扫光动画（CC spinner 最标志性的效果） |
| P1 | 可做 | M | 缺 `(12s · ↓ 1.2k tokens)` 计时/token 段与 30s 显示阈值 |
| P1 | 可做 | S | thinking 期间 verb 被整个替换成 `(thinking)`，CC 是 verb 后追加一段 |
| P2 | 可做 | M | 缺 stalled 变红：3s 无新 token 后 glyph 与 verb 渐变到暗红 |
| P2 | 可做 | S | `thought for 4s` 没有出现在 spinner 行（被挪到隐藏思考标签里） |
| P2 | 可做 | S | 运行中没有 `esc to interrupt` 提示 |
| P2 | 有损 | M | 没有 SpinnerMode 概念：缺 tool-use 整行脉冲、requesting 的 ↑/50ms 快扫 |
| P3 | 有损 | M | spinner 下方缺 `Tip:` / `Next:` 提示行 |
| P3 | 可做 | S | 没有 reduced-motion 降级路径 |
| P3 | 可做 | S | 非 macOS 平台第 3 帧字符不对 |
| P3 | 有损 | S | turn footer 在用户中断时也会打印，且时长未扣暂停时间 |

### Edit/Write 的 diff 渲染

> ALIGNMENT.md §3 的 6 条待办（stat 行、dashed 边框、hunk 间 `...`、shiki 主题跟随、宽度参数化）确实都做了，stat 行文案/词级阈值 0.4/context=3/hunk 分隔符这些"抄文案"级别的对齐是准的。但 §3 的 CC 事实取材于 `StructuredDiff/Fallback.tsx`（CC 的降级分支）和 `FileEditToolDiff.tsx`（权限对话框），而 CC transcript 里 Edit/Write 结果实际走的是 `FileEditToolUpdatedMessage` → `StructuredDiffList` → `StructuredDiff` → `native-ts/color-diff`（TS 版 Rust 端口）。对着错的参照物抄，导致 gutter 列序、行底色、语法高亮主题、长行换行策略四项全都偏了，而且 pi 多画了 CC 没有的 `▌`/`│`/dashed 边框/split 视图。最严重的是 edit 的 diff 根本不读文件，只把 `edits[].oldText/newText` 串起来对拼，行号从 1 开始且没有真实上下文。

| 级别 | 可行性 | 工作量 | 差距 |
|---|---|---|---|
| P1 | 可做 | M | edit 的 diff 拿 edits 字符串对拼，行号是假的、没有真实上下文、多 edit 被串成一坨 |
| P1 | 可做 | M | gutter 列序完全不同：CC 是 `+ 42 code`，pi 是 `▌42+ │ code` |
| P1 | 可做 | S | 长行被截断成 1 行加 `›`，CC 是无限换行 |
| P2 | 可做 | S | 加/删行底色抄的是 CC 降级分支的 theme token，比 CC 主渲染器亮很多 |
| P2 | 可做 | S | 语法高亮配色不对：CC dark 是 Monokai，pi 用 shiki github-dark |
| P2 | 可做 | S | CC 根本没有 side-by-side diff，pi 在 ≥150 列时自动切成双栏 |
| P2 | 可做 | S | tool 结果里 CC 没有虚线边框，pi 每个 diff 多画上下两条 `╌` |
| P2 | 可做 | S | 上下文行 pi 把整行正文调暗，CC 只把行号 gutter 调暗、正文保持正常亮度的语法高亮 |
| P2 | 可做 | M | Write 新建文件的前 10 行预览没有行号，CC 有 |
| P2 | 可做 | S | Write 新建文件按 ctrl+o 展开后 pi 变成全绿 diff 卡片，CC 是完整高亮源码 |
| P2 | 可做 | S | Write 预览的 `(ctrl+o to expand)` 无条件出现且单独占一行，CC 只在被截断时出现且与 `… +N lines` 同一行 |
| P3 | 可做 | S | CC 的删除行不做语法高亮（纯前景色），pi 两侧都上 shiki 色 |
| P3 | 可做 | S | diff 可用宽度：CC 留 12 列，pi 只留 5 列，卡片贴到终端右边缘 |
| P3 | 可做 | S | pi 的 60/150 行截断和 `… (N more diff lines …)` 提示 CC 没有 |

### Subagent / Task 工具的进度与完成呈现

> 这是差距最大的一个维度：pi 本体根本没有 subagent/Task 概念（内置工具只有 read/bash/edit/write/grep/find/ls 七个，interactive-mode.js 的消息 role switch 里也没有任何 agent 分支），pi 扩展 better-claude-code-ui 也完全没有处理——全目录 grep `subagent|task|agentType|Done (` 只命中 grouping.ts:116 的一句注释。CC 这一侧则是一整套：`⏺ Explore(desc)` 头行 → 实时挂最近 3 条子 agent 工具调用 → 多 agent 时 `├─/└─ + ⎿` 双行进度树（带 per-agent 反色徽章、tool uses/tokens 统计）→ 完成行 `Done (N tool uses · M tokens · duration)` → ctrl+o 展开完整子会话 transcript。好消息是 pi 的钩子基本够用：`registerTool` + `execute(...onUpdate)` 流式 partial + `ToolRenderContext.{invalidate,expanded,isPartial}` 足以自绘整棵树，`AgentSession`/`createAgentSession` 还在包顶层导出，所以主体是 feasible-但-effort-L；真正 blocked 的只有 spinner 区的 teammate 树和后台 agent 管理面板。

**已对齐**：grouping.ts 的 leader 渲染整组 / 非 leader 返回 0 行的骨架，形状上最接近 CC 的 AgentProgressLine 分组树，做 subagent 树时可直接复用（grouping.ts:740-761）；turn-footer.ts:58-65 已跑通 appendEntry + registerEntryRenderer 往 transcript 插自定义单行的路径，subagent 完成通知可以照抄这套；builtins.ts:201-213 的三态 statusDot（error/blink/success）+ grouping.ts 的 armBlink 调度，已经复刻了 CC ToolUseLoader 的圆点语义，是 agent 进度行状态点的现成件；IMPLEMENTATION.md:66/88 诚实标注了「subagent 完成通知重样式 ❌ 未搬」，没有虚报（本次核实属实）

| 级别 | 可行性 | 工作量 | 差距 |
|---|---|---|---|
| P1 | 可做 | L | pi 侧完全没有 Task/Agent 工具，CC 整条 subagent UI 链路无对应物 |
| P1 | 可做 | M | 缺 `Done (N tool uses · M tokens · duration)` 完成统计行 |
| P1 | 可做 | L | 缺并发多 Task 的分组进度树（头行 + 每 agent 两行 ├─/⎿） |
| P2 | 可做 | M | 缺运行中的实时进度：Initializing… / 最近 3 条子调用 / +N more tool uses |
| P2 | 可做 | S | 最接近 subagent 的场景（长跑 MCP 工具）在 pi 里只显示一个 dim `...` |
| P2 | 可做 | S | 分组树字符与 CC 的 AgentProgressLine 不一致：缺横杠、缺 ⎿ 续行 |
| P2 | 可做 | S | 缺 subagent 完成通知行 `● <summary>`（圆点按 status 上色） |
| P2 | 可做 | M | ctrl+o 展开时缺子 agent 完整会话（Prompt / 全量 transcript / Response 三段） |
| P3 | 可做 | S | 缺 per-agent 稳定配色徽章（agentType 反色底块） |
| P3 | 有损 | M | 缺后台 / 远程 agent 的三种状态呈现 |
| P3 | 卡死 | L | spinner 区的 teammate 实时树在 pi 上没有落脚点 |
| P3 | 有损 | L | 缺子 agent 活动摘要服务（每 30s fork 出 3-5 词现在时描述） |
| P3 | 可做 | S | 缺任务派发卡片（cyan 圆角边框） |

### 消息级 chrome（用户消息 / 系统消息 / 附件 / 压缩边界 / 错误）

> 这是整个扩展覆盖最薄的一层：`extension/` 下 13 个文件里，只有 `thinking.ts`（assistant-thinking transformer）和 `turn-footer.ts`（appendEntry + entryRenderer）触到了消息流，用户消息、`!` bash、斜杠命令、压缩边界、图片附件、错误/中断行全部原样交给 pi 自渲染，一行都没对齐。根因是 pi 的 `addMessageToChat`（interactive-mode.js:2857-2932）只对 `custom` 一种 role 查 renderer 注册表，user / bashExecution / compactionSummary / skill 块全是直接 `new` 固定组件，所以这一维里超过一半的差距是 `blocked`，靠现有 API 补不上。真正能改的只有三处：markdown transformer 给用户消息加 `❯ ` 和做长文截断、`input` 事件把图片转成 `[Image #N]` 文本、扩展自己的命令输出改走 appendEntry；剩下的要么得改 pi 本体，要么只能做加不能做减。

| 级别 | 可行性 | 工作量 | 差距 |
|---|---|---|---|
| P1 | 有损 | S | 用户消息缺 `❯ ` 指针，且被 pi 包成上下各一空行的全宽底色块 |
| P1 | 卡死 | L | `!` bash 命令：CC 是一行 `! cmd` + `⎿` 结果，pi 是全宽双横线包围的盒子 |
| P2 | 卡死 | L | 压缩边界：CC 是一行 dim `✻ Conversation compacted (ctrl+o for history)`，pi 是 `[compaction]` 紫底多行块 |
| P2 | 有损 | M | 斜杠命令在 transcript 里完全没有回显，输出也没有 `⎿` gutter |
| P2 | 有损 | S | 用户消息里的图片在 transcript 上一个字都不显示（CC 显示可点击的 `[Image #N]`） |
| P2 | 卡死 | M | 错误/警告行：CC 是 `⎿` gutter 内的 error 色正文 + 重试倒计时，pi 是字面量 `Error: ` 前缀的裸行 |
| P2 | 卡死 | L | ESC 中断后没有 CC 的 `⎿ Interrupted · What should Claude do instead?` 引导行 |
| P2 | 有损 | M | CC 的用户消息是纯文本，pi 会把用户输入当 Markdown 解析渲染 |
| P2 | 可做 | S | 系统行 gutter 列位错位：CC 字形在第 0 列、正文第 2 列，扩展 turn footer 在第 1/3 列 |
| P3 | 卡死 | L | Skill 调用块：CC 是一行 `❯ Skill(name)`，pi 是 `[skill] name` 紫底块 |
| P3 | 可做 | S | 超长用户消息不截断（CC 有 10k 字符上限 + `… +N lines …`） |
| P3 | 有损 | L | CC 的上下文注入行（`⎿ Read x (N lines)` / `Recalled N memories` 等）在 pi 上整类缺失 |

### 思考块渲染（AssistantThinkingMessage / Spinner thinking 状态机）

> 差距很大，且是"方向性"的：CC 在 transcript 里把 thinking **默认折叠成一行** `∴ Thinking (ctrl+o to expand)`，把 `thought for Xs` 只放在 **spinner 状态行**里（小写、括号 byline、结束后 2s 自动消失）；pi 扩展把这两层搞反了——它把 spinner 专属的时长塞进了 pi 的**全局** hidden-thinking 标签（`∴ 15s`），既丢了 `Thought for` 字样和展开提示，又因为 pi 的 setHiddenThinkingLabel 会重写 chatContainer 里所有历史 AssistantMessageComponent 的标签，导致整个会话历史的 thinking 行被同一个时长覆盖。同时 pi 默认 `hideThinkingBlock=false`，所以未按过 ctrl+t 的用户看到的是**全量展开**的思考正文，扩展还给它加了标题行，进一步偏离 CC 的默认观感。关于用户看到的 `Thought for 18s (ctrl+o to expand)`：本快照里 **不存在** 这个字符串——快照的折叠行是无时长的 `∴ Thinking (ctrl+o to expand)`（AssistantThinkingMessage.tsx:44），小写 `thought for Ns` 只在 SpinnerAnimationRow.tsx:172；两者合并成一行属于**快照未见 / 疑似新版 CC**，本清单按快照行为给建议并在对应条目里标注。

**已对齐**：流式中态标签 `∴ Thinking` 与 CC 折叠行的前半段完全一致（thinking.ts:28 vs AssistantThinkingMessage.tsx:44 的 `∴ Thinking`）；展开态结构对：标题 `∴ Thinking…` 单独一行 + 空行 + 正文，且 transformer 是前插而非拼进首行，不会破坏以 `# `/`- ` 开头的 markdown（thinking.ts:50-57 vs AssistantThinkingMessage.tsx:62）；时长取整算法逐字对齐 CC：`Math.max(1, Math.round(ms/1000))`（thinking.ts:35 vs SpinnerAnimationRow.tsx:172）；turn_start 复位 + message_end 兜底结算（thinking.ts:72-81, 114-132），abort 路径不会把上一轮时长永久留在屏幕上；theme token `thinkingText` 映射到 #999999（claude-code-dark.json:34/12），与 CC 折叠行 dimColor 的观感接近，颜色这层不用再动

| 级别 | 可行性 | 工作量 | 差距 |
|---|---|---|---|
| P1 | 可做 | S | 折叠行文案错位：CC 是 `∴ Thinking (ctrl+o to expand)`，pi 变成 `∴ 15s` |
| P1 | 有损 | S | 默认观感相反：CC 默认折叠一行，pi 默认整段展开，扩展还给它加了标题 |
| P1 | 有损 | M | 时长标签是全局的：写一次会把历史里所有 thinking 行同时改成同一个时长 |
| P1 | 可做 | S | 思考时 spinner 行的动词被整条顶掉，CC 是动词 + 括号状态并存 |
| P2 | 有损 | L | 没有可回退的展开/折叠：CC 的 ctrl+o 是视图态且逐块生效，pi 的 ctrl+t 是全局设置并写盘 |
| P2 | 可做 | M | spinner 行缺 `thought for Xs` 收尾态与 2s 最小展示/2s 自动清除 |
| P2 | 可做 | S | thinking 后缀文案不对：CC 是 ` with high effort` 且未显式设置时不显示，pi 是 ` · high` 且恒显示 |
| P2 | 卡死 | S | 展开态正文样式差两处：CC 正文缩进 2 列且不斜体，pi 无缩进且整段强制斜体 |
| P3 | 有损 | M | 缺 thinking 文字的呼吸 shimmer（3s 延迟后 2s 周期在 #999999↔#b9b9b9 之间正弦插值） |
| P3 | 可做 | S | 缺窄终端下的渐进降级：CC 会先砍 effort 后缀、再整段隐藏 thinking |
| P3 | 有损 | M | redacted thinking 没有任何呈现，CC 会出一行 `✻ Thinking…`（注意是 ✻ 不是 ∴） |
| P3 | 可做 | M | 用户提示词里的 think/ultrathink 触发词没有彩虹高亮 |

### 连续工具折叠摘要行（CollapsedReadSearchContent / grouping.ts）

> 措辞层面 pi 抄得很准：动词表、时态、单复数、数字 bold、`(ctrl+o to expand)`、`⎿` hint 的 700ms 保持、600ms 闪烁周期、settled 无 glyph——这些基本一一对上。但结构层面差距很大：pi 的分组是「每 turn 重建的事件驱动状态机」，CC 是「每帧从消息列表纯函数重算」，由此派生出 5 个用户一眼能看到的问题——MCP 工具没接进分组导致成员整条消失、ctrl+o 展开时组内清单被渲染两遍、历史组按一次 ctrl+o 后永久炸开回不去、只读 bash 被算成「ran N bash commands」而不是 read/search/list、单个工具调用不折叠。另外 pi 自己加了 CC 根本没有的「Thought for Xs」片段。`/cc-tools group off` 是真生效的，ALIGNMENT.md §4.5「死开关」的说法已经过时（只剩「不重绘已有行」这个小尾巴）。

**已对齐**：动词/时态/单复数表与 CC 完全一致：Searching for N patterns / Searched for N patterns、Reading|Read N files、Listing|Listed N directories、Querying|Queried <server>[ N times]、Running|Ran N bash commands（CollapsedReadSearchContent.tsx:347/358/369/391/405 ↔ collapse.ts:373-404）；片段顺序 search → read → list → mcp → bash 与 CC 一致；首片段首字母大写、其余小写、以 `, ` 连接也一致；每个计数用 bold 包裹，settled 整行 dim、active 行不 dim（CollapsedReadSearchContent.tsx:452 `dimColor={!isActiveGroup}` ↔ grouping.ts:665）；settled 组不画 glyph、只留 2 空格 gutter（即使成员报错），active 组画 600ms 闪烁点，字符 darwin `⏺` / 其他 `●`——与 ToolUseLoader.tsx:20/33 + figures.ts:4 一致；active 时摘要尾部加 `…`，再空格接 `(ctrl+o to expand)`（CollapsedReadSearchContent.tsx:459 的顺序）；`⎿` hint 只在 active 时出现，格式 `  ⎿  ` 两空格+⎿+两空格，最小展示 700ms（MIN_HINT_DISPLAY_MS=700 ↔ HINT_MIN_DISPLAY_MS=700）；hint 内容规则一致：read → 相对路径、grep/find → `"pattern"`、bash → `$ 压缩命令`，300 字截断（MAX_HINT_CHARS=300 ↔ formatCollapseHint 的 300）；bash 只读判定的四张词表（search/read/list/neutral）与 BashTool.tsx:120-166 逐词相同，管道/重定向/复合命令的「全部片段都得是只读」规则也一致；edit/write 打断分组、其结果不进摘要——与 CC 一致（CC 里它们 isSearchOrReadCommand 未定义 → isNonCollapsibleToolUse → flushGroup）；`/cc-tools group off` 确实生效：写 ~/.pi/settings.json 的 groupToolCalls 并 bustGroupingSettingsCache()，isHiddenGroupMember/getGroupRenderInfo 都做了 isGroupingEnabled() 门控（grouping.ts:548/560）

| 级别 | 可行性 | 工作量 | 差距 |
|---|---|---|---|
| P1 | 可做 | M | MCP 工具参与分组计数却不参与分组渲染：组成员会整条从 transcript 消失 |
| P1 | 可做 | S | ctrl+o 展开时组内清单被渲染两遍（一遍无结果、一遍带结果） |
| P1 | 可做 | M | 历史 turn 的折叠组按一次 ctrl+o 后永久炸开，再也收不回摘要行 |
| P1 | 可做 | S | 只读 bash 被算进 “ran N bash commands”，而 CC 会算成 read / search / list |
| P1 | 可做 | S | pi 要求连续 ≥2 个只读调用才折叠，CC 单个调用就折叠 |
| P2 | 可做 | M | assistant 中途输出正文不打断分组，CC 会打断 |
| P2 | 可做 | M | 工具一跑完就变过去时，CC 会一直保持进行时到整轮生成结束 |
| P2 | 可做 | S | pi 在摘要行前面加了 “Thought for Xs, ”，CC 的折叠行里根本没有 thinking |
| P2 | 可做 | M | ctrl+o 展开后 pi 画 ├/└/│ 树，CC 就是普通的逐条工具块 |
| P2 | 有损 | M | MCP 是否可折叠：CC 用写死的工具名名单，pi 用动词启发式 |
| P3 | 可做 | S | ⎿ hint 取的是「第一个 pending 成员」，CC 取的是「最后加入组的调用」 |
| P3 | 可做 | S | `(ctrl+o to expand)` pi 加了斜体，CC 只有 dim |
| P3 | 可做 | M | hint 超出终端宽度时 pi 折回第 0 列，CC 有 5 列悬挂缩进 |
| P3 | 可做 | S | `/cc-tools group off` 生效但不重绘已有行（ALIGNMENT.md §4.5 的「死开关」说法已过时） |

### 工具调用行（⏺ Tool(detail)）

> 骨架对齐得相当好：⏺ 字形按平台切换、闪烁点状态机（dim 闪 / success / error）、bold 默认色工具名 + (detail)、`  ⎿  ` 结果 gutter + 5 空格续行、bash 命令 2 行/160 字截断、"Read N lines"/"Wrote N lines to X" 的 bold 数字，都与 CC 一致；覆盖面上 pi 只有 7 个内置工具 + MCP，扩展全都接管了，不存在 CC 那种"Task/TodoWrite/WebFetch 没做"的缺口。真正的差距集中在三处：(1) 工具名映射错了两个——CC 的 FileEdit 叫 `Update`/`Create` 而不是 `Edit`，Glob 叫 `Search` 而不是 `Find`；(2) 结果体的裁剪形态与 CC 相反——CC 取前 3 行（按终端宽度折行后计）+ `… +N lines (ctrl+o to expand)` 且正文用默认色，pi 取后 8 行 + `... (N earlier lines)` 且整段 dim，更严重的是 ctrl+o 展开后仍然只给 8 行；(3) MCP 行整套自成一格——没有 `()` 包参数、结果行完全没有 `⎿` gutter、工具名丢了 `server - … (MCP)` 结构且去前缀正则对含下划线的 server 名直接失效。

**已对齐**：⏺/● 按 platform===darwin 切换，与 CC constants/figures.ts:4 完全一致（builtins.ts:65）；状态点三态与 600ms 闪烁周期对齐 CC ToolUseLoader.tsx + useBlink 的 BLINK_INTERVAL_MS=600（builtins.ts:201-213、grouping.ts:104）；行头结构 `dot + 空格 + bold(默认色)名 + (detail)` 与 CC AssistantToolUseMessage.tsx:200/210 一致，没有误用 pi 的 toolTitle 橙色；结果 gutter `  ⎿  ` + 5 空格续行缩进，逐字符对齐 CC MessageResponse.tsx:22（builtins.ts:70-71、238-243）；bash 行头命令截断 2 行 / 160 字 + `…`，与 CC BashTool/UI.tsx:26-27,112-124 完全同参（builtins.ts:110-123）；Read 结果 `Read {bold N} lines`、Write 新文件 `Wrote {bold N} lines to {bold path}` + 前 10 行高亮，与 CC FileReadTool/UI.tsx:131、FileWriteTool/UI.tsx:26,79 对齐；覆盖面完整：pi 的内置工具集就是 read/bash/grep/find/ls/write/edit 七个（core/tools/index.d.ts ToolName），扩展全部同名覆盖并转发 execute，另加 mcp__* 通配包装，没有落到 pi 默认 Box+背景块渲染的内置工具；路径相对化逻辑（cwd 相对 → HOME 换 ~ → 绝对路径）与 CC utils/file.ts:155-170 getDisplayPath 等价

| 级别 | 可行性 | 工作量 | 差距 |
|---|---|---|---|
| P1 | 可做 | S | 编辑工具行头 CC 叫 Update/Create，pi 叫 Edit |
| ~~P1~~ 已修 | 可做 | M | ~~bash 结果预览方向与配色反了：CC 是折行后前 3 行、默认色、尾部 `… +N lines (ctrl+o to expand)`~~ → 已按 CC `src/utils/terminal.ts:71 renderTruncatedContent` 重写：视觉行预算 + 头部优先 + `… +N lines (ctrl+o to expand)`。折叠行数保留 8（非 CC 的 3），流式态按 CC `ShellProgressMessage.tsx:44` 保留 5 行尾窗 |
| ~~P1~~ 已修 | 可做 | S | ~~ctrl+o 展开后 read/bash/grep/find/ls 仍然只给 8 行~~ → 展开态改走 MAX_RENDER_LINES(150) 视觉行上限，不再是另一个 8 行窗口 |
| P1 | 可做 | S | MCP 行没有 `⎿` 结果 gutter，行头参数也没有 () 包裹 |
| P2 | 可做 | S | MCP 工具名丢了 `server - … (MCP)` 结构，且去前缀正则对含下划线的 server 名失效 |
| P2 | 可做 | S | MCP 行头参数摘要的分隔符/取值/截断参数都和 CC 不同 |
| P2 | 有损 | M | bash 运行中缺少 CC 的耗时/超时显示，行数统计位置也不对 |
| P2 | 可做 | M | 错误行没有 CC 的 `Error:` 归一化、10 行上限和 `… +N lines (ctrl+o to see all)` |
| P2 | 可做 | S | find 工具 CC 叫 Search 且用 `pattern: "x", path: "y"` 模板，pi 叫 Find 且用 `"x" in y` |
| P2 | 可做 | S | Search/Find/List 折叠结果行缺 CC 的 `(ctrl+o to expand)` 提示 |
| P3 | 可做 | S | 进行中/省略文案用了三个 ASCII 点，CC 用的是单字符 … |
| P3 | 可做 | S | 同一个 grep 工具在独立行叫 Search、在分组 glance 行叫 Grep |
| P3 | 可做 | S | write 新文件的展开提示：CC 与 `… +N lines` 同行且仅在有省略时出现，pi 恒占一整行且是斜体 |
| P3 | 有损 | S | detail 里的文件路径没有 OSC-8 超链接 |

### 启动 Logo / 状态栏 / 输入框边框 / 终端标题

> 这个维度的对齐度两极分化：输入框边框（上下两条 ─、无左右边、颜色随模式变）pi 天然就和 CC 一致，banner 的三档宽度/嵌入式标题/两栏结构也照着 CC 抄对了骨架；但**输入框下方那一整条 chrome 在 pi 扩展里完全不存在**——没有 `❯ ` 提示符、没有 `? for shortcuts` / `esc to interrupt` 提示行、没有右对齐通知列、没有 auto-compact 倒计时警告，扩展的 setFooter 只画了一行左对齐的 statusline。启动屏方向也反了：CC 默认走的是无边框的 3 行 CondensedLogo（只有有新 changelog / 首次进项目时才出带框两栏大盒子），pi 扩展每次启动都画满屏宽的大盒子。终端标题只在 session_start 设一次、内容是 cwd 而非会话主题，且随后会被 pi 自己的 updateTerminalTitle 覆盖掉。

**已对齐**：输入框边框形态天然一致：CC 是 borderStyle=round + borderLeft/Right=false（等价于上下各一条全宽 `─`），pi-tui 的 Editor.render 同样只画 `horizontal.repeat(width)` 的上下两条横线、无侧边（PromptInput.tsx:2268 vs pi-tui editor.js:407-410,462-470）；输入框边框颜色的模式联动已覆盖：CC 用 promptBorder / bashBorder 切换（PromptInput.tsx:2214-2236），pi 用 theme.getThinkingBorderColor/getBashModeBorderColor（interactive-mode.js:3311-3320），扩展主题把 thinking* 全部指向 promptBorder(#888888)、bashMode 指向 bashBorder(#FD5DB1)，与 CC 调色板一致（theme/claude-code-dark.json:71-78）；banner 的三档宽度分层 + 边框内嵌标题（`╭─── pi agent vX.Y.Z ───╮`，align start、前后各留一空格）与 CC LogoV2 的 borderText 写法一致；feed 段间的 `─` 分隔线也与 CC 的 Divider 一致；turn footer 的阈值与文案对齐：CC 是 `turnDurationMs > 30000` 且用 TURN_COMPLETION_VERBS + TEARDROP_ASTERISK `✻`（REPL.tsx:4004-4007、components/messages/SystemTextMessage.tsx:350,392；constants/turnCompletionVerbs.ts、constants/figures.ts:6），扩展 turn-footer.ts:10-15,65 逐字对上，duration 格式（`45s` / `1m 23s` / `2h 5m 1s` 带 60 进位修正）也与 utils/format.ts:34-70 一致；statusline 的 ` · ` 分隔符用 dim 色，与 CC 的 Byline（`<Text dimColor> · </Text>`，components/design-system/Byline.tsx）一致

| 级别 | 可行性 | 工作量 | 差距 |
|---|---|---|---|
| P1 | 可做 | M | CC 默认启动是无边框的 3 行 CondensedLogo，pi 扩展每次都画带框大盒子 |
| P1 | 可做 | M | 输入框缺少 CC 的 `❯ ` 提示符（bash 模式下的 `! `） |
| P1 | 有损 | M | 输入框下方的提示行整条缺失：`? for shortcuts` / `esc to interrupt` / `Press ctrl+c again to exit` / `Pasting text…` |
| P2 | 可做 | M | 缺少 CC 的 auto-compact 倒计时/上下文告急提示，现有 `ctx N%` 语义相反 |
| P2 | 可做 | S | 终端标题内容/字形/时序都不对，而且会被 pi 自己覆盖 |
| P2 | 可做 | S | footer 丢掉了右对齐列，CC/pi 默认都是两栏 space-between |
| P2 | 可做 | S | banner 和 statusline 都在显示原始 model id，CC 显示的是人类可读名 |
| P2 | 可做 | M | 输入框没有 placeholder，CC 首次启动会给示例命令提示 |
| P2 | 可做 | S | banner 各档盒宽与 CC 相反：宽屏该收窄却铺满，窄屏该铺满却收窄；版本号颜色也偏暗 |
| P3 | 有损 | S | bash 模式下缺 CC 的 `! for bash mode` 提示行 |
| P3 | 可做 | S | footer 起始列为 0，CC 的 footer 有 paddingX=2 |
| P3 | 有损 | M | banner 右栏内容与 CC 的 Recent activity / What's new 不同构，缺 dim italic 的行动提示脚注 |

### 交互面板（权限对话框 / Plan 审批 / Todo / 模式切换 / transcript 模式 / 通知）

> 这是所有维度里差距最大的一块：CC 的五类交互面板（权限确认、Plan 审批、Todo 清单、权限模式指示、全屏 transcript）在 pi 扩展里**一个都没有实现**，而且 pi 本体也完全没有对应概念（`core/extensions/types.d.ts` 全文 0 处 "permission"、无 todo 工具、无 plan mode、无 transcript 屏）。扩展只订阅了 14 个 session/turn/agent/message/tool_execution_* 事件，从未用过 `tool_call`（可 block）、`ui.select/confirm/custom`、`setWidget` 这几个恰好能撑起这些面板的 API；palette.ts 甚至已经把 `permission`/`planMode`/`autoAccept` 三个 CC 模式色算好了却无人消费。好消息是可行性并不差：权限网关、Todo 工具、Plan 消息、通知都能靠现有 API 落地（多为 partial/feasible），真正 blocked 的只有全屏 transcript 模式和 pi 内置选择器的外观。

| 级别 | 可行性 | 工作量 | 差距 |
|---|---|---|---|
| P1 | 有损 | L | 工具权限确认对话框完全不存在：CC 每次危险调用都会挂起并弹框，pi 扩展直接放行 |
| P1 | 有损 | M | 权限模式指示器（plan / accept edits / bypass）与 shift+tab 循环完全没有，palette 里的模式色是死色 |
| P1 | 可做 | L | Todo 任务清单面板缺失，且 spinner 动词没有被当前任务顶替 |
| P2 | 可做 | M | 进入/退出 plan mode 与 plan 审批面板的 transcript 行全部缺失 |
| P2 | 有损 | M | 对话框外框/标题/选项样式与 CC 不一致：CC 单条顶边 + ❯ + 编号，pi 上下双边 + → 无编号 |
| P2 | 卡死 | L | Ctrl+O 语义完全不同：CC 是全屏 transcript 模式，pi 是一次性全局展开工具输出 |
| P2 | 有损 | S | 空闲提醒与终端 bell 完全没有：CC 会在等你输入 / 等你批准时发系统通知 |
| P2 | 有损 | M | 模型主动提问的多选面板（AskUserQuestion）不存在 |
| P3 | 有损 | S | 中断/拒绝后的 transcript 反馈行文案与配色不同：CC 是 dim 引导语，pi 是红色报错 |
| P3 | 可做 | S | “(ctrl+o to expand)” 提示硬编码键名，用户改键后提示就是错的（且多了 CC 没有的斜体） |

---

## 7 · 派单

### 7.1 批次

七个批次里 **B0 必须单独先跑完**，其余按文件归属并行。文件重合度很高（`builtins.ts` / `diff.ts` / `grouping.ts` 三个文件占了全部缺陷的 70%），不按文件切会互相踩。

| 批次 | 主题 | 主要文件 | 条数 | 依赖 |
|---|---|---|---|---|
| **B0** | 止血：死循环 / 无限重绘 / 无上限读文件 / 类型崩溃 | `diff.ts` `palette.ts` `builtins.ts` | 4 | 无，**最先做，做完再开别的** |
| **B1** | 死代码复活 | `diff.ts` `mcp.ts` `collapse.ts` `commands.ts` | 6 | B0 |
| **B2** | 生命周期修正（turn/agent 边界、thinking 四层） | `turn-footer.ts` `spinner.ts` `thinking.ts` `grouping.ts` | 12 | B0；需先按第 3 节改 `ALIGNMENT.md` |
| **B3** | 分组与折叠 | `grouping.ts` `collapse.ts` `mcp.ts` | 14 | B1（MCP 层要先能注册） |
| **B4** | 文案与截断口径 | `builtins.ts` `collapse.ts` | 18 | B0 |
| **B5** | 宽度 / Unicode / 几何 | `diff.ts` `banner.ts` `builtins.ts` | 13 | B0 |
| **B6** | 视觉补齐（第 6 节的 P1 差距） | `spinner.ts` `banner.ts` `status-line.ts` `diff.ts` | 16 | B2 |

并行安排：B0 单跑 → 然后 (B1) → 然后 (B2 ∥ B4 ∥ B5) → 然后 (B3 ∥ B6)。同一批次内如果要再切开，按文件切，一个 agent 独占一个文件。

### 7.2 派单 prompt

把下面整段发给执行 agent，只替换 `{{批次}}` 和 `{{条目}}` 两处。

````text
你在 `/Users/bytedance/ai_coding/my_agents/pi_extension/better-claude-code-ui` 上工作。

这是一个 pi 终端 agent 的 UI 扩展，目标是在 pi 上复刻 Claude Code 的终端视觉。它刚做完一次全面审计，报告在仓库根目录 `AUDIT.md`。

## 你负责的批次

{{批次}}

具体条目：

{{条目}}

## 开工前必读

1. 读 `AUDIT.md` 的第 3 节（规格里的三处事实性错误）。**`ALIGNMENT.md` 和 `IMPLEMENTATION.md` 里有已知的错误前提，不要把它们当规格。** 冲突时以 `AUDIT.md` 为准，以 Claude Code 源码为最终依据。
2. 读你负责条目涉及的每个文件的全文（扩展总共 4493 行，单文件最大 957 行，读得完）。
3. 三个必须理解的外部事实：
   - pi 的 `turn` 是**一轮 agent 循环迭代**（一次 LLM 回复 + 其工具执行），不是一次用户请求。一次请求 = 1 个 `agent_start` + N 个 `turn_start`/`turn_end` + 1 个 `agent_end`（依据 `@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:43-131`）。
   - `c.invalidate()` 会无条件重跑 `renderCall` 和 `renderResult`，没有去重（依据 `pi-coding-agent/dist/modes/interactive/components/tool-execution.js:182-184, 228-263`）。任何在 render 里挂 promise 再 invalidate 的写法都必须有**不随 render 重置**的守卫。
   - pi 已经在工具层把 bash 输出截断到 50KB / 2000 行（`core/tools/truncate.js:10`）。渲染层不需要再防巨量 stdout，但**文件读取路径没有这个保护**。

## 参考源码

- Claude Code 原版：`/Users/bytedance/ai_coding/my_agents/claude-code-main/src`
  `.tsx` 是 React Compiler 编译产物，**每个文件末尾有一行超长 base64 sourceMappingURL，绝对不要 cat 整个文件**。取原始 TS 源码用：
  ```
  node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");const m=s.match(/base64,([A-Za-z0-9+/=]+)/);console.log(JSON.parse(Buffer.from(m[1],"base64").toString()).sourcesContent[0])' <file> | sed -n '1,200p'
  ```
  先用 `wc -l` 探大小，超过 600 行就配合 `sed -n 'A,Bp'` 截段。定位用 `grep -n`。
- pi 扩展 API：`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`（1298 行，可整读）
- pi 运行时：同目录 `dist/modes/interactive/`（`interactive-mode.js` 有 4900 行，用 grep 定位再读片段）
- pi-tui 组件：`node_modules/@earendil-works/pi-tui/dist/`

## 工作方式

- **每条独立提交**，commit message 写清 `AUDIT.md` 里的条目位置和改了什么。不要把多条揉进一个提交。
- 改之前先**在代码里确认那条描述属实**。审计报告的 `收敛` 列是有多少个独立视角发现了它，×5 以上基本可信，×1 的要自己先验证；发现报告写错了就说出来，不要将错就错地改。
- 每条改完给出**验证方式**：能写纯函数单测的就写（放 `test/`），不能的就写清楚"怎么在 pi 里目视确认"（具体到执行什么命令、看屏幕哪一行）。
- 类型检查必须过：
  ```
  npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck extension/index.ts
  ```
- 代码风格跟现有代码一致：**tab 缩进**；注释里引用依据时写成 `CC AssistantThinkingMessage.tsx:44` 或 `pi tool-execution.js:182` 这种 `文件:行号` 形式。

## 边界

- **只改分配给你的条目。** 顺手看到别的问题，写进最后的报告里，不要动手。
- 不要重构、不要改架构、不要引新依赖。
- 不要碰 `theme/*.json`（除非条目明确要求）。
- 不要改 `ALIGNMENT.md` / `IMPLEMENTATION.md`（那是单独一个批次的事）。

## 交付

一份中文报告：

1. 每条：改了什么（`file:line`）、为什么这么改、怎么验证的、验证结果。
2. 报告有误的条目：错在哪、你查到的实情、最终怎么处理。
3. 没改成的条目：卡在哪、需要什么才能推进。
4. 顺手发现但没动的问题清单。
````

### 7.3 验收

改完一轮后按这个顺序过一遍：

1. `npx tsc --noEmit …` 通过。
2. 起 pi 加载扩展，**写一个新文件** —— 这是 P0-1 和 P0-2 的共同触发点，不卡死、内存不涨就说明止血成功：
   ```
   pi -ne -e ./extension/index.ts --theme ./theme --use-theme claude-code-dark
   ```
3. 连续读 3 个文件 → 应出现 `Read 3 files (ctrl+o to expand)` 折叠行；Ctrl+O 展开后**不重复**；再按一次能收回去。
4. 跑一个 >30s 的请求 → 请求**结束时**只出现一条 `✻ Worked for Xs`，中途不出现。
5. 一次带 thinking 的请求 → 消息流里每个 thinking 块留一行折叠标签，spinner 行显示 `thinking` → `thought for Xs`。
6. 改一个 Go 文件 → diff 有语法高亮（B1 之后）。
7. `git log --oneline` 一条一条对得上 `AUDIT.md` 的条目。
