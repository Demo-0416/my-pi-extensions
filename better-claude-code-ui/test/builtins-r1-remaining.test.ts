/**
 * AUDIT R1 批次回归（builtins.ts 剩余条目）：
 *  - §5:158/:571/:611 — grep/find/ls 统计不把 notices 尾注 / context 行算进去
 *  - §5:499 — bash 成功输出里自带 "exit code: N" 不误判为失败
 *  - §5:315 — 预览省略提示单复数（1 more line / 1 earlier line）
 *  - §5:426 — 进行中占位文案用 … 而非 ASCII 三点
 *  - §5:712 — /resume 后（无快照）write 不再按新建渲染，降级为 Wrote N lines
 *  - §6 P1 — 行头动词：edit → Update；write 新建 → Create、覆盖 → Update
 *  - §5:817 — edit 优先用 result.details.patch 的真实行号
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";

function textResult(text: string, details?: unknown) {
	return { content: [{ type: "text", text }], details };
}

test("grep：notices 尾注与 context 行不计入 Found N files（§5:158/:571）", async () => {
	const pi = await loadExtension();
	const grep = pi.tools.get("grep")!;
	const theme = new FakeTheme();
	// 2 个文件的匹配行 + a.ts 的 context 行（path-N- 格式）+ limit 尾注。
	const text = [
		"src/a.ts:10: const x = 1",
		"src/a.ts-11- const y = 2",
		"src/b.ts:5: const z = 3",
		"",
		"[500 matches limit reached. Use limit=1000 for more, or refine pattern]",
	].join("\n");
	const { ctx } = makeToolCtx({ args: { pattern: "const" } });
	const out = plainText(grep.renderResult(textResult(text), { expanded: false, isPartial: false }, theme, ctx));
	assert.match(out, /Found 2 files/, `context 行与尾注不应算成文件，实际:\n${out}`);
});

test("find/ls：notices 尾注不计入条目数（§5:571/:611）", async () => {
	const pi = await loadExtension();
	const theme = new FakeTheme();
	const findText = "a.ts\nb.ts\n\n[200 results limit reached]";
	const { ctx: fctx } = makeToolCtx({ args: { pattern: "*.ts" } });
	const fOut = plainText(pi.tools.get("find")!.renderResult(textResult(findText), { expanded: false, isPartial: false }, theme, fctx));
	assert.match(fOut, /2 files/, `find 尾注不应算成文件，实际:\n${fOut}`);

	const lsText = "src/\nREADME.md\n\n[100 entries limit reached. Use limit=200 for more]";
	const { ctx: lctx } = makeToolCtx({ args: { path: "." } });
	const lOut = plainText(pi.tools.get("ls")!.renderResult(textResult(lsText), { expanded: false, isPartial: false }, theme, lctx));
	assert.match(lOut, /2 entries/, `ls 尾注不应算成条目，实际:\n${lOut}`);
});

test("bash：成功输出自带 exit code 字样不误判失败（§5:499）", async () => {
	const pi = await loadExtension();
	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();
	const text = "checking...\nexit code: 5\ndone";
	const { ctx } = makeToolCtx({ args: { command: "make check" }, isError: false });
	const out = plainText(bash.renderResult(textResult(text), { expanded: false, isPartial: false }, theme, ctx));
	assert.doesNotMatch(out, /Exit 5|Error/, `isError=false 时不应渲染失败态，实际:\n${out}`);
	assert.match(out, /done/, "应渲染正常输出");
});

test("bash：isError 时从 pi 的状态行取 exit code（§5:499）", async () => {
	const pi = await loadExtension();
	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();
	const text = "boom\nCommand exited with code 2";
	const { ctx } = makeToolCtx({ args: { command: "false" }, isError: true });
	const out = plainText(bash.renderResult(textResult(text), { expanded: false, isPartial: false }, theme, ctx));
	assert.match(out, /Exit 2/, `失败态应显示 Exit 2，实际:\n${out}`);
});

test("预览省略提示单复数（§5:315）", async () => {
	const pi = await loadExtension();
	const grep = pi.tools.get("grep")!;
	const theme = new FakeTheme();
	// 9 行匹配、previewLimit=8 → 恰好剩 1 行。
	const lines = Array.from({ length: 9 }, (_, i) => `f.ts:${i + 1}: m${i}`);
	const { ctx } = makeToolCtx({ args: { pattern: "m" }, expanded: true });
	const out = plainText(grep.renderResult(textResult(lines.join("\n")), { expanded: true, isPartial: false }, theme, ctx));
	assert.match(out, /1 more line\)/, `剩 1 行应为单数，实际:\n${out}`);
	assert.doesNotMatch(out, /1 more lines/, "不应出现 1 more lines");
});

test("进行中占位文案用 …（§5:426）", async () => {
	const pi = await loadExtension();
	const theme = new FakeTheme();
	for (const [tool, verb] of [
		["read", "Reading…"],
		["grep", "Searching…"],
		["find", "Finding…"],
		["ls", "Listing…"],
	] as const) {
		const { ctx } = makeToolCtx({ isPartial: true });
		const out = plainText(pi.tools.get(tool)!.renderResult(textResult(""), { expanded: false, isPartial: true }, theme, ctx));
		assert.match(out, new RegExp(verb.replace("…", "…")), `${tool} 应显示 ${verb}，实际:\n${out}`);
		assert.doesNotMatch(out, /\.\.\./, `${tool} 不应再用 ASCII 三点`);
	}
});

test("write /resume 无快照：降级为 Wrote N lines，不按新建渲染（§5:712）", async () => {
	const pi = await loadExtension();
	const write = pi.tools.get("write")!;
	const theme = new FakeTheme();
	// 不跑 execute（模拟 resume 后渲染历史消息）→ 快照 map 无此 toolCallId。
	const { ctx } = makeToolCtx({
		toolCallId: "resumed-1",
		args: { path: "x.ts", content: "a\nb\nc\n" },
	});
	const out = plainText(write.renderResult(textResult("Successfully wrote 6 bytes to x.ts"), { expanded: false, isPartial: false }, theme, ctx));
	assert.match(out, /Wrote 3 lines to x\.ts/, `应降级为统计行，实际:\n${out}`);
	assert.doesNotMatch(out, /ctrl\+o to expand/, "无快照时不应渲染新建文件预览");
});

test("行头动词：edit → Update；write 覆盖 → Update、新建 → Create（§6 P1）", async () => {
	const pi = await loadExtension();
	const theme = new FakeTheme();

	const edit = pi.tools.get("edit")!;
	const { ctx: ectx } = makeToolCtx({ args: { path: "a.ts", edits: [] } });
	assert.match(plainText(edit.renderCall({ path: "a.ts", edits: [] }, theme, ectx)), /Update\(a\.ts\)/);

	// write pending（execute 未跑）：existsSync 探测 pre-write 状态。
	const dir = mkdtempSync(join(tmpdir(), "cc-r1-write-"));
	try {
		const existing = join(dir, "old.ts");
		writeFileSync(existing, "x");
		const write = pi.tools.get("write")!;
		const { ctx: uctx } = makeToolCtx({ toolCallId: "w-u", cwd: dir, isPartial: true, args: { path: "old.ts", content: "y" } });
		assert.match(plainText(write.renderCall({ path: "old.ts", content: "y" }, theme, uctx)), /Update\(old\.ts\)/, "覆盖已有文件应显示 Update");
		const { ctx: cctx } = makeToolCtx({ toolCallId: "w-c", cwd: dir, isPartial: true, args: { path: "new.ts", content: "y" } });
		assert.match(plainText(write.renderCall({ path: "new.ts", content: "y" }, theme, cctx)), /Create\(new\.ts\)/, "写新文件应显示 Create");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("edit 优先用 details.patch 的真实行号（§5:817）", async () => {
	const pi = await loadExtension();
	const edit = pi.tools.get("edit")!;
	const theme = new FakeTheme();
	const patch = [
		"--- a/a.ts",
		"+++ b/a.ts",
		"@@ -40,3 +40,3 @@",
		" ctx before",
		"-old line",
		"+new line",
		" ctx after",
		"",
	].join("\n");
	const { ctx } = makeToolCtx({
		args: { path: "a.ts", edits: [{ oldText: "old line", newText: "new line" }] },
		lastComponent: undefined,
	});
	const comp = edit.renderResult(
		textResult("Successfully replaced 1 block(s) in a.ts.", { patch, firstChangedLine: 41 }),
		{ expanded: false, isPartial: false },
		theme,
		ctx,
	) as { render: (w: number) => string[] };
	const rows = comp.render(100).join("\n");
	// 真实行号 41 出现在 gutter；假行号 1 不应作为删除行行号出现。
	assert.match(rows, /41/, `diff 应带真实行号 41，实际:\n${rows}`);
	assert.match(rows, /ctx before/, "应包含真实上下文行");
});

test("bash 展开态 = 全文，不是另一个 8 行窗口（§5:531）", async () => {
	const pi = await loadExtension();
	const bash = pi.tools.get("bash")!;
	const theme = new FakeTheme();
	const lines = Array.from({ length: 20 }, (_, i) => `out-${i + 1}`);
	const { ctx } = makeToolCtx({ args: { command: "seq 20" }, expanded: true });
	const out = plainText(bash.renderResult(textResult(lines.join("\n")), { expanded: true, isPartial: false }, theme, ctx));
	for (const l of lines) {
		assert.match(out, new RegExp(l), `展开态应包含全部输出行 ${l}，实际:\n${out}`);
	}
	assert.doesNotMatch(out, /more line|earlier line/, "展开态不应再有截断提示");
});
