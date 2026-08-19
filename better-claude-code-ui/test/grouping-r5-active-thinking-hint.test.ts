/**
 * CC v2.1.234 行为（AUDIT §6 P2 + 用户实测,本地 CC 源码快照已过期）:
 *
 *  1. 组保持现在时到整轮生成结束:工具全部跑完后,只要 agent 循环还在
 *     (agent_start..agent_end 之间)且组后没有正文,最新组仍是 active——
 *     摘要显示 "Reading N files…" 而非 "Read N files"。
 *  2. agent_end 落定 → 过去时。
 *  3. assistant 正文(text_start)落在组后 → 组立即落定(hasContentAfter)。
 *  4. 思考完一段(thinking_end)后,active 组的 ⎿ hint 显示 thinking 文本
 *     (非流式);更新的工具调用启动后,hint 换回工具侧。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";

async function beginTurn(pi: FakePi): Promise<void> {
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
}

async function readCall(pi: FakePi, id: string): Promise<void> {
	await pi.emit("tool_execution_start", { toolCallId: id, toolName: "read", args: { path: `${id}.txt` } });
	await pi.emit("tool_execution_end", {
		toolCallId: id,
		toolName: "read",
		result: { content: [{ type: "text", text: "x" }] },
		isError: false,
	});
}

function summaryOf(pi: FakePi, leaderId: string): string {
	const tool = pi.tools.get("read")!;
	const theme = new FakeTheme();
	const { ctx } = makeToolCtx({ toolCallId: leaderId, args: { path: `${leaderId}.txt` }, expanded: false });
	return plainText(tool.renderCall({ path: `${leaderId}.txt` }, theme, ctx));
}

test("工具全结束但生成未结束:组保持现在时;agent_end 后变过去时", async () => {
	const pi = await loadExtension();
	await beginTurn(pi);
	await readCall(pi, "r1");
	await readCall(pi, "r2");

	// agent 循环仍在(未 agent_end):CC 保持进行时。
	const active = summaryOf(pi, "r1");
	assert.match(active, /Reading 2 files/i, `生成中应为现在时 Reading,实际: ${active}`);
	assert.match(active, /…/, `active 摘要应带省略号,实际: ${active}`);

	// agent_end → settle(结算在 microtask 里)。
	await pi.emit("agent_end");
	await new Promise((r) => setTimeout(r, 0));
	const settled = summaryOf(pi, "r1");
	assert.match(settled, /Read 2 files/i, `落定后应为过去时 Read,实际: ${settled}`);
	assert.doesNotMatch(settled, /Reading/i, `落定后不应再是 Reading,实际: ${settled}`);
});

test("正文 text_start 落在组后:组立即落定为过去时(hasContentAfter)", async () => {
	const pi = await loadExtension();
	await beginTurn(pi);
	await readCall(pi, "r1");

	assert.match(summaryOf(pi, "r1"), /Reading/i, "前置:正文前应为现在时");
	await pi.emit("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: "" }] },
		assistantMessageEvent: { type: "text_start", contentIndex: 0 },
	});
	const settled = summaryOf(pi, "r1");
	assert.match(settled, /Read 1 file/i, `正文出现后应为过去时,实际: ${settled}`);
});

test("thinking_end 后 ⎿ hint 显示 thinking 文本;新工具启动后换回工具 hint", async () => {
	const pi = await loadExtension();
	await beginTurn(pi);
	await readCall(pi, "r1");

	// 思考完一段(组仍 active):⎿ 显示 thinking 文本(压缩空白)。
	// 真实流序里 thinking_end 晚于上一批工具 start 至少数百 ms;时间戳仲裁
	// 用严格大于,这里隔开 2ms 避免同毫秒打平。
	await new Promise((r) => setTimeout(r, 2));
	await pi.emit("message_update", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
		assistantMessageEvent: {
			type: "thinking_end",
			contentIndex: 0,
			content: "先看 read 的结果,\n再决定 grep 什么",
		},
	});
	const withThinking = summaryOf(pi, "r1");
	assert.match(
		withThinking,
		/⎿\s+先看 read 的结果, 再决定 grep 什么/,
		`⎿ 应显示 thinking 文本,实际:\n${withThinking}`,
	);

	// 新工具启动(时间戳更新):hint 换回工具侧。700ms hold 需要等待。
	await new Promise((r) => setTimeout(r, 720));
	await pi.emit("tool_execution_start", { toolCallId: "g1", toolName: "grep", args: { pattern: "foo" } });
	await new Promise((r) => setTimeout(r, 720));
	const withTool = summaryOf(pi, "r1");
	assert.match(withTool, /⎿\s+"foo"/, `新工具启动后 ⎿ 应显示其 pattern,实际:\n${withTool}`);
});

test("thinking 完成于组建立之前:文本随下一个组出现在 ⎿", async () => {
	const pi = await loadExtension();
	await beginTurn(pi);

	// 先思考(此时无任何组),后建组。
	await pi.emit("message_update", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "准备读文件" },
	});
	await pi.emit("tool_execution_start", { toolCallId: "r1", toolName: "read", args: { path: "r1.txt" } });

	// 工具 startedAt 比 thinking 新 → 工具 hint 胜出(CC:新事件优先)。
	const text = summaryOf(pi, "r1");
	assert.match(text, /⎿\s+r1\.txt/, `更新的工具调用应赢得 ⎿,实际:\n${text}`);
});
