/**
 * 结果体预览的行数预算必须按「折行后的视觉行」算，不是「逻辑行」。
 *
 * 现场：`grep -rn ... dist/` 打到 bundle 文件 —— pi 已按 50KB/2000 行截断，
 * 交到渲染器手上只剩 2 个逻辑行，但每行几万字符。旧代码 PREVIEW_LINES=8 数的是
 * 逻辑行，于是 8 行预算 = 无预算，实测 width 100 下渲染出 654 行、heapΔ 27.9MB
 * （pi 自带 bash 渲染器同一输入只出 5 行）。
 *
 * CC 早年踩过同一个坑（"64MB binary dumps that cause 382K-row screens"，
 * src/utils/terminal.ts:83），修法是两道闸：
 *   1. 预算按视觉行，长行按宽度硬切（terminal.ts:19-60 wrapText）；
 *   2. 折行前先 slice 到 rows*wrapWidth*4，剩余量由长度估算（terminal.ts:85-99）。
 * 本文件锁住这两道闸。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plain, renderLines, width } from "./helpers.js";

/** pi bash 工具的输出上限：last 2000 行 / 50KB（core/tools/truncate.js:10-11）。 */
const PI_MAX_BYTES = 50 * 1024;

test("minified 长行：折叠态行数受视觉行预算约束，不随输出长度爆炸", async () => {
	const pi = await loadExtension();
	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();

	// 复刻现场：2 个逻辑行、总量顶到 pi 的 50KB 上限。
	const text = [`dist/index.js:1:${"x".repeat(PI_MAX_BYTES / 2)}`, `dist/cli.js:1:${"y".repeat(PI_MAX_BYTES / 2)}`].join("\n");

	for (const w of [80, 100, 120]) {
		const { ctx } = makeToolCtx({ args: { command: 'grep -rn "foo" dist/' }, expanded: false });
		const comp = bash.renderResult(
			{ content: [{ type: "text", text }] },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		const rows = renderLines(comp, w);
		// 预算 8 行 + 1 行提示，留一点余量应对 remaining===1 的多显示一行。
		assert.ok(rows.length <= 11, `width ${w}: 折叠态渲染 ${rows.length} 行，应 ≤ 11（修复前是 654 行）`);
		for (const line of rows) {
			assert.ok(width(line) <= w, `width ${w}: 行宽 ${width(line)} 超限: ${JSON.stringify(line.slice(0, 80))}`);
		}
	}
});

test("50KB 单行：折行前预截断，渲染耗时与行数都不跟输出长度走", async () => {
	const pi = await loadExtension();
	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();

	const short = `dist/a.js:1:${"x".repeat(2_000)}`;
	const huge = `dist/a.js:1:${"x".repeat(PI_MAX_BYTES)}`;

	const rowsFor = (text: string) => {
		const { ctx } = makeToolCtx({ args: { command: "cat dist/a.js" }, expanded: false });
		const comp = bash.renderResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: false }, theme, ctx);
		return renderLines(comp, 100).length;
	};

	// 输出放大 25 倍，行数不应跟着涨 —— 证明 maxChars 预截断生效。
	assert.equal(rowsFor(short), rowsFor(huge), "预算应与输出长度无关");
});

test("展开态也有天花板：单个 minified 行不得展开成几百行", async () => {
	const pi = await loadExtension();
	const theme = new FakeTheme();
	const blob = "z".repeat(20_000);

	for (const name of ["bash", "read", "grep", "find", "ls"] as const) {
		const tool = pi.tools.get(name)!;
		const args = name === "bash" ? { command: "c" } : name === "read" ? { path: "a.js" } : { pattern: "p", path: "." };
		const { ctx } = makeToolCtx({ args, expanded: true });
		const comp = tool.renderResult(
			{ content: [{ type: "text", text: blob }] },
			{ expanded: true, isPartial: false },
			theme,
			ctx,
		);
		const rows = renderLines(comp, 100);
		// MAX_RENDER_LINES=150 是展开态上限；修复前每个工具都吐 212 行。
		assert.ok(rows.length <= 152, `${name} 展开态渲染 ${rows.length} 行，应 ≤ 152`);
	}
});

test("流式态保留尾部窗口（CC ShellProgressMessage.tsx:44 lines.slice(-5)）", async () => {
	const pi = await loadExtension();
	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();

	const lines = Array.from({ length: 40 }, (_, i) => `progress ${i}`);
	const { ctx } = makeToolCtx({ args: { command: "make" }, isPartial: true });
	const comp = bash.renderResult(
		{ content: [{ type: "text", text: lines.join("\n") }] },
		{ expanded: false, isPartial: true },
		theme,
		ctx,
	);
	const text = plain(comp, 100).join("\n");
	// 运行中要看最新的输出 —— 尾部在、头部不在。
	assert.match(text, /progress 39/, `流式态应显示最新行:\n${text}`);
	assert.doesNotMatch(text, /progress 0\b/, `流式态不应显示最早的行:\n${text}`);
	assert.ok(plain(comp, 100).length <= 7, `流式态应是 5 行窗口 + 状态行，实际 ${plain(comp, 100).length} 行`);
});

test("流式态 minified 行同样受视觉行约束", async () => {
	const pi = await loadExtension();
	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();

	const { ctx } = makeToolCtx({ args: { command: "cat bundle.js" }, isPartial: true });
	const comp = bash.renderResult(
		{ content: [{ type: "text", text: "q".repeat(PI_MAX_BYTES) }] },
		{ expanded: false, isPartial: true },
		theme,
		ctx,
	);
	const rows = renderLines(comp, 100);
	assert.ok(rows.length <= 7, `流式 minified 行渲染 ${rows.length} 行，应 ≤ 7`);
	for (const line of rows) {
		assert.ok(width(line) <= 100, `行宽 ${width(line)} 超限`);
	}
});
