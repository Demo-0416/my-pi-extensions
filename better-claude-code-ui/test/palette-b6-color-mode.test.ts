/**
 * AUDIT §5 ×1 P2 ansi-color — palette.ts:221（无视 getColorMode，永远发 24 位真彩）。
 *
 * 原来 fgAnsi/bgAnsi 对 hex 恒发 `38;2`/`48;2` 真彩转义。256color 终端下 pi 自己的
 * 渲染器会把 hex 降到 `38;5;N`（theme.js fgAnsi），扩展却直发真彩 → 在只支持 256
 * 色的终端上颜色被终端二次近似，与 pi 原生渲染不一致；连 *-ansi 主题的 diff chrome
 * 也是硬编码 RGB。
 *
 * 修复：resolvePalette 从 pi theme 的实际输出探测 color mode（pi 已把 hex 降到
 * 38;5;≥16），fgAnsi/bgAnsi 在 256color 下按 pi 相同的 6x6x6 cube 算法把 hex 降到
 * 38;5/48;5。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePalette, fgAnsi, bgAnsi, setActiveColorMode, getActiveColorMode } from "../extension/palette.js";

/** truecolor 终端下 pi 的 theme.fg：hex → 38;2 真彩。 */
function truecolorTokenFg(token: string): string | undefined {
	const map: Record<string, string> = { accent: "#D77757", error: "#FF6B80", success: "#4EBA65" };
	const hex = map[token];
	if (!hex) return undefined;
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** 256color 终端下 pi 的 theme.fg：hex 已被降到 38;5;N（N≥16）。 */
function color256TokenFg(token: string): string | undefined {
	const map: Record<string, number> = { accent: 173, error: 204, success: 71 };
	const idx = map[token];
	if (idx === undefined) return undefined;
	return `\x1b[38;5;${idx}m`;
}

test("探测：pi 输出 38;5;≥16 → 256color", () => {
	const p = resolvePalette("mytheme-256", color256TokenFg);
	assert.equal(p.colorMode, "256color");
});

test("探测：pi 输出 38;2 真彩 → truecolor", () => {
	const p = resolvePalette("mytheme-tc", truecolorTokenFg);
	assert.equal(p.colorMode, "truecolor");
});

test("探测：全无证据 → 默认 truecolor（不回归旧行为）", () => {
	const p = resolvePalette("mytheme-empty", () => undefined);
	assert.equal(p.colorMode, "truecolor");
});

test("truecolor 模式下 fgAnsi/bgAnsi 发 38;2 / 48;2", () => {
	setActiveColorMode("truecolor");
	assert.equal(fgAnsi("#D77757"), "\x1b[38;2;215;119;87m");
	assert.equal(bgAnsi("#225C2B"), "\x1b[48;2;34;92;43m");
});

test("256color 模式下 fgAnsi/bgAnsi 发 38;5 / 48;5，索引与 pi 一致", () => {
	setActiveColorMode("256color");
	// pi rgbTo256(#D77757 = 215,119,87)：cube 索引 16+36*4+6*2+2 = 173
	assert.equal(fgAnsi("#D77757"), "\x1b[38;5;173m");
	// pi rgbTo256(#225C2B = 34,92,43)：cube 索引 16+36*0+6*1+0 = 22
	assert.equal(bgAnsi("#225C2B"), "\x1b[48;5;22m");
	setActiveColorMode("truecolor"); // 复位，避免污染同进程后续测试
});

test("ANSI 索引色（number）两种模式下都发基础 SGR，不受影响", () => {
	setActiveColorMode("256color");
	assert.equal(fgAnsi(9), "\x1b[91m"); // 9 → 90+ (bright)
	assert.equal(bgAnsi(2), "\x1b[42m");
	setActiveColorMode("truecolor");
	assert.equal(fgAnsi(9), "\x1b[91m");
	assert.equal(bgAnsi(2), "\x1b[42m");
});

test("resolvePalette 把 color mode 折进缓存 key：同名主题不同 mode 得到不同实例", () => {
	const tc = resolvePalette("dualmode-theme", truecolorTokenFg);
	const c256 = resolvePalette("dualmode-theme", color256TokenFg);
	assert.notEqual(tc, c256, "同名但不同 color mode 不能命中同一缓存实例");
	assert.equal(tc.colorMode, "truecolor");
	assert.equal(c256.colorMode, "256color");
});

test("resolvePalette 会把 active mode 同步到全局（fgAnsi 依赖它）", () => {
	resolvePalette("sync-check-256", color256TokenFg);
	assert.equal(getActiveColorMode(), "256color");
	resolvePalette("sync-check-tc", truecolorTokenFg);
	assert.equal(getActiveColorMode(), "truecolor");
});
