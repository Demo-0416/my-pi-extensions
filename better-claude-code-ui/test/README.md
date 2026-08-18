# 测试约定

## 运行

```bash
# 全部测试
npx tsx --test test/*.test.ts

# 单个文件
npx tsx --test test/smoke.test.ts
```

## 三层测试

1. **纯函数单测**：直接 `import { fn } from "../extension/xxx.js"`，喂输入断言输出。
   首选——diff 解析、宽度计算、文案格式化、palette 解析都走这条。
2. **渲染器测试**：`loadExtension()` 拿到 `pi.tools.get(name)`，调
   `renderCall/renderResult`，用 `plain(component, width)` 断言纯文本行。
   `makeToolCtx()` 造 ToolRenderContext，`invalidateCalls` 是 spy。
3. **事件流测试**：`pi.emit("tool_execution_start", {...})` 触发扩展的事件 handler，
   断言 `pi.ui.*` / `pi.appendedEntries` / 分组渲染结果。

## 基座文件

- `test/harness.ts` — `FakePi` / `FakeUI` / `FakeTheme` / `makeToolCtx` / `loadExtension` / `startSession`
- `test/helpers.ts` — `renderLines` / `plain` / `plainText` / `width` / `tick` / `waitFor`

## 规矩

- 一个条目一个测试文件：`test/<模块>-<短描述>.test.ts`，和修复提交一起进。
- 工具结果用 Anthropic content blocks 形状：`{ content: [{ type: "text", text: "..." }] }`，
  不是 `{ content: "..." }`（builtins.ts:131 resultText 只认数组）。
- footer/header 在 `session_start` 里才设置，测试先 `await startSession(pi)`。
- ESM 模块图有缓存：同一进程里 `loadExtension()` 共享扩展模块级状态。
  需要干净状态的测试放独立文件（node:test 每文件一个进程）。
- 事件 payload 字段对照 `pi-coding-agent/dist/core/extensions/types.d.ts:537-600`。
- 断言渲染文本用 `plain()`（剥 ANSI）；断言颜色用 `renderLines()` 看原始转义。
