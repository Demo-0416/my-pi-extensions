/**
 * AUDIT §5 ×5 P2 builtins.ts:440 — read 带 limit 时 "Read N lines" 不把续读提示算进去。
 *
 * pi 的 read 在用户 limit 提前停住且文件还有内容时，会在文本尾部追加:
 *   "\n\n[N more lines in file. Use offset=N to continue.]"（read.js:243）
 * 且不设 details.truncation。修复前 countLines 把空行 + 提示行多算 2 行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";

test("read 带 limit 续读提示：Read N lines 不多算 2 行", async () => {
	const pi = await loadExtension();
	const read = pi.tools.get("read")!;
	const theme = new FakeTheme();
	// 3 行真实内容 + pi 追加的续读提示。
	const text = "line1\nline2\nline3\n\n[42 more lines in file. Use offset=4 to continue.]";
	const { ctx } = makeToolCtx({ args: { path: "a.txt", limit: 3 } });
	const comp = read.renderResult(
		{ content: [{ type: "text", text }] },
		{ expanded: false, isPartial: false },
		theme,
		ctx,
	);
	const out = plainText(comp);
	assert.match(out, /Read 3 lines/, `应是 Read 3 lines，实际:\n${out}`);
	assert.doesNotMatch(out, /Read 5 lines/, "不应把续读提示算成 2 行");
});

test("read 展开态：预览体不含续读提示行", async () => {
	const pi = await loadExtension();
	const read = pi.tools.get("read")!;
	const theme = new FakeTheme();
	const text = "line1\nline2\nline3\n\n[42 more lines in file. Use offset=4 to continue.]";
	const { ctx } = makeToolCtx({ args: { path: "a.txt", limit: 3 }, expanded: true });
	const comp = read.renderResult(
		{ content: [{ type: "text", text }] },
		{ expanded: true, isPartial: false },
		theme,
		ctx,
	);
	const out = plainText(comp);
	assert.doesNotMatch(out, /more lines in file/, `预览体不应含续读提示:\n${out}`);
	assert.match(out, /Read 3 lines/, "统计仍为 3 行");
});
