/**
 * AUDIT §5:399 (P1 ×6) + §5:493 (P1 ×1) — 组生命周期两条：
 *
 * §5:493 新建组不主动刷新 leader：当后一个成员加入、和一个「已结束（已渲染
 *   standalone 行）的 leader」组成新组时，新组 invalidator=undefined，
 *   invalidateGroups 无法让 leader 重渲染 → 组只剩 leader 第一行、后续成员消失。
 *   修复：registerGroupInvalidator 记录每个工具最新的 invalidate，
 *   invalidateGroups 用 leader 的兜底 invalidate 促其重画。
 *
 * §5:399 turn_start 清空组 + Ctrl+O 全局重渲染 → 历史组炸开：turn_start 清 groups
 *   后 groupOf() 对历史 turn 返回 undefined，隐藏成员各自画 standalone 行、leader
 *   丢摘要。修复：turn_start 前把settled组归档成轻壳（结果剥离），groupOf 也查
 *   archivedGroups，历史组仍折叠。B0 的 `tools = new Map()` 保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";

/** 渲染某工具的 renderCall 纯文本（作为组 leader / 隐藏成员 / standalone）。 */
function renderCall(pi: FakePi, name: string, toolCallId: string, args: Record<string, unknown>, expanded = false): { text: string; invalidateCalls: { count: number }; invalidate: () => void } {
	const tool = pi.tools.get(name)!;
	const theme = new FakeTheme();
	const { ctx, invalidateCalls } = makeToolCtx({ toolCallId, args, expanded, isPartial: false });
	const text = plainText(tool.renderCall(args, theme, ctx));
	return { text, invalidateCalls, invalidate: ctx.invalidate };
}

test("§5:493 新成员加入后，已结束的 leader 被促重渲染并接管整组", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });

	// r1 先开始、结束（单工具此时不成组）。渲染并注册 r1 的 invalidate。
	await pi.emit("tool_execution_start", { toolCallId: "r1", toolName: "read", args: { path: "a.txt" } });
	await pi.emit("tool_execution_end", { toolCallId: "r1", toolName: "read", result: { content: [{ type: "text", text: "x" }] }, isError: false });
	const first = renderCall(pi, "read", "r1", { path: "a.txt" });
	// 单工具：无组，渲染成 standalone "Read"。
	assert.match(first.text, /Read/, `r1 应渲染 Read，实际: ${first.text}`);
	const before = first.invalidateCalls.count;

	// r2 加入 → r1+r2 成组。invalidateGroups 应通过 r1 的兜底 invalidate 促其重渲染。
	await pi.emit("tool_execution_start", { toolCallId: "r2", toolName: "read", args: { path: "b.txt" } });
	assert.ok(first.invalidateCalls.count > before, `新成员加入后应促 leader 重渲染，count ${before}->${first.invalidateCalls.count}`);

	// 重渲染 r1 → 现在是组 leader，画折叠摘要（"Read 2 files"），r2 隐藏（0 行）。
	await pi.emit("tool_execution_end", { toolCallId: "r2", toolName: "read", result: { content: [{ type: "text", text: "y" }] }, isError: false });
	const leader = renderCall(pi, "read", "r1", { path: "a.txt" });
	// 生成尚未结束(无 agent_end),CC v2.1.234 语义下组保持现在时 "Reading"。
	// 本断言只关心 leader 接管整组(计数 2),时态两可。
	assert.match(leader.text, /Read(ing)? 2 files/i, `leader 应画整组摘要，实际: ${leader.text}`);
	const hidden = renderCall(pi, "read", "r2", { path: "b.txt" });
	assert.equal(hidden.text, "", `非 leader 成员应渲染 0 行，实际: ${JSON.stringify(hidden.text)}`);
});

test("§5:399 新请求(run)开始后历史组仍折叠：leader 画摘要、成员隐藏（不炸开）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	// run 1：两个 read 成组并结束。中途的 turn_start（每次 LLM 迭代一发）
	// 不再是归档边界——组窗口是 run 级(agent_start..agent_end)。
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await pi.emit("tool_execution_start", { toolCallId: "r1", toolName: "read", args: { path: "a.txt" } });
	await pi.emit("tool_execution_start", { toolCallId: "r2", toolName: "read", args: { path: "b.txt" } });
	await pi.emit("tool_execution_end", { toolCallId: "r1", toolName: "read", result: { content: [{ type: "text", text: "x" }] }, isError: false });
	await pi.emit("tool_execution_end", { toolCallId: "r2", toolName: "read", result: { content: [{ type: "text", text: "y" }] }, isError: false });
	// run 内的下一次 LLM 迭代:不得炸开当前组。
	await pi.emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
	const midRun = renderCall(pi, "read", "r1", { path: "a.txt" }, false);
	assert.match(midRun.text, /Read(ing)? 2 files/i, `run 内 turn_start 不应炸开组，实际: ${midRun.text}`);

	// run 1 结束、run 2 开始(新用户请求):归档 run-1 组。
	await pi.emit("agent_end");
	await new Promise((r) => setTimeout(r, 0));
	await pi.emit("agent_start");

	// 模拟 Ctrl+O 全局重渲染：重画 turn-1 的成员。历史组应仍折叠。
	const leader = renderCall(pi, "read", "r1", { path: "a.txt" }, false);
	assert.match(leader.text, /Read 2 files|read 2 files/i, `历史组 leader 仍应画折叠摘要，实际: ${leader.text}`);
	const hidden = renderCall(pi, "read", "r2", { path: "b.txt" }, false);
	assert.equal(hidden.text, "", `历史组非 leader 成员仍应隐藏（不炸成散行），实际: ${JSON.stringify(hidden.text)}`);

	// 展开视图：leader 画 glance 行（含两个成员），不是把成员各自铺开。
	const expanded = renderCall(pi, "read", "r1", { path: "a.txt" }, true);
	assert.match(expanded.text, /a\.txt/, `展开应含成员 a.txt，实际: ${expanded.text}`);
	assert.match(expanded.text, /b\.txt/, `展开应含成员 b.txt，实际: ${expanded.text}`);
	const hiddenExpanded = renderCall(pi, "read", "r2", { path: "b.txt" }, true);
	assert.equal(hiddenExpanded.text, "", `展开时非 leader 仍隐藏（由 leader 统一画），实际: ${JSON.stringify(hiddenExpanded.text)}`);
});
