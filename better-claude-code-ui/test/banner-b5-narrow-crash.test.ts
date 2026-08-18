/**
 * AUDIT §5 banner.ts:392 (P3 ×2):
 *
 * 极窄终端下 compact 欢迎盒的顶边框是固定 14 列骨架（╭── pi agent ──╮），
 * boxWidth 被压到 < 14 时 fillLen 变负、`"─".repeat(boxWidth - 2)` 抛
 * RangeError，顶边框还会冲出盒外。修复：boxWidth < 14 时退化成无边框居中栈。
 *
 * 断言：任意 1..13 的窄宽度都不抛异常，且每行不超过终端宽度。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BannerComponent } from "../extension/banner.js";
import { FakeTheme } from "./harness.js";
import { plain, width as vw } from "./helpers.js";

function bind(banner: BannerComponent, theme: FakeTheme) {
	return { render: (w: number): string[] => banner.render(w, theme as any) };
}

function makeBanner(cwd: string, resumed?: string, model?: string, full = true) {
	// full 默认 true：盒装档只在 full 模式渲染；传 false 测默认 condensed 路径。
	return new BannerComponent({
		model: () => model,
		cwd,
		resumed,
		title: () => (resumed ? "sess title" : undefined),
		skills: [],
		extensions: [],
		full,
	});
}

test("极窄终端（width 1..13）不抛 RangeError 且不超宽", () => {
	const theme = new FakeTheme("claude-code-dark");
	for (let w = 1; w <= 13; w++) {
		assert.doesNotThrow(() => {
			const banner = makeBanner("~/deep/nested/project", "85d19568", "claude-sonnet-4");
			const rows = plain(bind(banner, theme), w);
			for (const r of rows) {
				assert.ok(vw(r) <= w, `w=${w} 行宽 ${vw(r)} 超过 ${w}: ${JSON.stringify(r)}`);
			}
		}, `width=${w} 不应抛异常`);
	}
});

test("width 0 也安全", () => {
	const theme = new FakeTheme("claude-code-dark");
	assert.doesNotThrow(() => {
		plain(bind(makeBanner("~/x"), theme), 0);
	});
});

test("默认（非 full）condensed 路径：无盒边框、极窄不抛不超宽", () => {
	// AUDIT §6 P1 CondensedLogo — 默认启动是无边框 3 行 logo，盒装保留给
	// 新版本/首次项目（info.full）。
	const theme = new FakeTheme("claude-code-dark");
	const rows = plain(bind(makeBanner("~/deep/nested/project", "85d19568", "claude-sonnet-4", false), theme), 80);
	assert.ok(rows.length >= 3, "condensed 应渲染出 ≥3 行");
	for (const r of rows) {
		assert.ok(!/[╭╰│]/.test(r), `condensed 不应有盒边框字符: ${JSON.stringify(r)}`);
	}
	assert.ok(rows.some((r) => r.includes("pi agent")), "应包含 wordmark");
	// 极窄宽度同样不抛异常、不超宽。
	for (let w = 1; w <= 20; w++) {
		assert.doesNotThrow(() => {
			const narrow = plain(bind(makeBanner("~/deep/nested/project", "85d19568", "claude-sonnet-4", false), theme), w);
			for (const r of narrow) {
				assert.ok(vw(r) <= w, `w=${w} 行宽 ${vw(r)} 超过 ${w}: ${JSON.stringify(r)}`);
			}
		}, `condensed width=${w} 不应抛异常`);
	}
});
