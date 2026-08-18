/**
 * 基座冒烟：证明 FakePi 能加载扩展、工具渲染器能跑、事件能触发。
 * 这不是任何 AUDIT.md 条目的回归测试，只是测试基座自身的验收。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx, startSession } from "./harness.js";
import { plainText } from "./helpers.js";

test("扩展加载：7 个内置工具全部注册", async () => {
	const pi = await loadExtension();
	for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
		assert.ok(pi.tools.has(name), `tool ${name} registered`);
	}
	// 注：mcp 通配工具的注册是 AUDIT.md B1 条目（mcp.ts:100 死代码），
	// 修好前 getAllTools() 为空时不注册任何东西，这里不做断言。
});

test("扩展加载：session_start 后 footer / header / 命令 / markdown transformer 就位", async () => {
	const pi = await loadExtension();
	await startSession(pi);
	assert.equal(typeof pi.ui.footerFactory, "function", "setFooter called");
	assert.equal(typeof pi.ui.headerFactory, "function", "setHeader called");
	assert.ok(pi.commands.size >= 1, "at least one command");
	assert.equal(pi.markdownTransformers.length, 1, "thinking transformer");
});

test("read 工具：renderCall + renderResult 不炸且产出 CC 文案", async () => {
	const pi = await loadExtension();
	const read = pi.tools.get("read")!;
	const theme = new FakeTheme();
	const { ctx } = makeToolCtx({ args: { path: "foo/bar.txt" } });
	const call = read.renderCall({ path: "foo/bar.txt" }, theme, ctx);
	assert.match(plainText(call), /bar\.txt/, "call line shows path");

	const result = read.renderResult(
		{ content: [{ type: "text", text: "line1\nline2\nline3" }] },
		{ expanded: false, isPartial: false },
		theme,
		makeToolCtx({ args: { path: "foo/bar.txt" } }).ctx,
	);
	const text = plainText(result);
	assert.match(text, /Read/, "result says Read");
	assert.match(text, /3 lines|3/, "result mentions line count");
});

test("事件总线：tool_execution_start/end 能被分组器消费", async () => {
	const pi = await loadExtension();
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await pi.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "a.txt" } });
	await pi.emit("tool_execution_end", { toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "x" }] }, isError: false });
	await pi.emit("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
	// 不抛即通过；分组行为在各自条目测试里断言
	assert.ok(true);
});

test("FakeTheme.fg 记录 token 调用", () => {
	const theme = new FakeTheme();
	theme.fg("accent", "x");
	assert.equal(theme.fgCalls.length, 1);
	assert.equal(theme.fgCalls[0].token, "accent");
});
