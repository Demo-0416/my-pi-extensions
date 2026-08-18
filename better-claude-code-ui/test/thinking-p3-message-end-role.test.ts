/**
 * AUDIT §5 thinking.ts:114 (P3 correctness): thinking.ts 的 message_end 没有过滤
 * role。pi 的 message_end 对 user prompt（agent-loop.js:53）和 toolResult
 * （:551）也会触发，不止 assistant 消息。旧实现在任何 message_end 上都会重置
 * working message（和当时的隐藏标签），于是 user / toolResult 消息也会在 assistant
 * 还在思考时错误地清掉 (thinking) spinner 态。
 *
 * 修复：message_end 先判 `event.message.role !== "assistant"` 直接 return，只有
 * assistant 消息才结算思考态。
 *
 * 本测试直接驱动 registerThinking(pi)，观察 FakeUI 捕获的 workingMessage。
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

async function openThinking(pi: FakePi): Promise<void> {
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("turn_start");
	await pi.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_start" },
	});
}

test("user 消息的 message_end 不改动 spinner（thinking 态保留）", async () => {
	const pi = thinkingPi();
	await openThinking(pi);
	const thinkingSpinner = pi.ui.workingMessage;
	assert.match(thinkingSpinner ?? "", /thinking/i, "前提：spinner 处于 (thinking)");

	await pi.emit("message_end", { message: { role: "user" } });
	assert.equal(pi.ui.workingMessage, thinkingSpinner, `user message_end 不应改动 spinner，实际: ${pi.ui.workingMessage}`);
});

test("toolResult 消息的 message_end 不改动 spinner", async () => {
	const pi = thinkingPi();
	await openThinking(pi);
	const thinkingSpinner = pi.ui.workingMessage;

	await pi.emit("message_end", { message: { role: "toolResult" } });
	assert.equal(pi.ui.workingMessage, thinkingSpinner, `toolResult message_end 不应改动 spinner，实际: ${pi.ui.workingMessage}`);
});

test("只有 assistant 消息的 message_end 才结算思考态（恢复动词）", async () => {
	const pi = thinkingPi();
	await openThinking(pi);
	assert.match(pi.ui.workingMessage ?? "", /thinking/i, "前提：spinner 处于 (thinking)");

	await pi.emit("message_end", { message: { role: "assistant" } });
	assert.doesNotMatch(pi.ui.workingMessage ?? "", /thinking/i, `assistant message_end 应恢复动词，实际: ${pi.ui.workingMessage}`);
});

test("缺 message.role 的 message_end 不误伤（当作非 assistant 忽略）", async () => {
	const pi = thinkingPi();
	await openThinking(pi);
	const thinkingSpinner = pi.ui.workingMessage;

	await pi.emit("message_end", {}); // 没有 message 字段
	assert.equal(pi.ui.workingMessage, thinkingSpinner, `无 role 的 message_end 应被忽略，实际: ${pi.ui.workingMessage}`);
});
