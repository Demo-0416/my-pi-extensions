/**
 * AUDIT §6 Spinner 状态行,按 CC 源码 + v2.1.234 用户实测复核:
 *
 *  - 段顺序(SpinnerAnimationRow.tsx:203-215):时长 · ↓ tokens · thinking,
 *    thinking 在**最后**;普通 byline **没有** `esc to interrupt`(那只出现在
 *    teammate 分支)。
 *  - thinking 态(Spinner.tsx:125-158):进行中 `thinking${effortSuffix}`,
 *    结束后 `thought for Ns`(N=最后一块时长,最少 1s);v2.1.234 进行中文案
 *    随时长递进:thinking → thinking more → thinking some more → almost done
 *    thinking(阈值为时长近似,CC 快照无此源码)。
 *  - 窄屏门控(SpinnerAnimationRow.tsx:176-196):thinking 最优先保留(放不下
 *    时降级裸 `thinking`),其次时长,最后 tokens;verb 永不缩。
 *  - 仅 thinking 段时渲染 `(thinking)`(括号同 glow 色,CC:193,210-211)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	buildSpinnerLine,
	formatElapsed,
	formatTokenCount,
	thinkingWording,
	type SpinnerPaint,
} from "../extension/spinner.js";
import { FakePi, loadExtension } from "./harness.js";
import { currentWorkingVerb } from "../extension/spinner.js";

const plainPaint: SpinnerPaint = { accent: (s) => s, shimmer: (s) => s, dim: (s) => s };

/** thinking 进行态用硬编码 truecolor glow,断言前统一剥 ANSI。 */
function plainLine(state: Parameters<typeof buildSpinnerLine>[0]): string {
	return stripTerminalSequences(buildSpinnerLine(state, plainPaint));
}

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

test("byline 含计时与 token,无 esc to interrupt(CC 普通分支没有)", () => {
	const line = plainLine({ verb: "Baking", timeMs: 12_000, columns: 120, tokens: 1234 });
	assert.ok(line.includes("Baking…"), `verb 应保留：${line}`);
	assert.ok(line.includes("(12s · ↓ 1.2k tokens)"), `byline 形态：${line}`);
	assert.ok(!line.includes("esc to interrupt"), `不应有 esc 段：${line}`);
});

test("tokens 为 0/缺省时不显示 token 段", () => {
	const line = plainLine({ verb: "Baking", timeMs: 5_000, columns: 120 });
	assert.ok(line.includes("(5s)"), `无 token 段：${line}`);
	assert.ok(!line.includes("tokens"), `不应有 token 字样：${line}`);
});

test("thinking 进行态排在括号段最后,带 effort 后缀,verb 不被顶掉", () => {
	const line = plainLine({
		verb: "Pondering",
		timeMs: 12_000,
		columns: 120,
		tokens: 1234,
		thinkingStatus: "thinking",
		effortSuffix: " with high effort",
	});
	assert.ok(line.includes("Pondering…"), `verb 应保留：${line}`);
	assert.ok(
		line.includes("(12s · ↓ 1.2k tokens · thinking with high effort)"),
		`thinking 应在括号段末位：${line}`,
	);
});

test("thinking 结束态:thought for Ns(最少 1s),排位同段尾", () => {
	const line = plainLine({ verb: "Baking", timeMs: 6_000, columns: 120, tokens: 208, thinkingStatus: 5_000 });
	assert.ok(line.includes("(6s · ↓ 208 tokens · thought for 5s)"), `CC 实测形态：${line}`);
	const sub1s = plainLine({ verb: "Baking", timeMs: 6_000, columns: 120, thinkingStatus: 300 });
	assert.ok(sub1s.includes("thought for 1s"), `不足 1s 按 1s(CC Math.max)：${sub1s}`);
});

