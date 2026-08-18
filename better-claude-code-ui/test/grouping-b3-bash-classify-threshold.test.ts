/**
 * AUDIT §6（连续工具折叠摘要行，两条 P1）：
 *
 *  1. 只读 bash 被算进 "ran N bash commands"，而 CC 会算成 read/search/list。
 *     依据 CC collapseReadSearch.ts:831-882 (getToolSearchOrReadInfo)：read-only
 *     bash 按 classification 归入 list/search/read；只有 NON-read-only bash 才进
 *     bashCount，且仅在 fullscreen 下。pi 没有 fullscreen，非只读 bash 又没有
 *     classification（会打断分组、根本进不了组），所以进组的 bash 全是只读的，
 *     应按 classification.kind 归类，bashCount 恒为 0。
 *
 *  2. pi 要求连续 ≥2 个只读调用才折叠，CC 单个调用就折叠。
 *     依据 CC collapseReadSearch.ts:770-780 (flushGroup)：messages.length > 0 即
 *     建折叠组。阈值从 ≥2 改成 ≥1。
 *
 * 验证方式：驱动事件建组，通过 leader 的 renderCall 拿到折叠摘要行纯文本断言。
 * buildGroup/rebuildGroups 是模块内部函数，只能经事件+渲染观测（这也是它们的
 * 真实调用路径）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";

/** 起会话 + 一轮 turn。 */
async function beginTurn(pi: FakePi): Promise<void> {
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
}

/** 用组 leader（第一个工具）的 renderCall 拿折叠摘要行纯文本。 */
function summaryOf(pi: FakePi, toolName: string, leaderId: string, args: Record<string, unknown>): string {
	const tool = pi.tools.get(toolName)!;
	const theme = new FakeTheme();
	const { ctx } = makeToolCtx({ toolCallId: leaderId, args, isPartial: false, expanded: false });
	const call = tool.renderCall(args, theme, ctx);
	return plainText(call);
}

test("只读 bash 归入 read（不再是 'ran N bash commands'）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await beginTurn(pi);

	// 两个只读 bash（cat/head）—— classifyToolCall 判定为 read。
	await pi.emit("tool_execution_start", { toolCallId: "b1", toolName: "bash", args: { command: "cat a.txt" } });
	await pi.emit("tool_execution_start", { toolCallId: "b2", toolName: "bash", args: { command: "head b.txt" } });
	await pi.emit("tool_execution_end", { toolCallId: "b1", toolName: "bash", result: { content: [{ type: "text", text: "x" }] }, isError: false });
	await pi.emit("tool_execution_end", { toolCallId: "b2", toolName: "bash", result: { content: [{ type: "text", text: "y" }] }, isError: false });

	const text = summaryOf(pi, "bash", "b1", { command: "cat a.txt" });
	assert.match(text, /Read 2 files/i, `只读 bash 应归入 read，实际: ${text}`);
	assert.doesNotMatch(text, /bash command/i, `不应出现 "bash commands"，实际: ${text}`);
});

test("只读 bash：ls 归入 list、grep 归入 search（各自 disjoint 计数）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await beginTurn(pi);

	// ls → list；grep（bash 内的 grep）→ search。两者形成一个组。
	await pi.emit("tool_execution_start", { toolCallId: "l1", toolName: "bash", args: { command: "ls src" } });
	await pi.emit("tool_execution_start", { toolCallId: "g1", toolName: "bash", args: { command: "grep -rn foo src" } });
	await pi.emit("tool_execution_end", { toolCallId: "l1", toolName: "bash", result: { content: [{ type: "text", text: "a" }] }, isError: false });
	await pi.emit("tool_execution_end", { toolCallId: "g1", toolName: "bash", result: { content: [{ type: "text", text: "b" }] }, isError: false });

	const text = summaryOf(pi, "bash", "l1", { command: "ls src" });
	assert.match(text, /Searched for 1 pattern/i, `bash grep 应归入 search，实际: ${text}`);
	assert.match(text, /listed 1 directory/i, `bash ls 应归入 list，实际: ${text}`);
	assert.doesNotMatch(text, /bash command/i, `不应出现 "bash commands"，实际: ${text}`);
});

test("阈值 ≥1：单个只读工具也折叠成摘要行", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await beginTurn(pi);

	// 只有一个 read 调用。旧逻辑（≥2）不建组，renderCall 走普通工具行 "Read <path>"。
	// 新逻辑（≥1）建组，renderCall 走折叠摘要行 "Read 1 file (ctrl+o to expand)"。
	await pi.emit("tool_execution_start", { toolCallId: "r1", toolName: "read", args: { path: "only.txt" } });
	await pi.emit("tool_execution_end", { toolCallId: "r1", toolName: "read", result: { content: [{ type: "text", text: "hello" }] }, isError: false });

	const text = summaryOf(pi, "read", "r1", { path: "only.txt" });
	assert.match(text, /Read 1 file/i, `单个 read 应折叠成 "Read 1 file"，实际: ${text}`);
	assert.match(text, /ctrl\+o to expand/i, `折叠摘要行应带展开提示，实际: ${text}`);
});

test("单个只读 bash 也折叠（阈值 ≥1 + bash 归类共同作用）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await beginTurn(pi);

	await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "cat solo.txt" } });
	await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "z" }] }, isError: false });

	const text = summaryOf(pi, "bash", "c1", { command: "cat solo.txt" });
	assert.match(text, /Read 1 file/i, `单个只读 bash 应折叠成 "Read 1 file"，实际: ${text}`);
	assert.doesNotMatch(text, /bash command/i, `不应出现 "bash commands"，实际: ${text}`);
});
