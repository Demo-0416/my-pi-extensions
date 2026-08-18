/**
 * AUDIT §5 spinner.ts:74（帧颜色烧死）+ §6（verb 灰色，应为 claude 品牌橙）。
 *
 * 缺陷：旧实现走 pi 内置 Loader —— setWorkingIndicator 把帧颜色在 session_start
 * 烧死（换主题后 spinner 仍是旧主题 accent），且 pi 的 messageColorFn 把 verb
 * 强制染成 muted 灰。
 *
 * 修法：用 `frames: []` 关掉内置指示器，扩展自己每 50ms 用 setWorkingMessage
 * 重画整行；glyph 和 verb 都用当前主题的 accent（claude 橙）上色。因为每帧都
 * 从活动主题重算，换主题即时生效。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpinnerLine, type SpinnerPaint } from "../extension/spinner.js";
import { FakePi, FakeTheme, loadExtension, startSession } from "./harness.js";

/** 记录哪个"颜色函数"包住了哪段文本。 */
function tracingPaint(log: Array<{ role: string; text: string }>): SpinnerPaint {
	return {
		accent: (s) => (log.push({ role: "accent", text: s }), `A(${s})`),
		shimmer: (s) => (log.push({ role: "shimmer", text: s }), `S(${s})`),
		dim: (s) => (log.push({ role: "dim", text: s }), `D(${s})`),
	};
}

test("§6：glyph 和 verb 都用 accent（claude 橙）上色，绝不用 dim/muted", () => {
	const log: Array<{ role: string; text: string }> = [];
	const line = buildSpinnerLine({ verb: "Cooking", timeMs: 0, columns: 80 }, tracingPaint(log));
	// verb 段被 accent 上色。
	assert.ok(log.some((c) => c.role === "accent" && c.text.includes("Cooking…")), "verb 用 accent");
	// glyph（第一帧 ·）也被 accent 上色。
	assert.ok(log.some((c) => c.role === "accent" && c.text === "·"), "glyph 用 accent");
	// glyph/verb 都不走 dim——dim 只允许出现在 byline 括号段上。
	assert.ok(!log.some((c) => c.role === "dim" && c.text.includes("Cooking")), "verb 不 dim");
	assert.ok(!log.some((c) => c.role === "dim" && c.text === "·"), "glyph 不 dim");
	assert.match(line, /A\(Cooking…\)/);
});

test("§5:74：帧随时间推进（120ms 一帧），不是固定字符", () => {
	const noop: SpinnerPaint = { accent: (s) => s, shimmer: (s) => s, dim: (s) => s };
	const f0 = buildSpinnerLine({ verb: "X", timeMs: 0, columns: 80 }, noop);
	const f1 = buildSpinnerLine({ verb: "X", timeMs: 120, columns: 80 }, noop);
	assert.notEqual(f0, f1, "相邻帧字符应不同");
});

test("§5:74：session_start 用 frames:[] 关掉内置指示器（不再烧死帧颜色）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await startSession(pi);
	assert.deepEqual(pi.ui.workingIndicator, { frames: [] }, "内置指示器被 frames:[] 关掉");
});

test("§5:74：换主题后下一帧即用新主题上色（不烧死）", async () => {
	const pi = new FakePi();
	pi.ui.theme = new FakeTheme("claude-code-dark");
	await loadExtension(pi);
	await startSession(pi);
	await pi.emit("agent_start");
	// agent_start 同步画了第一帧：记录了一次 fg("accent", ...)。
	const themeA = pi.ui.theme as FakeTheme;
	assert.ok(themeA.fgCalls.some((c) => c.token === "accent"), "用 accent 画 spinner");
	// 换主题：换一个新的 FakeTheme 实例，再手动触发一次重画（agent_start 幂等）。
	const themeB = new FakeTheme("claude-code-light");
	pi.ui.theme = themeB;
	await pi.emit("agent_start");
	assert.ok(themeB.fgCalls.some((c) => c.token === "accent"), "换主题后用新主题实例上色");
});
