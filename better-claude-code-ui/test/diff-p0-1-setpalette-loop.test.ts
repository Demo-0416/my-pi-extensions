/**
 * AUDIT §2 P0-1 — diff.ts:466 + palette.ts:167 同步死循环。
 *
 * 机制：setDiffPalette 遍历 highlightCache.keys() 时，warmHighlightCache 命中缓存
 * 会同步 touchCache（delete+set），按 JS Map 规范把当前 key 挪到迭代序末尾，活的
 * for..of 迭代器于是永远重访它 —— 主线程同步死循环冻结 TUI。修复前这个测试会挂死
 * （node:test 整体超时视作失败），修复后 setDiffPalette 立即返回。
 *
 * 另一半：resolvePalette 每次返回新对象字面量，让 diff.ts:460 的
 * `p === activeSgrPalette` 引用守卫恒假。修复后同名主题返回同一实例。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePalette } from "../extension/palette.js";
import { setDiffPalette, warmHighlightCache, clearHighlightCache } from "../extension/tools/diff.js";

test("resolvePalette 对同名主题返回同一实例（引用守卫依赖）", () => {
	const a = resolvePalette("claude-code-dark", () => undefined);
	const b = resolvePalette("claude-code-dark", () => undefined);
	assert.equal(a, b, "同名主题必须复用实例，否则 diff.ts:460 的引用守卫恒假");
	const c = resolvePalette("claude-code-light", () => undefined);
	assert.notEqual(a, c, "不同主题名必须是不同实例，否则主题切换不会触发 re-warm");
});

test("setDiffPalette 在缓存非空时必须终止（不能死循环）", async () => {
	clearHighlightCache();
	const dark = resolvePalette("claude-code-dark", () => undefined);
	setDiffPalette(dark);

	// 预热几条 dark-scheme 缓存（shiki 导出名不匹配 → 走 touchCache 降级，依然落盘）。
	for (let i = 0; i < 5; i += 1) {
		await warmHighlightCache(`const x${i} = ${i};`, "typescript", "github-dark");
	}

	// 切到另一个 dark-scheme 主题实例：shiki theme 仍是 github-dark，每个 key 都是
	// 缓存命中 → 触发 touchCache 的 Map 变异。修复前这里同步死循环。
	const daltonized = resolvePalette("claude-code-dark-daltonized", () => undefined);
	setDiffPalette(daltonized);

	// 能走到这一行就说明遍历终止了。
	assert.ok(true, "setDiffPalette 返回，未死循环");
});

test("setDiffPalette 幂等：同一实例二次调用是 no-op（值守卫生效）", () => {
	const p = resolvePalette("claude-code-dark", () => undefined);
	setDiffPalette(p);
	setDiffPalette(p); // 不抛、不挂
	assert.ok(true);
});
