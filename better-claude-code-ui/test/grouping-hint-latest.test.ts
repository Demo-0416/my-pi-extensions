/**
 * AUDIT §5:596 (P2 ×2) — ⎿ 提示行取「第一个 pending 成员」而不是最新的：
 *  1) 并行批次里会卡在第一个文件上；
 *  2) leader 是 ls（无 hint）时提示行直接消失，即便组里后面的 grep/read 有 hint。
 *
 * 修复：latestHint 从最新成员往回找第一个带 hint 的（优先 pending），
 * 对齐 CC readPaths.at(-1)/searchArgs.at(-1)。
 *
 * 通过折叠摘要行的渲染验证 ⎿ 行内容（hintLineFor 未导出，走 renderCall）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";

async function bootTwoTools(pi: FakePi, specs: Array<{ id: string; name: string; args: Record<string, unknown> }>): Promise<void> {
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	for (const s of specs) {
		await pi.emit("tool_execution_start", { toolCallId: s.id, toolName: s.name, args: s.args });
	}
}

/** 渲染 leader 的折叠摘要行（含 ⎿ hint 行）纯文本。 */
function renderLeader(pi: FakePi, leaderId: string, name: string, args: Record<string, unknown>): string {
	const tool = pi.tools.get(name)!;
	const theme = new FakeTheme();
	const { ctx } = makeToolCtx({ toolCallId: leaderId, args, isPartial: true, executionStarted: true });
	return plainText(tool.renderCall(args, theme, ctx));
}

test("并行批次的 ⎿ hint 取最新成员，不卡在第一个文件", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	// 两个并行 read，b.txt 后加入 → hint 应显示 b.txt。
	await bootTwoTools(pi, [
		{ id: "r1", name: "read", args: { path: "a.txt" } },
		{ id: "r2", name: "read", args: { path: "b.txt" } },
	]);
	const text = renderLeader(pi, "r1", "read", { path: "a.txt" });
	assert.match(text, /⎿/, `应有 ⎿ 提示行，实际: ${text}`);
	assert.match(text, /b\.txt/, `hint 应取最新加入的 b.txt，实际: ${text}`);
});

test("leader 是 ls 时，⎿ hint 仍显示组内后续 grep 的 pattern", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	// ls 作 leader（无 hint），后面跟一个 grep（有 pattern）。
	await bootTwoTools(pi, [
		{ id: "l1", name: "ls", args: { path: "." } },
		{ id: "g1", name: "grep", args: { pattern: "needle" } },
	]);
	const text = renderLeader(pi, "l1", "ls", { path: "." });
	assert.match(text, /⎿/, `ls leader 也应有 ⎿ 提示行，实际: ${text}`);
	assert.match(text, /needle/, `hint 应显示后续 grep 的 pattern，而非空行，实际: ${text}`);
});
