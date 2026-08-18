/**
 * AUDIT §6（spinner glimmer 扫光）— CC spinner 最标志性的效果，pi 完全没有。
 *
 * CC SpinnerAnimationRow.tsx:139-147 + GlimmerMessage.tsx:103-141：verb 上有一道
 * shimmer 高光，随 useAnimationFrame(50) 时钟以 200ms/列的速度从右向左扫过，扫到
 * 屏外再回卷。扫光落点 ±1 列用 shimmer 色，其余用 accent 色。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { glimmerMessage, buildSpinnerLine, type SpinnerPaint } from "../extension/spinner.js";

const marking: SpinnerPaint = {
	accent: (s) => `A[${s}]`,
	shimmer: (s) => `S[${s}]`,
	dim: (s) => `D[${s}]`,
};

test("扫光落点 ±1 列用 shimmer，其余用 accent", () => {
	// glimmerIndex=3，message "Cook…"（5 列）：第 2..4 列（ok…）是 shimmer。
	assert.equal(glimmerMessage("Cook…", 3, marking), "A[Co]S[ok…]");
});

test("扫光扫到屏外：整段回落 accent，无 shimmer 段", () => {
	assert.equal(glimmerMessage("Cook…", 15, marking), "A[Cook…]");
	assert.equal(glimmerMessage("Cook…", -5, marking), "A[Cook…]");
});

test("随时间从右向左扫：shimmer 段的列位随 timeMs 增大而左移", () => {
	// 用 shimmer 包裹标记，找出高光段首次出现的字符位置随时间左移。
	const paint: SpinnerPaint = { accent: (s) => s, shimmer: (s) => `<${s}>`, dim: (s) => s };
	function shimmerCol(timeMs: number): number {
		const line = buildSpinnerLine({ verb: "Abcdefgh", timeMs, columns: 80 }, paint);
		return line.indexOf("<");
	}
	// 扫光从右侧进入 verb（~2200ms 落在最右字符），逐步左移（~3400ms 更靠左）。
	const early = shimmerCol(2200);
	const later = shimmerCol(3400);
	assert.ok(early > 0, `早期扫光应已进入 verb 右侧：early=${early}`);
	assert.ok(later > 0 && later < early, `扫光应从右向左：early=${early} later=${later}`);
});

test("glimmer 不改变可见文本，只改变着色", () => {
	const paint: SpinnerPaint = { accent: (s) => s, shimmer: (s) => s, dim: (s) => s };
	const line = buildSpinnerLine({ verb: "Cooking", timeMs: 350, columns: 80 }, paint);
	assert.ok(line.endsWith("Cooking…"), `可见文本应完整：${line}`);
});