test("进行态文案随 thinking 时长递进(v2.1.234)", () => {
	assert.equal(thinkingWording(0), "thinking");
	assert.equal(thinkingWording(29_999), "thinking");
	assert.equal(thinkingWording(30_000), "thinking more");
	assert.equal(thinkingWording(60_000), "thinking some more");
	assert.equal(thinkingWording(120_000), "almost done thinking");
	const line = plainLine({
		verb: "Actioning",
		timeMs: 814_000,
		columns: 140,
		tokens: 39_700,
		thinkingStatus: "thinking",
		effortSuffix: " with xhigh effort",
		thinkingElapsedMs: 65_000,
	});
	assert.ok(line.includes("· thinking some more with xhigh effort)"), `递进文案并入段尾：${line}`);
});

test("窄屏门控:thinking 最优先保留(可降级裸 thinking),再时长,最后 tokens", () => {
	const state = {
		verb: "Contemplating",
		timeMs: 12_000,
		tokens: 1234,
		thinkingStatus: "thinking" as const,
		effortSuffix: " with xhigh effort",
	};
	// 宽裕:全段,thinking 带 effort 收尾。
	const full = plainLine({ ...state, columns: 200 });
	assert.ok(full.includes("(12s · ↓ 1.2k tokens · thinking with xhigh effort)"), full);
	// 收窄:effort 后缀放不下 → 裸 thinking;tokens 先被丢。
	const mid = plainLine({ ...state, columns: 41 });
	assert.ok(mid.includes("(12s · thinking)"), `41 列应是 12s+裸 thinking：${mid}`);
	assert.ok(!mid.includes("tokens"), `41 列应丢 tokens：${mid}`);
	// 再窄:只剩 thinking(thinkingOnly → 括号内仅 thinking)。
	const only = plainLine({ ...state, columns: 30 });
	assert.ok(only.includes("(thinking)"), `30 列 thinkingOnly：${only}`);
	assert.ok(!only.includes("12s"), `30 列应丢时长：${only}`);
	// 无 thinking 时时长撑到最后。
	const timerOnly = plainLine({ verb: "Contemplating", timeMs: 12_000, tokens: 1234, columns: 25 });
	assert.ok(timerOnly.includes("(12s)"), `25 列无 thinking 应剩时长：${timerOnly}`);
	// 极窄:只剩 verb。
	const bare = plainLine({ ...state, columns: 18 });
	assert.ok(bare.includes("Contemplating…"), `verb 永不缩：${bare}`);
	assert.ok(!bare.includes("("), `极窄应无 byline：${bare}`);
});

/** emit 链完成后等一个宏任务,让 spinner 的 scheduleRepaint 落地。 */
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
	const line = stripTerminalSequences(pi.ui.workingMessage ?? "");
	assert.ok(line.includes("↓ 1.2k tokens"), `working message 应含 token 段：${line}`);
	assert.ok(!line.includes("esc to interrupt"), `不应有 esc 段：${line}`);
});

test("集成：thinking_start 后 verb 仍在,thinking 段追加在末位", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("agent_start");
	const verb = currentWorkingVerb();
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: { usage: { output: 0 } } },
	});
	await settleRepaint();
	const line = stripTerminalSequences(pi.ui.workingMessage ?? "");
	assert.ok(line.includes(`${verb}…`), `thinking 期间 verb 不被顶掉：${line}`);
	assert.ok(/thinking( with \w+ effort)?\)$/.test(line.trimEnd()), `thinking 应是最后一段：${line}`);
});

test("集成：message_end 结算 token，跨消息累计", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("agent_start");
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "x", partial: { usage: { output: 1000 } } },
	});
	await pi.emit("message_end", {
		message: { role: "assistant", usage: { output: 1000, cost: { total: 0 } } },
	});
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "y", partial: { usage: { output: 500 } } },
	});
	await settleRepaint();
	const line = stripTerminalSequences(pi.ui.workingMessage ?? "");
	assert.ok(line.includes("↓ 1.5k tokens"), `跨消息累计 1000+500：${line}`);
});
