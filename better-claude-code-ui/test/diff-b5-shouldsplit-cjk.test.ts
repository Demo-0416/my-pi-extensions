/**
 * AUDIT §5 ×2 P3 layout-width — diff.ts:372 shouldUseSplit 用 .length 数
 * 「会换行的行」，CJK diff 被误判为窄行从而选中 split 布局。
 *
 * split 布局对每侧只给约一半宽度。若一行 CJK 文本的显示宽度已经超过 split
 * 的单侧 codeWidth（会被折行），却因为 .length（码元数=显示宽度的一半）没超过
 * 而不计入 wrapCandidates，shouldUseSplit 就误判整个 diff「窄到能 split」，
 * 结果 CJK 内容被塞进半宽栏疯狂折行。
 *
 * 断言：一段全 CJK、每行显示宽度都超过 split 单侧 codeWidth 的 diff，
 * shouldUseSplit 必须返回 false（改用 unified 全宽），而不是 true。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldUseSplit, type ParsedDiff, SPLIT_MIN_WIDTH } from "../extension/tools/diff.js";

// width=SPLIT_MIN_WIDTH(150) → half≈74，codeWidth≈74-(numberWidth+5)≈67。
// 每行 40 个 CJK = 显示 80 列 > 67（会折行），但 .length=40 < 67（旧逻辑不计）。
function cjkLine(n: number, chars = 40): { type: "add"; oldNum: null; newNum: number; content: string } {
	return { type: "add", oldNum: null, newNum: n, content: "宽".repeat(chars) };
}

test("全 CJK 宽行 diff 不应误判为可 split（走 unified）", () => {
	const lines = Array.from({ length: 10 }, (_, i) => cjkLine(i + 1));
	const diff: ParsedDiff = { added: 10, removed: 0, chars: 10 * 40, lines };
	// 旧逻辑：每行 .length=40 ≤ codeWidth，wrapCandidates=0 → 判定可 split(true)。
	// 修复后：visibleWidth=80 > codeWidth，全部计入 wrapCandidates → 返回 false。
	assert.equal(shouldUseSplit(diff, SPLIT_MIN_WIDTH), false, "宽 CJK diff 应回退 unified，不选 split");
});

test("窄 ASCII diff 仍可 split（回归保护）", () => {
	const lines = Array.from({ length: 10 }, (_, i) => ({
		type: "ctx" as const,
		oldNum: i + 1,
		newNum: i + 1,
		content: "short line",
	}));
	const diff: ParsedDiff = { added: 0, removed: 0, chars: 100, lines };
	assert.equal(shouldUseSplit(diff, 200), true, "窄 ASCII 行仍应允许 split");
});
