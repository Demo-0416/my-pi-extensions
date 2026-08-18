/**
 * AUDIT §5:754 (P2 ×3) — 折叠组展开视图：最后一个成员用 └ 收口，但它的结果行
 * 仍用 │ 续接，树线在收口后继续往下画。修复：最后一个成员的结果续行用空白
 * padding，不再画竖线。
 *
 * 断言：展开一个多成员组，最后一个成员的结果续行不以 │ 开头（非最后成员仍是 │）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plain } from "./helpers.js";

test("最后一个成员的结果续行不再画 │（树线在 └ 处收口）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	// 两个 bash（只读）成组；两个都有多行输出。
	await pi.emit("tool_execution_start", { toolCallId: "b1", toolName: "bash", args: { command: "cat a" } });
	await pi.emit("tool_execution_start", { toolCallId: "b2", toolName: "bash", args: { command: "cat b" } });
	await pi.emit("tool_execution_end", { toolCallId: "b1", toolName: "bash", result: { content: [{ type: "text", text: "l1\nl2\nl3" }] }, isError: false });
	await pi.emit("tool_execution_end", { toolCallId: "b2", toolName: "bash", result: { content: [{ type: "text", text: "z1\nz2\nz3" }] }, isError: false });

	// 展开视图（expanded=true）由 leader 渲染整组。
	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();
	const { ctx } = makeToolCtx({ toolCallId: "b1", args: { command: "cat a" }, expanded: true, isPartial: false });
	const lines = plain(bash.renderCall({ command: "cat a" }, theme, ctx), 100);

	// 找 └ 所在行（最后一个成员的 glance 行）之后的续行。
	const closerIdx = lines.findIndex((l) => l.includes("└"));
	assert.ok(closerIdx >= 0, `应有 └ 收口行，实际:\n${lines.join("\n")}`);
	const afterCloser = lines.slice(closerIdx + 1);
	// └ 之后的所有续行都不应以 │ 开头（树线已收口）。
	for (const l of afterCloser) {
		assert.ok(!l.trimStart().startsWith("│"), `└ 收口后不应再画 │，越界行: ${JSON.stringify(l)}\n全部:\n${lines.join("\n")}`);
	}
	// 反向保证：非最后成员（b1）的结果续行仍用 │（├ 之后、└ 之前）。
	const openerIdx = lines.findIndex((l) => l.includes("├"));
	assert.ok(openerIdx >= 0 && openerIdx < closerIdx, "应有 ├ 开头的非最后成员行");
	const between = lines.slice(openerIdx + 1, closerIdx);
	assert.ok(between.some((l) => l.trimStart().startsWith("│")), `非最后成员的结果续行应仍用 │，实际:\n${between.join("\n")}`);
});
