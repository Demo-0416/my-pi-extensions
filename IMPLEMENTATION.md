# pi-trace 实现说明

仿 deepseek-harness 轨迹页的 pi 扩展（Web+SSE 为主，TUI widget 为辅）。按 `DESIGN.md` 第 3 节实现。

## 已实现

### M8 — trace 核心

| 文件 | 内容 | 来源 |
|---|---|---|
| `src/model.ts` | `TraceSession`/`TraceTurn`/`TraceRecord` 类型（3.2） | DESIGN 3.2 |
| `src/collector.ts` | pi 事件流 → `TraceRecord`（3.3 事件映射表） | 自写（pi 事件映射无参考） |
| `src/store.ts` | sidecar JSONL（`~/.pi/agent/traces/<id>.jsonl`），0600，单字段 8KB 截断，首行 meta 信封 | 自写 |
| `src/session-loader.ts` | 历史 session JSONL 重建（3.7 启发式，`reconstructed` 精度） | 自写 |
| `src/stats.ts` | 3.6 统计口径（轮数/步数/LLM 时长/工具时长/TTFT/tok-s/缓存命中/费用） | DESIGN 3.6 |
| `src/server.ts` | node:http + SSE（3.8 路由），只绑 127.0.0.1，43110 占用递增，`.port` 文件 | 自写 |
| `src/web/` | 无构建 vanilla JS ESM 前端 | 自写 |

### M9 — 甘特图 + 统计栏 + 历史回放 + 搜索

| 文件 | 内容 | 移植来源 |
|---|---|---|
| `src/web/timeline.js` | 4 泳道甘特投影 + 渲染 + 交互 | dsh `timeline.ts`（投影算法逐行移植）、`TrajectoryTimeline.tsx`（缩放/平移/框选/hover） |
| `src/web/ledger.js` | 按 Turn 分组流水账 + 虚拟滚动 + 搜索 | dsh `trajectory-search-index.ts`（搜索）、`trajectory-virtual-rows.ts`（虚拟滚动） |
| `src/web/format.js` | 格式化工具 | dsh `trajectory-record.ts`（`formatDurationMillis` 等同名函数） |

4 泳道（DESIGN 3.4）：Duration 灰 / Turns 蓝绿交替 / LLM Calls 紫（TTFT 渐变刻度）/ Tools 橙（错误红）。

### 视觉 + 交互对齐 dsh

- **kindTag 彩色 pill 徽章**（背景晕染 + 圆角 + 650 字重，dsh `TrajectoryCell.module.css` 配色语义）
- **turn rail 竖向连接线** + turn 计数角标（dsh `turnRail`/`turnLabel`）
- **行内 model/TTFT/tok-s 指标**、工具图标（dsh assistant cell metrics）
- **system prompt 采集**（对齐 dsh SYSTEM 记录的 `promptDetail`）：`before_agent_start` 采完整 system prompt + 工具目录快照，`TraceRecord.prompt` 字段独立 8KB 截断
- **流式 cell**：`before_provider_request` 创建进行中的 assistant 记录并广播（不落盘），`message_end` 闭合（对齐 dsh `runningCalls`/`partial`）
- **甘特交互**：滚轮缩放（锚定光标）、右键平移、框选边缘平移、hover 竖线、span 状态机（selected/current/hovered/search-match/dim）、双击/Escape 清除、单击空白居中最小选区并聚焦最近记录
- **运行中脉冲**动画

### M10 — TUI

- **widget 统计行**（`ctx.ui.setWidget("pi-trace", ..., {placement:"aboveEditor"})`）：`✻ N 轮 · LLM 3m09s · 工具 0.5s · 47 tok/s · 缓存 81% · $0.12`，`turn_end`/`tool_execution_end` 刷新
- **`/trace`**：`pi.exec("open", [url])` 打开当前会话网页
- **`/trace pick`**：`ctx.ui.select` 列出历史会话（cwd/时间/turn 数/精度），选完打开

## 未实现 / 暂缓

