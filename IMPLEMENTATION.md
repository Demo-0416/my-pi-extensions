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

### M9 — React 前端（vendor dsh ui-trajectory）

前端打翻重做，直接 vendor dsh `ui-trajectory` 源码（MIT），esbuild 预构建为自包含 bundle。

| 文件 | 内容 | 来源 |
|---|---|---|
| `src/web/vendor/` | dsh ui-trajectory 客户端源码（layout/timeline/record/preview/search-index/virtual-rows + Table/Timeline/Toolbar/Cell/Turn 组件 + CSS modules） | dsh `packages/client/ui-trajectory`（MIT） |
| `src/web/primitives/` | dsh ui-primitives 子集（markdown 渲染器、JsonTree、Tooltip、SVG 图标） | dsh `packages/client/ui-primitives`（MIT） |
| `src/web/adapter.ts` | pi `TraceSession` JSON → dsh layout 输入（nodes/requests/partial/runningCalls/callSchemas） | 自写 |
| `src/web/host.tsx` | 视图入口：状态管理 + SSE + 会话选择 + 统计栏，渲染 dsh Table/Timeline/Toolbar | 自写（状态逻辑移植自 dsh `TrajectoryView.tsx`） |
| `src/web/build.mjs` | esbuild 构建 + 自写 CSS Modules 插件（类名加 `dsh-<file>-` 前缀，运行时注入 `<style>`） | 自写 |
| `src/web/theme.css` | dsh 设计 token 赋值（`--dsw-*`/`--ds-*`/`--dsl-*`，亮色主题） | 自写 |

**构建**：`cd src/web && npm install && npm run build` → `src/web/dist/`（自包含 ESM bundle + 懒加载 grammar chunks）。server 直接 serve `dist/`。

**dsh 依赖处理**：ui-trajectory 对 dsh 自家包的依赖全是 `import type`（构建时擦除）；真实运行时依赖只有 react、@tanstack/react-virtual、diff、shiki、katex、micromark 生态（全部公开 npm）。

### Collector 数据补全（M9）

为喂饱 dsh layout，collector 在 M8 基础上补采：

| 字段 | 来源 | dsh 对应 |
|---|---|---|
| `thinking` | assistant 消息的 `ThinkingContent` 块 | `thinkingDetail` / Reasoning 区块 |
| `toolCalls` | assistant 消息的 `ToolCall` 块（callId/name/argsRaw） | `AssistantBlock` tool-call |
| `requestConfig` | `before_provider_request` payload（model/temperature/thinking/stop） | `requestConfig` / Options tab |
| `promptSnapshot` | `before_provider_request` payload（system + tools 含 schema） | `promptDetail` / System Prompt+Tools tab |
| `toolSchemas` | `before_provider_request` payload 的 tools 数组 | `callSchemas` / Schema tab |
| `callId` | `tool_execution_start` 的 toolCallId | `callId`（跨记录跳转） |
| `source` | `input` 事件（interactive/rpc/extension） | `messageSource` / Source tab |
| `fullText` | assistant/user 完整正文（8KB 截断） | `previewMarkdown`/`outputDetail` |
| `usage.reasoning` | pi usage 的 reasoning tokens | `reasoningTokens` |

### 视觉 + 交互（dsh 原生）

- **甘特图**：3 泳道（Input/Model/Tools），4 种投影（sequence/duration/time/actual），滚轮缩放（锚定光标）、右键平移、框选边缘平移、hover 竖线、TTFT 渐变刻度、turn 边界、span 状态机
- **流水账**：turn → group（Message/Step N）→ cell，kindTag 彩色 pill，tool 行内联结果预览，请求边界 + LLM 编号（含累计 usage），turn + assistant 双层折叠
- **详情面板**：按 kind 出 tab——user/assistant = Summary/Preview/Raw/Source；tool = Summary/Payload/Result/Schema/Timing；system = System Prompt/Tools/Diff；markdown 渲染（shiki 高亮 + katex）、JsonTree、跨记录跳转
- **搜索**：实时全文索引（3s 节流），时间线 span 联动高亮
- **流式**：partial assistant + runningCalls 实时追加

### M10 — TUI

- **widget 统计行**（`ctx.ui.setWidget("pi-trace", ..., {placement:"aboveEditor"})`）：`✻ N 轮 · LLM 3m09s · 工具 0.5s · 47 tok/s · 缓存 81% · $0.12`，`turn_end`/`tool_execution_end` 刷新
- **`/trace`**：`pi.exec("open", [url])` 打开当前会话网页
- **`/trace pick`**：`ctx.ui.select` 列出历史会话（cwd/时间/turn 数/精度），选完打开

## 未实现 / 暂缓

| 项 | 原因 |
|---|---|
| 全屏 TUI 轨迹（`ctx.ui.custom()`） | DESIGN 3.10 明确暂缓 |
| dsh 的 load older history 分页 | pi 侧 sidecar 全量加载，会话量级不需要 |
| dsh 的 inspect 跨视图深链 | 本扩展无 chat 视图，不需要 |
| 图片消息块 | pi 支持 ImageContent，adapter 目前只取 text；v2 |
| subtool 嵌套调用 | pi 无 run_code 式嵌套分发，不需要 |

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
- **运行时零 npm 依赖（后端）**：server 用 node:http；前端依赖在 `src/web/package.json`，构建后 bundle 自包含

## 安全边界

- server 仅绑 `127.0.0.1`，无鉴权（localhost 信任模型）
- `/api/from-file` 的 path 必须 resolve 后位于 `~/.pi/agent/sessions/` 内，否则 403（`path.relative` 校验）
- tool args/result 落 sidecar 前截断（单字段 ≤ 8KB）
- sidecar 权限 0600
- `server.unref()`：不阻止 print 模式进程退出
