/**
 * AUDIT §4 / §5 ×2 P1 dead-code — diff.ts:444 shiki 导出名写错。
 *
 * @shikijs/cli 导出的是 codeToANSI（ANSI 全大写），代码却读 codeToAnsi，
 * `typeof codeToAnsi !== "function"` 恒真 → warmHighlightCache 一直走
 * `code.split("\n")` 纯文本降级，语法高亮 100% 从未生效过。
 *
 * 修复后：对受支持语言 warm 一次，缓存里落的应是带 ANSI SGR 的高亮行，
 * 而不是原样纯文本。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmHighlightCache, shikiHighlighter, clearHighlightCache } from "../extension/tools/diff.js";

const ANSI = /\x1b\[[0-9;]*m/;

test("warmHighlightCache 对 typescript 产出带 ANSI 的高亮（不再降级纯文本）", async () => {
	clearHighlightCache();
	const code = "const x = 1;\nfunction f() { return x; }";
	const rows = await warmHighlightCache(code, "typescript", "github-dark");
	assert.equal(rows.length, 2, "行数应与源码行数一致");
	// 修复前：codeToAnsi 取不到 → 返回 code.split("\n")，两行都是裸文本，无任何 SGR。
	// 修复后：codeToANSI 生效 → 至少有一行带 ANSI 转义。
	assert.ok(rows.some((r) => ANSI.test(r)), "高亮行必须带 ANSI SGR，否则说明仍在走纯文本降级");
});

test("shikiHighlighter 能命中 warm 落盘的高亮缓存", async () => {
	clearHighlightCache();
	const code = "let y = 2;";
	await warmHighlightCache(code, "typescript", "github-dark");
	const hl = shikiHighlighter("github-dark");
	const out = hl(code, "typescript");
	assert.ok(out !== undefined, "warm 之后同 key 查询必须命中");
	assert.ok(out!.some((r) => ANSI.test(r)), "命中的应是高亮行");
});

test("未知语言仍安全降级为纯文本（无 highlighter 崩溃）", async () => {
	clearHighlightCache();
	const rows = await warmHighlightCache("plain text line", undefined, "github-dark");
	assert.deepEqual(rows, ["plain text line"]);
});
