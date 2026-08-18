/**
 * AUDIT §5 ×1 P2 correctness — palette.ts:139。
 *
 * 两个 bug：
 * 1. paletteKeyForThemeName 用 `themeName.replace(/^claude-code-/, "")` 后
 *    `in PALETTES` 判定。pi 的内置主题就叫 "dark"/"light"（theme.js
 *    getBuiltinThemes），replace 对它是 no-op → "dark" in PALETTES 命中 →
 *    pi 中性主题被涂成 CC 橙调色板。
 * 2. isLightThemeName 用 includes("light") 子串匹配，"moonlight"/"highlight"
 *    这种名字会被误判成 light。
 *
 * 修复后：只有 `claude-code-<key>` 才认作 CC 主题；light 判定走词边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { paletteKeyForThemeName, isLightThemeName, resolvePalette } from "../extension/palette.js";

test("pi 内置 dark/light 不被误判成 CC 主题", () => {
	assert.equal(paletteKeyForThemeName("dark"), undefined, "pi 内置 'dark' 不是 CC 主题");
	assert.equal(paletteKeyForThemeName("light"), undefined, "pi 内置 'light' 不是 CC 主题");
});

test("claude-code-* 前缀主题仍正确解析成 CC key", () => {
	assert.equal(paletteKeyForThemeName("claude-code-dark"), "dark");
	assert.equal(paletteKeyForThemeName("claude-code-light"), "light");
	assert.equal(paletteKeyForThemeName("claude-code-dark-daltonized"), "dark-daltonized");
	assert.equal(paletteKeyForThemeName("claude-code-light-ansi"), "light-ansi");
});

test("非 CC / 未知 / 空主题名返回 undefined", () => {
	assert.equal(paletteKeyForThemeName(undefined), undefined);
	assert.equal(paletteKeyForThemeName(""), undefined);
	assert.equal(paletteKeyForThemeName("solarized"), undefined);
	assert.equal(paletteKeyForThemeName("claude-code-unknown"), undefined);
	// `in` 会走原型链，hasOwnProperty 不会：这些不能命中。
	assert.equal(paletteKeyForThemeName("claude-code-toString"), undefined);
	assert.equal(paletteKeyForThemeName("claude-code-constructor"), undefined);
});

test("isLightThemeName 用词边界而非子串", () => {
	assert.equal(isLightThemeName("light"), true);
	assert.equal(isLightThemeName("claude-code-light"), true);
	assert.equal(isLightThemeName("claude-code-light-ansi"), true);
	assert.equal(isLightThemeName("solarized-light"), true);
	// 子串误判的反例
	assert.equal(isLightThemeName("moonlight"), false);
	assert.equal(isLightThemeName("highlight"), false);
	assert.equal(isLightThemeName("delightful"), false);
	// CC dark 家族
	assert.equal(isLightThemeName("dark"), false);
	assert.equal(isLightThemeName("claude-code-dark"), false);
	assert.equal(isLightThemeName("claude-code-dark-daltonized"), false);
	assert.equal(isLightThemeName(undefined), false);
});

test("pi 内置 dark 走 fallback 分支（isCcTheme=false），不复用 CC 橙", () => {
	// tokenFg 返回 undefined → fallback 用默认色；关键是 isCcTheme 必须为 false。
	const p = resolvePalette("dark", () => undefined);
	assert.equal(p.isCcTheme, false, "pi 内置 dark 不应被当成 CC 主题");
	assert.equal(p.scheme, "dark");
});
