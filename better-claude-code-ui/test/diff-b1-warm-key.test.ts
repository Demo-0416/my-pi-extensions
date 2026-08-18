/**
 * AUDIT §5 ×2 P1 dead-code — diff.ts:646 warm/query key 不匹配。
 *
 * 旧写法：builtins 用 warmHighlightCache(整份文件内容/整份 newCombined) 预热，
 * 但 renderUnified/renderSplit 查询的是「按行类型分侧后 join 的 hunk 片段」——
 * 两个字符串永远不同 → 缓存恒 miss；而且只喂新侧，old（del/ctx）侧从头到尾
 * 没被 warm 过，上下文行永远高亮不了。
 *
 * 修复：diff.ts 导出 warmDiffHighlight，预热两种布局各自会查询的分侧 join 串。
 * 断言：warm 之后，renderUnified 用 shikiHighlighter 查询能命中（结果带 ANSI），
 * 且 old 侧（del/ctx）也命中——证明两侧都被预热。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseDiff,
	warmDiffHighlight,
	shikiHighlighter,
	renderUnified,
	clearHighlightCache,
	MAX_PREVIEW_LINES,
} from "../extension/tools/diff.js";
import { resolvePalette } from "../extension/palette.js";

const ANSI = /\x1b\[[0-9;]*m/;
const P = resolvePalette("claude-code-dark", () => undefined);

// 一段真实改动：改一行、上下文若干行，让 old 侧（ctx+del）与 new 侧（ctx+add）
// join 出来的串各不相同。
const OLD = ["import a from 'a';", "const x = 1;", "function f() {", "  return x;", "}"].join("\n");
const NEW = ["import a from 'a';", "const x = 2;", "function f() {", "  return x + 1;", "}"].join("\n");

test("warmDiffHighlight 预热的正是 renderUnified 会查询的分侧串（含 old 侧）", async () => {
	clearHighlightCache();
	const diff = parseDiff(OLD, NEW);
	await warmDiffHighlight(diff, { maxLines: MAX_PREVIEW_LINES, language: "typescript", theme: "github-dark" });

	// 复刻 renderUnified 的分侧逻辑，验证两侧 join 串都已命中缓存。
	const oldSrc: string[] = [];
	const newSrc: string[] = [];
	for (const line of diff.lines.slice(0, MAX_PREVIEW_LINES)) {
		if (line.type === "ctx" || line.type === "del") oldSrc.push(line.content);
		if (line.type === "ctx" || line.type === "add") newSrc.push(line.content);
	}
	const hl = shikiHighlighter("github-dark");
	const oldHit = hl(oldSrc.join("\n"), "typescript");
	const newHit = hl(newSrc.join("\n"), "typescript");
	assert.ok(oldHit !== undefined, "old 侧（del+ctx）必须命中缓存——修复前从不预热");
	assert.ok(newHit !== undefined, "new 侧（add+ctx）必须命中缓存");
	assert.ok(oldHit!.some((r) => ANSI.test(r)), "old 侧命中的应是高亮行");
	assert.ok(newHit!.some((r) => ANSI.test(r)), "new 侧命中的应是高亮行");
});

test("warm 后 renderUnified 的上下文行带语法高亮（不再纯文本降级）", async () => {
	clearHighlightCache();
	const diff = parseDiff(OLD, NEW);
	await warmDiffHighlight(diff, { maxLines: MAX_PREVIEW_LINES, language: "typescript", theme: "github-dark" });
	const rows = renderUnified(P, diff, 80, {
		language: "typescript",
		highlight: shikiHighlighter("github-dark"),
		maxLines: MAX_PREVIEW_LINES,
	});
	// 找到上下文行 `function f() {`（未改动、两侧都有）。它属于 old+new 侧的 join，
	// warm 命中后应带 shiki 的 24-bit 前景色 SGR（38;2;...）。
	const ctxRow = rows.find((r) => r.includes("function"));
	assert.ok(ctxRow !== undefined, "应渲染出含 function 的上下文行");
	assert.ok(/\x1b\[38;2;/.test(ctxRow!), "上下文行必须带 shiki 24-bit 前景高亮，证明缓存命中");
});

test("未 warm 时 renderUnified 安全降级（不抛、不高亮）", () => {
	clearHighlightCache();
	const diff = parseDiff(OLD, NEW);
	const rows = renderUnified(P, diff, 80, {
		language: "typescript",
		highlight: shikiHighlighter("github-dark"),
		maxLines: MAX_PREVIEW_LINES,
	});
	assert.ok(rows.length > 0, "无缓存也应正常渲染");
});