| 项 | 原因 |
|---|---|
| `sequence`/`actual` 投影模式 | DESIGN 3.4 标注 v2；投影代码已移植，UI 只暴露 duration/time |
| 全屏 TUI 轨迹（`ctx.ui.custom()`） | DESIGN 3.10 明确暂缓 |
| dsh 的 prompt diff（前后快照对比） | dsh `previousPromptDetail`；pi 侧无直接对应，v2 |
| dsh 的 tool schema 详情 | `schemaDetail`；pi 侧可从 `pi.getAllTools()` 补，v2 |
| markdown 渲染（dsh 用 MarkdownText） | 前端用 `<pre>` 纯文本，v2 |
| 甘特滚轮缩放的触屏/触控板惯性 | dsh 也只处理 wheel |

## 测试方法

### 1. 加载扩展

项目级 `.pi/settings.json` 已配好（本目录），pi 启动时自动加载：

```bash
cd /Users/bytedance/wailmer/workspaces/pi_extension/pi-trace-impl
pi
```

全局加载（DESIGN 1 的方式）：在 `~/.pi/settings.json` 的 `extensions` 数组加
`"/Users/bytedance/wailmer/workspaces/pi_extension/pi-trace-impl/src/index.ts"`，然后 `/reload`。

### 2. 打开网页

```bash
# TUI 里输入
/trace           # 打开当前会话
/trace pick      # 选历史会话
```

或直接浏览器访问 `http://127.0.0.1:43110/`（端口被占时递增，实际端口见 `~/.pi/agent/traces/.port`）。

### 3. 造会话数据验证甘特图和统计

在 pi 里正常对话（让模型调几个工具），然后 `/trace` 打开网页：

- **甘特图**：4 泳道，Turns 蓝绿交替，LLM Calls 紫色 span 带 TTFT 浅色刻度，Tools 橙色（失败红色）
- **统计栏**：`N 轮 · M 步 · LLM Xs · 工具 Ys · 首 token 平均 Zs · A tok/s · 缓存命中 B% · 输入 CK tok · 输出 DK tok · $E`
- **流水账**：按 Turn 分组，pill 徽章，点击行展开详情（system prompt / tool args+result / assistant usage+timing）
- **搜索**：顶栏搜索框，纯前端过滤（tool 名、命令、文本）
- **框选**：甘特图上拖拽，流水账只显示落在区间内的记录；双击或 Esc 清除
- **缩放**：甘特图上滚轮缩放，右键拖拽平移

### 4. 历史会话回放

网页顶栏下拉框选历史会话：
- 有 sidecar 的标记 `rich`（精确时长/TTFT）
- 无 sidecar 的标记 `reconstructed`（从 session JSONL 推断，TTFT 显示 `—`）

### 5. 冒烟测试

```bash
node scripts/smoke-m8.mjs
```

覆盖：重建（turn 切分/tool args 关联/duration 推断）、采集（TTFT/工具闭合/sidecar 落盘）、HTTP API（sessions/session/from-file/SSE/静态资源）、安全边界（/etc/passwd → 403）。

## 架构

```
pi 事件流
   │
   ▼
Collector ──► TraceRecord ──► sidecar JSONL（~/.pi/agent/traces/<id>.jsonl）
   │                                │
   ├─► TUI Widget（统计行）          │
   ▼                                ▼
HTTP + SSE Server（127.0.0.1:43110）◄─ 历史 session JSONL 回放（降级精度）
   │
   ▼
Web 前端：甘特图（4 泳道）+ 统计栏 + 按 Turn 分组流水账 + 搜索
```

- **采集与展示分离**：Collector 只认 pi 事件，输出统一 TraceRecord
- **sidecar 而非 session 文件**：富时序数据不污染 session JSONL，不进 LLM 上下文
- **两级精度**：sidecar 存在 = rich；不存在 = 从 session JSONL 重建
- **运行时零 npm 依赖**：server 用 node:http，前端无构建 vanilla JS ESM

## 安全边界

- server 仅绑 `127.0.0.1`，无鉴权（localhost 信任模型）
- `/api/from-file` 的 path 必须 resolve 后位于 `~/.pi/agent/sessions/` 内，否则 403（`path.relative` 校验）
- tool args/result 落 sidecar 前截断（单字段 ≤ 8KB）
- sidecar 权限 0600
- `server.unref()`：不阻止 print 模式进程退出
