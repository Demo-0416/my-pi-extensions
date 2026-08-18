/**
 * AUDIT §5 ×2 P2 builtins.ts:120 — Bash 头部 detail 按可见宽度截断，不劈代理对/CJK。
 *
 * 修复前用 command.length（UTF-16 码元）判断和 slice，中文命令能撑到 320 列，
 * 且会把 emoji 代理对/CJK 从中间切开。改为用 visibleWidth + truncateToWidth
 * (grapheme-safe，ellipsis 计入预算)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plain, width } from "./helpers.js";

/** 取 bash 头一行的括号内 detail，去掉 Text 补齐的行尾空格。 */
function bashDetail(pi: FakePi, theme: FakeTheme, cmd: string): string {
	const bash = pi.tools.get("bash")!;
	const { ctx } = makeToolCtx({ args: { command: cmd } });
	// 用很宽的宽度渲染，避免换行；再逐行 trimEnd 去掉补齐空格后拼回。
	const joined = plain(bash.renderCall({ command: cmd }, theme, ctx), 1000)
		.map((l) => l.replace(/\s+$/, ""))
		.join("");
	return joined.replace(/^.*?Bash\(/, "").replace(/\)$/, "");
}

test("中文 bash 命令头：可见宽度不超过 160 列（含省略号）", async () => {
	const pi = await loadExtension();
	const theme = new FakeTheme();
	// 200 个中文字符 = 400 可见列，远超 160。
	const cmd = "echo " + "中".repeat(200);
	const inner = bashDetail(pi, theme, cmd);
	assert.ok(width(inner) <= 160, `detail 可见宽度应 ≤160，实际 ${width(inner)}:\n${inner}`);
	assert.match(inner, /…$/, "应以 … 结尾");
});

test("emoji 命令头截断不产生半个代理对（可见宽度守恒）", async () => {
	const pi = await loadExtension();
	const theme = new FakeTheme();
	const cmd = "echo " + "😀".repeat(120); // 每个 emoji 宽 2 → 240 列
	const inner = bashDetail(pi, theme, cmd);
	assert.ok(width(inner) <= 160, `detail 可见宽度应 ≤160，实际 ${width(inner)}`);
	// 不应含 U+FFFD 替换字符（半个代理对被转义的迹象）。
	assert.doesNotMatch(inner, /�/, "不应出现替换字符（劈开代理对）");
});

test("短命令不受影响（无截断，不加省略号）", async () => {
	const pi = await loadExtension();
	const theme = new FakeTheme();
	const inner = bashDetail(pi, theme, "ls -la");
	assert.equal(inner, "ls -la", `短命令应原样显示，实际:[${inner}]`);
});
