/**
 * AUDIT §5 thinking.ts:114 (P3 correctness): message_end 对 user prompt
 * (agent-loop.js:53) 和 toolResult (:551) 也会触发,不止 assistant。若不过滤
 * role,user / toolResult 的 message_end 会在 assistant 还在思考时错误清掉
 * spinner 的 (thinking) 态。
 *
 * 归属变更:spinner 行的 thinking 段(含 message_end abort 兜底)现在整体由
 * spinner.ts 拥有(thinking.ts 的 setWorkingMessage 竞态路径已删,对抗复审
 * confirmed)。role 过滤语义在 spinner.ts 的 message_end handler 落地
 * (`event.message?.role !== "assistant"` 直接 return)。
 *
 * 本测试驱动全扩展(loadExtension 注册 spinner),spinner 是 50ms 自绘,事件
 * 后等一拍再读 FakeUI 的 workingMessage。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, loadExtension } from "./harness.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 80));

async function openThinking(): Promise<FakePi> {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await pi.emit("message_update", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	});
	await tick();
	return pi;
}

test("user 消息的 message_end 不改动 spinner（thinking 态保留）", async () => {
	const pi = await openThinking();
	assert.match(pi.ui.workingMessage ?? "", /thinking/i, `前提：spinner 处于 thinking，实际: ${pi.ui.workingMessage}`);

	await pi.emit("message_end", { message: { role: "user" } });
	await tick();
	assert.match(pi.ui.workingMessage ?? "", /thinking/i, `user message_end 不应清掉 thinking 态，实际: ${pi.ui.workingMessage}`);
});

test("toolResult 消息的 message_end 不改动 spinner", async () => {
	const pi = await openThinking();
	await pi.emit("message_end", { message: { role: "toolResult" } });
	await tick();
	assert.match(pi.ui.workingMessage ?? "", /thinking/i, `toolResult message_end 不应清掉 thinking 态，实际: ${pi.ui.workingMessage}`);
});

test("只有 assistant 消息的 message_end 才结算思考态", async () => {
	const pi = await openThinking();
	assert.match(pi.ui.workingMessage ?? "", /thinking/i, "前提：spinner 处于 thinking");

	await pi.emit("message_end", { message: { role: "assistant", content: [] } });
	await tick();
	assert.doesNotMatch(pi.ui.workingMessage ?? "", /thinking/i, `assistant message_end 应结算 thinking 段，实际: ${pi.ui.workingMessage}`);
});

test("缺 message.role 的 message_end 不误伤（当作非 assistant 忽略）", async () => {
	const pi = await openThinking();
	await pi.emit("message_end", {}); // 没有 message 字段
	await tick();
	assert.match(pi.ui.workingMessage ?? "", /thinking/i, `无 role 的 message_end 应被忽略，实际: ${pi.ui.workingMessage}`);
});
