/**
 * AUDIT §5:722 (P3 ×3) — glance 行把 bash 命令硬切到 72 字符且不加省略号，看起来
 * 像命令本身就是那样。修复：超长命令截断后追加 `…`。
 *
 * 断言：展开视图里超长 bash 命令的 glance 行以 `…` 结尾；短命令不加 `…`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText, plain } from "./helpers.js";

test("超长 bash 命令 glance 行以 … 结尾（不再像命令原样截断）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	const longCmd = "cat " + "a/very/long/path/segment/".repeat(6) + "file.txt";
	await pi.emit("tool_execution_start", { toolCallId: "b1", toolName: "bash", args: { command: longCmd } });
	await pi.emit("tool_execution_start", { toolCallId: "b2", toolName: "bash", args: { command: "cat short" } });
	await pi.emit("tool_execution_end", { toolCallId: "b1", toolName: "bash", result: { content: [{ type: "text", text: "x" }] }, isError: false });
	await pi.emit("tool_execution_end", { toolCallId: "b2", toolName: "bash", result: { content: [{ type: "text", text: "y" }] }, isError: false });

	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();
	const { ctx } = makeToolCtx({ toolCallId: "b1", args: { command: longCmd }, expanded: true, isPartial: false });
	const lines = plain(bash.renderCall({ command: longCmd }, theme, ctx), 200);
	// 第一个成员的 glance 行（含长命令）应以 … 结尾。
	const glance = lines.find((l) => /Bash\(/.test(l) && l.includes("cat a/very/long"));
	assert.ok(glance, `应有长命令 glance 行，实际:\n${lines.join("\n")}`);
	assert.match(glance!.trimEnd(), /…\)$/, `长命令 glance 行应以 …) 结尾，实际: ${JSON.stringify(glance)}`);
	// 短命令不加 …。
	const shortGlance = lines.find((l) => l.includes("cat short"));
	assert.ok(shortGlance, "应有短命令 glance 行");
	assert.doesNotMatch(shortGlance!, /…/, `短命令不应有 …，实际: ${JSON.stringify(shortGlance)}`);
});
