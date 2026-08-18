/**
 * AUDIT §2 P0-4 — builtins.ts:750 / :270 cachedText/makeText 类型崩溃。
 *
 * write 新文件的结果行 Ctrl+O 展开会走 DiffCardComponent 分支（expanded=true），
 * 再收起（expanded=false）时 c.lastComponent 是上一次的 DiffCardComponent，
 * cachedText 无类型校验地 (last as CachedTextComponent).setText(...) → TypeError，
 * 结果行退化成 pi 兜底原文。
 *
 * 修复后：cachedText/makeText 用 instanceof 校验，类型不符就新建组件，不再抛。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtension, FakePi, FakeTheme, startSession } from "./harness.js";
import { plainText } from "./helpers.js";

test("write 新文件 展开→收起 不抛 TypeError（cachedText 类型校验）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await startSession(pi);
	const write = pi.tools.get("write");
	assert.ok(write, "write 工具已注册");

	const theme = new FakeTheme("claude-code-dark");
	const content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
	const args = { path: "/tmp/p0-4-new.ts", content };
	const result = { content: [{ type: "text", text: "" }] };
	const mkCtx = (expanded: boolean, lastComponent: unknown): any => ({
		state: {}, lastComponent, invalidate: () => {}, toolCallId: "call-p0-4",
		cwd: process.cwd(), executionStarted: true, argsComplete: true, isPartial: false,
		expanded, isError: false, args,
	});

	// 1) 折叠渲染（新文件预览分支，CachedTextComponent）。
	const collapsed1 = write.renderResult(result, { expanded: false, isPartial: false }, theme, mkCtx(false, undefined));
	// 2) 展开渲染（DiffCardComponent 分支）。
	const expanded = write.renderResult(result, { expanded: true, isPartial: false }, theme, mkCtx(true, collapsed1));
	// 3) 再折叠：lastComponent 现在是 DiffCardComponent —— 这一步修复前抛 TypeError。
	let collapsed2: unknown;
	assert.doesNotThrow(() => {
		collapsed2 = write.renderResult(result, { expanded: false, isPartial: false }, theme, mkCtx(false, expanded));
	}, "cachedText 收到 DiffCardComponent 作为 last 时不应抛");

	// 渲染出来仍是正常的 "Wrote N lines" 结果行，而不是崩坏。
	const text = plainText(collapsed2, 100);
	assert.match(text, /Wrote\s+3\s+lines to/, `收起后应正常渲染结果行，实际:\n${text}`);
});
