/**
 * AUDIT §6 Spinner 状态行（三条）：
 *
 *  1. P1 — 缺 `(12s · ↓ 1.2k tokens)` 计时/token 段。CC 的 spinner 行是
 *     `✻ Verbing… (12s · ↓ 1.2k tokens · esc to interrupt)`，计时从 agent_start
 *     起算，token 是本请求的累计下行 token（数据源：message_update 的
 *     assistantMessageEvent.partial.usage.output，message_end 时并入已结算值）。
 *  2. P1 — thinking 期间 verb 被整条顶掉换成 `(thinking)`，CC 是 verb 保留、
 *     括号段追加 thinking 状态。
 *  3. P2 — 运行中缺 `esc to interrupt` 提示（与括号段合成一体）。
 *
 * 另含窄终端渐进降级：byline 依次丢 esc → tokens → 时长 → thinking，不动 verb。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildSpinnerLine,
	formatElapsed,
	formatTokenCount,
	type SpinnerPaint,
} from "../extension/spinner.js";
import { FakePi, loadExtension } from "./harness.js";
import { currentWorkingVerb } from "../extension/spinner.js";

const plainPaint: SpinnerPaint = { accent: (s) => s, shimmer: (s) => s, dim: (s) => s };

test("formatTokenCount：847 → 847、1234 → 1.2k、25600 → 26k、1000 → 1k", () => {
	assert.equal(formatTokenCount(847), "847");
	assert.equal(formatTokenCount(1234), "1.2k");
	assert.equal(formatTokenCount(25_600), "26k");
	assert.equal(formatTokenCount(1000), "1k");
});

test("formatElapsed：12s / 1m 5s / 1h 2m 3s", () => {
	assert.equal(formatElapsed(12_000), "12s");
	assert.equal(formatElapsed(65_000), "1m 5s");
	assert.equal(formatElapsed(3_723_000), "1h 2m 3s");
});

test("byline 含计时、token 与 esc to interrupt，verb 保留", () => {
	const line = buildSpinnerLine(
		{ verb: "Baking", timeMs: 12_000, columns: 120, tokens: 1234 },
		plainPaint,
	);
	assert.ok(line.includes("Baking…"), `verb 应保留：${line}`);
	assert.ok(line.includes("(12s · ↓ 1.2k tokens · esc to interrupt)"), `byline 形态：${line}`);
});

test("tokens 为 0/缺省时不显示 token 段", () => {
	const line = buildSpinnerLine({ verb: "Baking", timeMs: 5_000, columns: 120 }, plainPaint);
	assert.ok(line.includes("(5s · esc to interrupt)"), `无 token 段：${line}`);
	assert.ok(!line.includes("tokens"), `不应有 token 字样：${line}`);
});

test("thinking 段追加在括号段首位，verb 不被顶掉", () => {
	const line = buildSpinnerLine(
		{ verb: "Pondering", timeMs: 12_000, columns: 120, tokens: 1234, thinking: "thinking · high" },
		plainPaint,
	);
	assert.ok(line.includes("Pondering…"), `verb 应保留：${line}`);
	assert.ok(
		line.includes("(thinking · high · 12s · ↓ 1.2k tokens · esc to interrupt)"),
		`thinking 应并入括号段首位：${line}`,
	);
});

test("窄终端渐进降级：先丢 esc，再丢 tokens，再丢时长，verb 永不缩", () => {
	const state = { verb: "Contemplating", timeMs: 12_000, tokens: 1234, thinking: "thinking" };
	// 宽裕：全段都在。
	const full = buildSpinnerLine({ ...state, columns: 200 }, plainPaint);
	assert.ok(full.includes("esc to interrupt"), full);
	// 收窄一档：esc 先没。
	const noEsc = buildSpinnerLine({ ...state, columns: 60 }, plainPaint);
	assert.ok(!noEsc.includes("esc to interrupt"), `60 列应丢 esc：${noEsc}`);
	assert.ok(noEsc.includes("↓ 1.2k tokens"), `60 列应保留 tokens：${noEsc}`);
	// 再窄：tokens 也没,时长还在。
	const noTok = buildSpinnerLine({ ...state, columns: 40 }, plainPaint);
	assert.ok(!noTok.includes("tokens"), `40 列应丢 tokens：${noTok}`);
	assert.ok(noTok.includes("12s"), `40 列应保留时长：${noTok}`);
	// 极窄：只剩 verb。
	const bare = buildSpinnerLine({ ...state, columns: 18 }, plainPaint);
	assert.ok(bare.includes("Contemplating…"), `verb 永不缩：${bare}`);
	assert.ok(!bare.includes("("), `极窄应无 byline：${bare}`);
});

/** emit 链完成后等一个宏任务，让 spinner 的 scheduleRepaint 落地。 */
async function settleRepaint(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 1));
}

test("集成：message_update 流出 usage.output 后 byline 显示 token 数", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("agent_start");
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "x", partial: { usage: { output: 1234 } } },
	});
	await settleRepaint();
	const line = pi.ui.workingMessage ?? "";
	assert.ok(line.includes("↓ 1.2k tokens"), `working message 应含 token 段：${line}`);
	assert.ok(line.includes("esc to interrupt"), `working message 应含 esc 提示：${line}`);
});

test("集成：thinking_start 后 verb 仍在且括号段含 thinking；thinking_end 撤掉", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("agent_start");
	const verb = currentWorkingVerb();
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: { usage: { output: 0 } } },
	});
	await settleRepaint();
	let line = pi.ui.workingMessage ?? "";
	assert.ok(line.includes(`${verb}…`), `thinking 期间 verb 不被顶掉：${line}`);
	assert.ok(line.includes("thinking"), `括号段应含 thinking：${line}`);
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "", partial: { usage: { output: 0 } } },
	});
	await settleRepaint();
	line = pi.ui.workingMessage ?? "";
	assert.ok(!/\(thinking/.test(line), `thinking_end 后应撤掉 thinking 段：${line}`);
});

test("集成：message_end 结算 token，跨消息累计", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("agent_start");
	await pi.emit("message_end", {
		message: { role: "assistant", usage: { output: 900 } },
	});
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "y", partial: { usage: { output: 400 } } },
	});
	await settleRepaint();
	const line = pi.ui.workingMessage ?? "";
	assert.ok(line.includes("↓ 1.3k tokens"), `900+400=1300 → 1.3k：${line}`);
});

test("集成：agent_settled 后排队的 repaint 不复活 working message", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("agent_start");
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "z", partial: { usage: { output: 10 } } },
	});
	await pi.emit("agent_settled");
	await settleRepaint();
	assert.equal(pi.ui.workingMessage, undefined, "settled 后不应再写 working message");
});
