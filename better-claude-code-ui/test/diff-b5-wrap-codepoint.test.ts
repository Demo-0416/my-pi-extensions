/**
 * AUDIT §5 ×3 P1 layout-width diff.ts:197 + ×2 P2 formatting diff.ts:248 —
 * wrapAnsi 按 UTF-16 码元计宽/推进。两个后果：
 *
 *  1) CJK 行既不换行又被二次加宽：一行 40 个汉字 .length=40 ≤ codeWidth
 *     被判「不用换行」，但实际渲染 80 列，撑破 diff 卡片（列数翻倍）。
 *  2) 换行点把 emoji 的代理对（surrogate pair）劈成两半，留下孤立高位代理。
 *
 * 修复：wrapAnsi 改按 cell（grapheme + 零宽 ANSI）推进，用 visibleWidth 计宽。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderUnified, type ParsedDiff } from "../extension/tools/diff.js";
import { resolvePalette } from "../extension/palette.js";

const P = resolvePalette("claude-code-dark", () => undefined);

test("CJK add 行按显示宽度换行，任一渲染行都不超过卡片宽度", () => {
	// 80 个汉字 = 显示 160 列，.length 只有 80。在 120 列卡片（codeWidth 113、
	// maxRows 2）里必须折行。宽度 <120 时 adaptiveWrapRows=1 是设计内截断，
	// 不在本测试范围。
	const cjk = "宽".repeat(80);
	const diff: ParsedDiff = {
		added: 1,
		removed: 0,
		chars: cjk.length,
		lines: [{ type: "add", oldNum: null, newNum: 1, content: cjk }],
	};
	const rows = renderUnified(P, diff, 120);
	for (const r of rows) {
		const w = visibleWidth(stripTerminalSequences(r));
		assert.ok(w <= 120, `渲染行不得超过卡片宽度 120，实际 ${w}:\n${stripTerminalSequences(r)}`);
	}
	// 而且内容确实被折成了多行（不是被截断丢弃）。
	const bodyRows = rows.filter((r) => stripTerminalSequences(r).includes("宽"));
	assert.ok(bodyRows.length >= 2, `80 个汉字在 120 列卡片里应折成 ≥2 行，实际 ${bodyRows.length} 行`);
});

test("换行点不劈裂 emoji 代理对（无孤立高位代理）", () => {
	// 一串 emoji，每个 emoji 显示 2 列。够长以在窄卡片里触发折行 + 末行截断。
	const emojis = "😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘😗😙😚";
	const content = `x = "${emojis}"`;
	const diff: ParsedDiff = {
		added: 1,
		removed: 0,
		chars: content.length,
		lines: [{ type: "add", oldNum: null, newNum: 1, content }],
	};
	const rows = renderUnified(P, diff, 24);
	for (const r of rows) {
		const plain = stripTerminalSequences(r);
		for (const ch of plain) {
			const code = ch.charCodeAt(0);
			// for...of 按 code point 迭代：完整代理对出来是 length 2 的字符串，
			// 孤立代理才是 length 1 且落在 D800-DFFF。
			assert.ok(
				!(code >= 0xd800 && code <= 0xdfff && ch.length === 1),
				`渲染行含被劈裂的代理: U+${code.toString(16)} 于 ${JSON.stringify(plain)}`,
			);
		}
	}
});
