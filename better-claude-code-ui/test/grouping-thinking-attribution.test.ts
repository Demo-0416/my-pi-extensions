/**
 * AUDIT §5:449 (P2 ×1) — 同一条 assistant 消息里第二段及以后的 thinking 全被记成 0ms。
 *
 * 根因：message_update 的 event.message.content 是累积流式数组。旧逻辑
 * 「hasThinking && hasOther」在第二段 thinking 出现时，同一 tick 里既检测到
 * thinking（重新开区间）又检测到之前的 text（立刻关区间）→ 第二段+ thinking
 * 归 0ms。修复：按最后一个（正在流的）块判定开/关。
 *
 * 断言：一段 thinking → text → 再一段 thinking → toolCall 的流式序列，
 * 两段 thinking 的时长都被累加进 pendingThinkingMs，最终折进折叠组的
 * "thought for Xs"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";

/** 睡 ms 毫秒，让 Date.now() 真实推进（thinking 归因用真实钟）。 */
function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

test("第二段 thinking 也被计入时长（不再记 0ms）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });

	// 第 1 段 thinking 开始。
	await pi.emit("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "step 1" }] } });
	await sleep(40);
	// text 出现 → 第 1 段 thinking 关闭（累加 ~40ms）。
	await pi.emit("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "step 1" }, { type: "text", text: "hmm" }] } });
	await sleep(20);
	// 第 2 段 thinking 出现在末尾 → 重新开区间（旧逻辑这里会被 text 立刻关掉记 0ms）。
	await pi.emit("message_update", {
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "step 1" },
				{ type: "text", text: "hmm" },
				{ type: "thinking", thinking: "step 2" },
			],
		},
	});
	await sleep(60);
	// toolCall 出现在末尾 → 第 2 段 thinking 关闭（累加 ~60ms）。
	await pi.emit("message_update", {
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "step 1" },
				{ type: "text", text: "hmm" },
				{ type: "thinking", thinking: "step 2" },
				{ type: "toolCall", id: "t1" },
			],
		},
	});

	// 两个连续只读工具形成一个折叠组，thinking 时长折进摘要行。
	await pi.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "a.txt" } });
	await pi.emit("tool_execution_start", { toolCallId: "t2", toolName: "read", args: { path: "b.txt" } });

	const read = pi.tools.get("read")!;
	const theme = new FakeTheme();
	const { ctx } = makeToolCtx({ toolCallId: "t1", args: { path: "a.txt" }, isPartial: true, executionStarted: true });
	const call = read.renderCall({ path: "a.txt" }, theme, ctx);
	const text = plainText(call);

	// 累计 thinking ≈ 100ms → 未达 1s 阈值不会显示 thinking 片段。放宽验证：
	// 关键是两段都被累加。直接读模块内部不便，改为断言在足够长的段上会显示。
	// 这里 100ms < 1s，所以摘要不含 thinking——用长睡版本单独验证累加。
	assert.match(text, /Read|reading/i, `应渲染折叠 read 组，实际: ${text}`);
});

test("两段各 >0.5s 的 thinking 累加后越过 1s 阈值，显示 thought for", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });

	await pi.emit("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "a" }] } });
	await sleep(600);
	await pi.emit("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "a" }, { type: "text", text: "x" }] } });
	await sleep(50);
	// 第 2 段 thinking：旧逻辑记 0ms，会导致总量停在 ~0.6s < 1s，不显示片段。
	await pi.emit("message_update", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "a" }, { type: "text", text: "x" }, { type: "thinking", thinking: "b" }] },
	});
	await sleep(600);
	await pi.emit("message_update", {
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking: "a" }, { type: "text", text: "x" }, { type: "thinking", thinking: "b" }, { type: "toolCall", id: "t1" }],
		},
	});

	await pi.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "a.txt" } });
	await pi.emit("tool_execution_start", { toolCallId: "t2", toolName: "read", args: { path: "b.txt" } });
	await pi.emit("tool_execution_end", { toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "x" }] }, isError: false });
	await pi.emit("tool_execution_end", { toolCallId: "t2", toolName: "read", result: { content: [{ type: "text", text: "y" }] }, isError: false });

	const read = pi.tools.get("read")!;
	const theme = new FakeTheme();
	const { ctx } = makeToolCtx({ toolCallId: "t1", args: { path: "a.txt" }, isPartial: false });
	const call = read.renderCall({ path: "a.txt" }, theme, ctx);
	const text = plainText(call);
	// 累计 ≈ 1.2s ≥ 1s → 折叠组落定，显示过去时 "thought for 1s"。
	assert.match(text, /thought for \ds/i, `两段 thinking 累加应越过 1s 阈值显示 thought for，实际: ${text}`);
});
