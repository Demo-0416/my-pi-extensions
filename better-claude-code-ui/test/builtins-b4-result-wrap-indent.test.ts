/**
 * AUDIT §5 ×2 P1 builtins.ts:241 — `⎿` 结果体的续行缩进。
 *
 * 修复前：结果体交给 pi-tui Text(paddingX=0) 渲染，长逻辑行按词换行时续行
 * 掉回第 0 列，破坏 `⎿  ` 5 列悬挂缩进。修复后 CachedTextComponent 自己做
 * 宽度感知换行：固定 5 列 gutter，词换行续行重新缩进到第 5 列。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plain } from "./helpers.js";

test("单行超长结果：词换行续行缩进到第 5 列，不掉回第 0 列", async () => {
	const pi = await loadExtension();
	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();

	// 一行超过 40 列的输出，强制在窄终端换行。
	const longLine = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
	const { ctx } = makeToolCtx({ args: { command: "echo x" }, expanded: false });
	const comp = bash.renderResult(
		{ content: [{ type: "text", text: longLine }] },
		{ expanded: false, isPartial: false },
		theme,
		ctx,
	);
	const lines = plain(comp, 40);
	assert.ok(lines.length >= 2, `应换成多行，实际 ${lines.length} 行:\n${lines.join("\n")}`);
	// 第 0 行是 `  ⎿  <content>`；后续续行必须以 5 个空格开头。
	assert.match(lines[0]!, /^ {2}⎿ {2}\S/, `首行应带 ⎿ lead:\n${lines[0]}`);
	for (let i = 1; i < lines.length; i++) {
		assert.match(lines[i]!, /^ {5}\S/, `续行 ${i} 应缩进到第 5 列:\n[${lines[i]}]`);
	}
});

test("多行结果里的长行：每条逻辑行的续行都缩进到第 5 列", async () => {
	const pi = await loadExtension();
	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();

	const text = "short line one\nthis is a very long second line that definitely needs to wrap across the terminal width boundary here";
	const { ctx } = makeToolCtx({ args: { command: "echo x" }, expanded: false });
	const comp = bash.renderResult(
		{ content: [{ type: "text", text }] },
		{ expanded: false, isPartial: false },
		theme,
		ctx,
	);
	const lines = plain(comp, 40);
	// 任何不是首行、且非空的续行都不应从第 0 列的可见字符起头（除非本就是逻辑行首）。
	// 检查：不存在“可见字符出现在第 0-4 列”的续行（首行除外）。
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "") continue;
		// 逻辑行首（短行 short line one）也应保持在第 5 列，因为结果体统一缩进。
		assert.match(line, /^ {5}/, `行 ${i} 应至少缩进 5 列:\n[${line}]`);
	}
});
