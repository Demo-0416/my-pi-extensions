/**
 * AUDIT §5 ×2 P2 ansi-color — palette.ts:191（回退调色板 diff word 高亮不可见）。
 *
 * pi 每个 diff 侧只暴露一个前景 token（toolDiffAdded / toolDiffRemoved）。原来
 * 回退调色板把「整行底色」和「词级底色」都映射到同一个 token → 两者取值相同 →
 * 词级高亮（diff.ts:645-646 把 BG_*_W 画在 BG_* 之上）在任何非 CC 真彩主题下
 * 完全看不见。
 *
 * 修复：token 解析出来时当作「词级」鲜艳色，整行底色由它向画布混出更暗/更浅的
 * 一档；token 未定义时才退回 CC 自带的已区分的硬编码对。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePalette } from "../extension/palette.js";

/** 造一个 tokenFg：给定 token → 真彩 fg 转义。 */
function tokenFgFrom(map: Record<string, string>): (token: string) => string | undefined {
	return (token) => {
		const hex = map[token];
		if (!hex) return undefined;
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `\x1b[38;2;${r};${g};${b}m`;
	};
}

test("非 CC 主题：diff 整行底色与词级底色必须不同（否则词级高亮不可见）", () => {
	const tokenFg = tokenFgFrom({ toolDiffAdded: "#33AA55", toolDiffRemoved: "#CC4455" });
	const p = resolvePalette("some-random-dark-theme", tokenFg);
	assert.equal(p.isCcTheme, false, "这应该走 fallback 分支");
	assert.notEqual(p.cc.diffAddedBg, p.cc.diffAddedWord, "add 整行底色 ≠ 词级底色");
	assert.notEqual(p.cc.diffRemovedBg, p.cc.diffRemovedWord, "del 整行底色 ≠ 词级底色");
	// 词级色应等于 token 本身（鲜艳档）。
	assert.equal(p.cc.diffAddedWord, "#33aa55");
	assert.equal(p.cc.diffRemovedWord, "#cc4455");
});

test("非 CC 主题：整行底色比词级色更暗（dark scheme 向画布混）", () => {
	const tokenFg = tokenFgFrom({ toolDiffAdded: "#33AA55" });
	const p = resolvePalette("mytheme-dark", tokenFg);
	const bg = String(p.cc.diffAddedBg);
	const word = String(p.cc.diffAddedWord);
	const lum = (hex: string) => {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return 0.299 * r + 0.587 * g + 0.114 * b;
	};
	assert.ok(lum(bg) < lum(word), "dark 下整行底色应比词级色更暗");
});

test("非 CC light 主题：整行底色比词级色更亮", () => {
	const tokenFg = tokenFgFrom({ toolDiffAdded: "#33AA55" });
	const p = resolvePalette("mytheme-light", tokenFg);
	const lum = (hex: string) => {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return 0.299 * r + 0.587 * g + 0.114 * b;
	};
	assert.ok(lum(String(p.cc.diffAddedBg)) > lum(String(p.cc.diffAddedWord)), "light 下整行底色应比词级色更亮");
});

test("token 未定义时退回 CC 自带的已区分硬编码对", () => {
	const p = resolvePalette("bare-dark-theme", () => undefined);
	assert.equal(p.cc.diffAddedBg, "#225C2B");
	assert.equal(p.cc.diffAddedWord, "#38A660");
	assert.equal(p.cc.diffRemovedBg, "#7A2936");
	assert.equal(p.cc.diffRemovedWord, "#B3596B");
	assert.notEqual(p.cc.diffAddedBg, p.cc.diffAddedWord);
	assert.notEqual(p.cc.diffRemovedBg, p.cc.diffRemovedWord);
});

test("CC 主题走内置表，不受 fallback 逻辑影响", () => {
	const p = resolvePalette("claude-code-dark", () => undefined);
	assert.equal(p.isCcTheme, true);
	assert.equal(p.cc.diffAddedBg, "#225C2B");
	assert.equal(p.cc.diffAddedWord, "#38A660");
});
