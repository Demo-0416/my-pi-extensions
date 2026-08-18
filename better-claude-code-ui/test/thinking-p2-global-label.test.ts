/**
 * AUDIT §5 thinking.ts:77 (P2 api-contract): setHiddenThinkingLabel 是 GLOBAL
 * 标签——写一次会刷写 chatContainer 里所有历史 AssistantMessageComponent 的标签
 * （interactive-mode.js:1655-1666）。旧实现把某一块的 `∴ Thought for Xs` 时长写
 * 进这个全局标签，等于把整个会话历史里所有 thinking 折叠行都改成最新一块的时长
 * （AUDIT §3-1 的 `∴ 15s` 四不像）。
 *
 * 修复：隐藏标签只放 per-block-agnostic 的常量，thinking_end / message_end 都不再
 * 往里写时长。`thought for Xs` 收尾态属于 spinner 行（AUDIT §6 spinner P2），不在
 * 这个全局标签里。
 *
 * 本测试直接驱动 registerThinking(pi)，观察 FakeUI 捕获的 hiddenThinkingLabel。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi } from "./harness.js";
import { registerThinking } from "../extension/thinking.js";

function thinkingPi(): FakePi {
	const pi = new FakePi();
	registerThinking(pi);
	return pi;
}

const DURATION_RE = /\d+\s*s\b|Thought for/i;

test("thinking_end 后隐藏标签保持常量，绝不写 per-block 时长", async () => {
	const pi = thinkingPi();
	await pi.emit("session_start", { reason: "startup" });
	const resting = pi.ui.hiddenThinkingLabel;
	assert.ok(resting, "session_start 应设定常量折叠标签");
	assert.doesNotMatch(resting ?? "", DURATION_RE, "初始标签不应含时长");

	await pi.emit("turn_start");
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_start" },
	});
	await new Promise((r) => setTimeout(r, 20)); // 制造非零思考时长
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_end" },
	});

	assert.equal(pi.ui.hiddenThinkingLabel, resting, `thinking_end 后标签应保持常量，实际: ${pi.ui.hiddenThinkingLabel}`);
	assert.doesNotMatch(pi.ui.hiddenThinkingLabel ?? "", DURATION_RE, "thinking_end 后标签不应含时长");
});

test("message_end 兜底也不写时长（assistant 消息）", async () => {
	const pi = thinkingPi();
	await pi.emit("session_start", { reason: "startup" });
	const resting = pi.ui.hiddenThinkingLabel;

	await pi.emit("turn_start");
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_start" },
	});
	await new Promise((r) => setTimeout(r, 20));
	// abort：无 thinking_end，直接 message_end。
	await pi.emit("message_end", { message: { role: "assistant" } });

	assert.equal(pi.ui.hiddenThinkingLabel, resting, `message_end 后标签仍应是常量，实际: ${pi.ui.hiddenThinkingLabel}`);
	assert.doesNotMatch(pi.ui.hiddenThinkingLabel ?? "", DURATION_RE, "message_end 后标签不应含时长");
});
