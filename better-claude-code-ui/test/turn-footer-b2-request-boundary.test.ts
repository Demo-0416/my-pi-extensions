/**
 * AUDIT §5 turn-footer.ts:48 (P1 ×5): turn footer 原来挂在 turn_end 上，而 pi 的
 * turn 是一轮 agent-loop 迭代（一次 LLM 回复 + 其工具），一次用户请求 =
 * 1 个 agent_start + N 个 turn_start/turn_end + 1 个 agent_end（AUDIT §3-2，
 * pi agent-loop.js:43-131）。所以一次多轮请求会刷出 N 条 `✻ Worked for Ns`。
 *
 * 修复：改挂 agent_start(首个记时) … agent_settled(结算一次)。agent_settled 在
 * _runAgentPrompt 的 finally 里每次请求只发一次（pi agent-session.js:744-756），
 * 覆盖初始 prompt + 所有 continuation（重试/压缩/follow-up），正好对应 CC 的
 * “一次请求一行” 语义（CC REPL.tsx:4004）。
 *
 * 这里用 node:test 的 mock.timers 控制 Date.now，模拟一次跨 3 个 turn 的 40s
 * 请求，断言 appendEntry 只被调用一次；再模拟一次 <30s 的请求，断言不追加。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, loadExtension } from "./harness.js";

test("一次 >30s 的多轮请求只追加一条 turn footer（不再每 turn 一条）", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
	const pi = new FakePi();
	await loadExtension(pi);

	const before = pi.appendedEntries.filter((e) => e.customType === "cc-turn-footer").length;

	// 一次请求：agent_start → 3 轮 turn_start/turn_end（每轮推进 15s）→ agent_settled。
	// 总时长 45s > 30s 阈值。
	await pi.emit("agent_start");
	for (let i = 0; i < 3; i++) {
		await pi.emit("turn_start", { turnIndex: i, timestamp: Date.now() });
		t.mock.timers.tick(15_000);
		await pi.emit("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] });
	}
	await pi.emit("agent_settled");

	const footers = pi.appendedEntries.filter((e) => e.customType === "cc-turn-footer");
	assert.equal(footers.length - before, 1, `一次请求应只追加一条 footer，实际 ${footers.length - before}`);
	const data = footers[footers.length - 1]!.data as { ms: number; verb: string };
	assert.ok(data.ms >= 45_000, `时长应覆盖整个请求(≥45s)，实际 ${data.ms}ms`);
});

test("短请求也追加 footer(CC v2.1.234 实测 4s/11s 都显示),但 <1s 不追加", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
	const pi = new FakePi();
	await loadExtension(pi);
	const count = () => pi.appendedEntries.filter((e) => e.customType === "cc-turn-footer").length;

	// 10s 请求:旧 30s 阈值来自过期 CC 快照;v2.1.234 每次请求都打 footer。
	const before = count();
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	t.mock.timers.tick(10_000);
	await pi.emit("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
	await pi.emit("agent_settled");
	assert.equal(count() - before, 1, "10s 的请求也应追加 footer");

	// <1s 请求:CC 从不显示 "0s" footer。
	const mid = count();
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	t.mock.timers.tick(500);
	await pi.emit("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
	await pi.emit("agent_settled");
	assert.equal(count() - mid, 0, "亚秒请求不应追加 footer");
});

test("连续两次请求各自结算，互不串时长", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
	const pi = new FakePi();
	await loadExtension(pi);
	const kind = (e: { customType: string }) => e.customType === "cc-turn-footer";

	// 请求 1：40s
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	t.mock.timers.tick(40_000);
	await pi.emit("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
	await pi.emit("agent_settled");

	// 空档 100s（不在请求内，不应计入下一次）
	t.mock.timers.tick(100_000);

	// 请求 2：35s
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	t.mock.timers.tick(35_000);
	await pi.emit("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
	await pi.emit("agent_settled");

	const footers = pi.appendedEntries.filter(kind);
	assert.equal(footers.length, 2, "两次请求两条 footer");
	const d1 = footers[0]!.data as { ms: number };
	const d2 = footers[1]!.data as { ms: number };
	assert.ok(d1.ms >= 40_000 && d1.ms < 45_000, `请求1约 40s，实际 ${d1.ms}`);
	assert.ok(d2.ms >= 35_000 && d2.ms < 40_000, `请求2应约 35s（不含 100s 空档），实际 ${d2.ms}`);
});
