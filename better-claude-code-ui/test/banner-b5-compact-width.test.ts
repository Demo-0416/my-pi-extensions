/**
 * AUDIT §5 banner.ts:375 (P1 ×4):
 *
 * compact 档欢迎盒（width < 40）的内容行是 `│ <inner> │` = inner + 4 列，上下
 * 边框是 boxWidth 列。原代码 inner = boxWidth - 2，于是每条内容行比边框宽 2 列、
 * 右边框整体错位。修正为 inner = boxWidth - 4（2 边框 + 2 padding）。
 *
 * 断言：compact 盒每一行的可见宽度都相等（矩形对齐），且不超过终端宽度。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BannerComponent } from "../extension/banner.js";
import { FakeTheme } from "./harness.js";
import { plain, width as vw } from "./helpers.js";

/** Adapt BannerComponent.render(width, theme) to the plain() helper's render(width). */
function bind(banner: BannerComponent, theme: FakeTheme) {
	return { render: (w: number): string[] => banner.render(w, theme as any) };
}

function makeBanner(cwd: string, resumed?: string, model?: string) {
	// full: true — 盒装档只在 full 模式渲染（默认启动是 condensed 无边框栈）。
	return new BannerComponent({
		model: () => model,
		cwd,
		resumed,
		title: () => (resumed ? "some session title" : undefined),
		skills: [],
		extensions: [],
		full: true,
	});
}

test("compact 欢迎盒每行宽度相等（右边框不错位）", () => {
	const theme = new FakeTheme("claude-code-dark");
	// width 30/36/39 都落在 compact 档（< MIN_BOXED_WIDTH=40）。
	for (const w of [30, 36, 39]) {
		const banner = makeBanner("~/some/deep/project/dir", "85d19568", "claude-sonnet-4");
		const rows = plain(bind(banner, theme), w);
		assert.ok(rows.length >= 3, `w=${w} 应渲染出多行`);
		const widths = rows.map((r) => vw(r));
		const first = widths[0];
		for (let i = 0; i < rows.length; i++) {
			assert.equal(
				widths[i],
				first,
				`w=${w} 第 ${i} 行宽度 ${widths[i]} 应等于顶边框宽度 ${first}\n${rows.join("\n")}`,
			);
		}
		// 盒宽不得超过可用宽度。
		assert.ok(first <= w, `w=${w} 盒宽 ${first} 不应超过终端宽 ${w}`);
	}
});
