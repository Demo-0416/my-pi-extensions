/**
 * AUDIT §2 P0-2 — builtins.ts:745 write 新文件的 invalidate 乒乓。
 *
 * 机制：write 新文件的 renderResult 每次渲染都重挂 warmHighlightCache().then(invalidate)。
 * 在真实 pi 里 c.invalidate() → updateDisplay() → 重新调用 renderResult（tool-execution.js
 * :182-184, 257），于是又挂一个 .then → 微任务 → 无限自激重渲染，TUI 卡死。
 *
 * 复现关键：先把这段代码对应的 (code, lang, theme) 预热进 highlightCache，这样
 * renderResult 里的 warmHighlightCache 是「缓存命中」，返回已 resolve 的 promise，
 * .then(invalidate) 会立刻在下一个微任务触发。本测试把 fake ctx.invalidate 接成
 * 「重新调用 renderResult」（复刻 pi 行为）并给迭代数封顶：
 *   - 修复前：每次重渲染都重挂 .then → 无限自激 → 撞封顶 → 断言失败。
 *   - 修复后：_wwkDone 守卫使第二次渲染不再重挂 → 收敛到极少次。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtension, FakePi, FakeTheme, startSession } from "./harness.js";
import { tick } from "./helpers.js";
import { warmHighlightCache } from "../extension/tools/diff.js";

test("write 新文件 renderResult 不产生无限 invalidate 自激循环", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await startSession(pi);
	const write = pi.tools.get("write");
	assert.ok(write, "write 工具已注册");

	const theme = new FakeTheme("claude-code-dark");
	const content = "const a = 1;\nconst b = 2;\n";
	const args = { path: "/tmp/brand-new-file.ts", content };
	// 与 renderResult 内部一致的预热 key：前 10 行、typescript、github-dark。
	const shown = content.slice(0, -1).split("\n").slice(0, 10).join("\n");
	await warmHighlightCache(shown, "typescript", "github-dark");

	const state: Record<string, unknown> = {};
	let renders = 0;
	const CAP = 100;
	let lastComponent: unknown = undefined;
	const result = { content: [{ type: "text", text: "" }] };

	const doRender = (): void => {
		renders += 1;
		if (renders > CAP) return; // 封顶：防止修复前的无限递归真的挂死进程
		const ctx: any = {
			state,
			lastComponent,
			invalidate: () => doRender(), // 复刻 pi：invalidate 重跑 renderResult
			toolCallId: "call-write-1",
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			isError: false,
			args,
		};
		lastComponent = write.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
	};

	doRender();
	for (let i = 0; i < 20; i += 1) await tick();

	assert.ok(renders <= CAP, `renderResult 自激重渲染失控：跑了 ${renders} 次（撞上封顶 ${CAP}）`);
	assert.ok(renders <= 5, `预期收敛到极少次渲染，实际 ${renders} 次`);
});
