/**
 * AUDIT §5:199 (P2 ×2) — blink 每 tick 只 invalidate 最近 5 个（budget），预算外
 * 的 pending 行不再被重绘，会冻结在最后一帧；若那帧恰是 off（空格）相位，状态点
 * 直接消失。
 *
 * 修复：blinkTick 记录本 tick 的 budget id 集合；currentBlinkPhase(id) /
 * groupBlinkVisible(id) 对预算外的行强制返回 visible（实心点），预算内的行才跟
 * 随全局相位。budget 仍然限制重绘量。
 *
 * 断言：>5 个并行 standalone pending 工具，任意相位下预算外的工具状态点都不是空格。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentBlinkPhase } from "../extension/tools/grouping.js";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";

test("currentBlinkPhase(id)：无 id 或未进 session 时返回全局相位（默认 true）", () => {
	// 无参调用保持旧签名语义（返回全局相位；启动时为 true）。
	assert.equal(typeof currentBlinkPhase(), "boolean");
});

test("currentBlinkPhase(unknownId)：预算外 id 恒 visible（不冻结成空格）", () => {
	// 一个从未进入过任何 blink budget 的 id：blinkBudgetStandalone 为空集，
	// 所以 has(id) 为 false → 强制返回 true（实心点），无论全局相位如何。
	// 这正是修复的核心：预算外的 pending 点永远画实心，不会落到 off 相位。
	assert.equal(currentBlinkPhase("never-in-budget"), true);
	// 多次调用稳定为 true（不随全局相位翻转把它变成空格）。
	for (let i = 0; i < 10; i++) {
		assert.equal(currentBlinkPhase(`ghost-${i}`), true, `预算外 id 第 ${i} 次应恒为 visible`);
	}
});

test("预算外的 pending 点在全局 off 相位下仍报 visible（in-budget 才跟随相位）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	// write 不可折叠、不进组，每个都是 standalone 的 pending 点。
	const ids = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"];
	const write = pi.tools.get("write")!;
	const theme = new FakeTheme();
	// 渲染全部 7 个（statusDot 里 armBlink 按 w1..w7 顺序注册进 standaloneBlinkers）。
	for (const id of ids) {
		const { ctx } = makeToolCtx({ toolCallId: id, args: { path: "f.txt", content: "x" }, isPartial: true, executionStarted: true });
		plainText(write.renderCall({ path: "f.txt", content: "x" }, theme, ctx));
	}
	// 等到全局相位翻到 false，并且至少跑过一个 tick 填充 budget（最近 5 个 = w3..w7）。
	const deadline = Date.now() + 4000;
	while (currentBlinkPhase() !== false && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 30));
	}
	assert.equal(currentBlinkPhase(), false, "应观察到全局 off 相位");
	// budget = 最近 5 个（w3..w7）；w1/w2 在预算外。修复后预算外恒 visible。
	assert.equal(currentBlinkPhase("w1"), true, "预算外 w1 应恒 visible，不随 off 相位消失");
	assert.equal(currentBlinkPhase("w2"), true, "预算外 w2 应恒 visible，不随 off 相位消失");
	// 预算内的至少一个跟随全局相位（此刻 off）。
	const inBudget = ["w3", "w4", "w5", "w6", "w7"].map((id) => currentBlinkPhase(id));
	assert.ok(inBudget.some((v) => v === false), "预算内的点应跟随全局相位（此刻应有 off）");
});
