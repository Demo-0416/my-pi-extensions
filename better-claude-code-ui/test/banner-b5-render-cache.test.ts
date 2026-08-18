/**
 * AUDIT §5 banner.ts:176 (P3 ×1):
 *
 * BannerComponent.invalidate() 原是空实现且 render() 无缓存 —— TUI 每帧都
 * 重跑 LayoutContainer.render 遍历 header 子组件（tui.js），欢迎盒在流式期间
 * 每帧整体重算（边框、packNames、居中）。加渲染缓存：同 key 返回同一数组引用，
 * invalidate() / model 变化清缓存。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BannerComponent } from "../extension/banner.js";
import { FakeTheme } from "./harness.js";

function makeBanner(model: () => string | undefined) {
	return new BannerComponent({
		model,
		cwd: "~/projects/app",
		resumed: undefined,
		title: () => undefined,
		skills: ["skill-a", "skill-b"],
		extensions: ["ext-a"],
	});
}

test("同 key 连续渲染命中缓存（返回同一数组引用）", () => {
	const theme = new FakeTheme("claude-code-dark") as any;
	const banner = makeBanner(() => "claude-sonnet-4");
	const a = banner.render(90, theme);
	const b = banner.render(90, theme);
	assert.strictEqual(a, b, "同宽度/同 model/同 theme 第二次应命中缓存返回同一引用");
});

test("invalidate() 后重新计算（不再是同一引用）", () => {
	const theme = new FakeTheme("claude-code-dark") as any;
	const banner = makeBanner(() => "claude-sonnet-4");
	const a = banner.render(90, theme);
	banner.invalidate();
	const b = banner.render(90, theme);
	assert.notStrictEqual(a, b, "invalidate 后应重算");
	assert.deepEqual(a, b, "内容仍应一致");
});

test("宽度变化不命中缓存", () => {
	const theme = new FakeTheme("claude-code-dark") as any;
	const banner = makeBanner(() => "claude-sonnet-4");
	const a = banner.render(90, theme);
	const b = banner.render(50, theme);
	assert.notStrictEqual(a, b);
});

test("model 变化令缓存失效（内容也变）", () => {
	const theme = new FakeTheme("claude-code-dark") as any;
	let model = "claude-sonnet-4";
	const banner = makeBanner(() => model);
	const a = banner.render(90, theme).join("\n");
	model = "claude-opus-4-1";
	const b = banner.render(90, theme).join("\n");
	assert.notEqual(a, b, "model 换了内容应变");
	assert.match(b, /claude-opus-4-1/);
});

test("fg 调用次数：第二次命中缓存时不再调用 theme.fg", () => {
	const theme = new FakeTheme("claude-code-dark");
	const banner = makeBanner(() => "claude-sonnet-4");
	banner.render(90, theme as any);
	const afterFirst = theme.fgCalls.length;
	assert.ok(afterFirst > 0, "首帧应有 fg 调用");
	banner.render(90, theme as any);
	assert.equal(theme.fgCalls.length, afterFirst, "命中缓存后不应再产生 fg 调用（证明没重算）");
});
