/**
 * AUDIT §5 ×7 P1 builtins.ts:368 — 展开态分组 leader 的 glance 行不得画两遍。
 *
 * pi 的 ToolExecutionComponent 会无条件把 renderCall 和 renderResult 的产物
 * 都 addChild 到同一容器（tool-execution.js:228-263）。修复前 renderGroupCall
 * 用空结果回调画一遍 glance 行、renderGroupResult 又带结果画一遍，整组重复。
 * 修复后：renderGroupCall 画全组（含结果预览），renderGroupResult 返回 ""。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";

async function buildReadGroup(pi: FakePi): Promise<void> {
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	for (const id of ["r1", "r2", "r3"]) {
		await pi.emit("tool_execution_start", { toolCallId: id, toolName: "read", args: { path: `${id}.txt` } });
	}
	for (const id of ["r1", "r2", "r3"]) {
		await pi.emit("tool_execution_end", {
			toolCallId: id,
			toolName: "read",
			result: { content: [{ type: "text", text: `contents of ${id}` }] },
			isError: false,
		});
	}
}

test("展开态分组：leader 的 glance 行只出现一次（renderCall+renderResult 合起来不重复）", async () => {
	const pi = await loadExtension();
	await buildReadGroup(pi);

	const read = pi.tools.get("read")!;
	const theme = new FakeTheme();

	// leader = r1。expanded=true 走 preview 分支。
	const callCtx = makeToolCtx({ args: { path: "r1.txt" }, toolCallId: "r1", expanded: true });
	const resCtx = makeToolCtx({ args: { path: "r1.txt" }, toolCallId: "r1", expanded: true });

	const callText = plainText(read.renderCall({ path: "r1.txt" }, theme, callCtx.ctx));
	const resultText = plainText(
		read.renderResult(
			{ content: [{ type: "text", text: "contents of r1" }] },
			{ expanded: true, isPartial: false },
			theme,
			resCtx.ctx,
		),
	);

	// pi 把两者拼在一起显示。
	const combined = `${callText}\n${resultText}`;
	// 每个成员的路径在合并输出里只应出现一次。
	for (const p of ["r1.txt", "r2.txt", "r3.txt"]) {
		const count = combined.split(p).length - 1;
		assert.equal(count, 1, `${p} 应只出现一次，实际 ${count} 次\n---\n${combined}`);
	}
	// renderResult 在 preview 阶段必须是空（否则会重复画整组）。
	assert.equal(resultText.trim(), "", `renderResult preview 阶段应为空，实际:\n${resultText}`);
});
