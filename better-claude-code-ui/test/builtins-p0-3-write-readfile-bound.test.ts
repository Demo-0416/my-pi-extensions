/**
 * AUDIT §2 P0-3 — builtins.ts:691 无上限 readFileSync + writeOldContent 无界。
 *
 * 修法验证两点：
 *  1. write 一个超过 1MiB 的既有文件时，execute 不把整份文件读进 writeOldContent，
 *     renderResult 退化成 "Wrote N lines to <path>"（不画 diff、不吃内存）。
 *  2. writeOldContent / writeExistedBefore 有上限（MAX_WRITE_SNAPSHOTS=64），
 *     连续 write 很多不同 toolCallId 后，快照 map 不会无界增长。
 *
 * 用真实临时文件驱动 execute（pi 的 write 工具会真的落盘），断言渲染文本 + 内存足迹。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, FakePi, FakeTheme, startSession } from "./harness.js";
import { plainText } from "./helpers.js";

test("write 覆盖 >1MiB 既有文件：退化成 Wrote N lines，不整份读入", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cc-p0-3-"));
	const target = join(dir, "big.go");
	// 2 MiB 旧内容，超过 MAX_DIFF_FILE_BYTES=1MiB。
	const bigOld = "package main\n" + "x".repeat(2 * 1024 * 1024) + "\n";
	writeFileSync(target, bigOld, "utf-8");

	const pi = new FakePi();
	pi.cwd = dir;
	await loadExtension(pi);
	await startSession(pi);
	const write = pi.tools.get("write");
	assert.ok(write, "write 工具已注册");

	const newContent = "package main\n\nfunc main() {}\n";
	const toolCallId = "call-big-1";
	const execCtx: any = { cwd: dir };
	await write.execute(toolCallId, { path: target, content: newContent }, undefined, undefined, execCtx);

	const theme = new FakeTheme("claude-code-dark");
	const ctx: any = {
		state: {},
		lastComponent: undefined,
		invalidate: () => {},
		toolCallId,
		cwd: dir,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		isError: false,
		args: { path: target, content: newContent },
	};
	const comp = write.renderResult({ content: [{ type: "text", text: "" }] }, { expanded: false, isPartial: false }, theme, ctx);
	const text = plainText(comp, 100);

	// 退化文案：Wrote N lines，且不含 diff 的加/删行号或 ╌ 边框。
	assert.match(text, /Wrote\s+3\s+lines to/, `预期 "Wrote 3 lines"，实际:\n${text}`);
	assert.ok(!text.includes("╌"), "超大文件不应画 diff 卡片");

	rmSync(dir, { recursive: true, force: true });
});

test("writeOldContent 快照 map 有上限（旧快照被淘汰，不无界增长）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cc-p0-3b-"));
	const pi = new FakePi();
	pi.cwd = dir;
	await loadExtension(pi);
	await startSession(pi);
	const write = pi.tools.get("write");

	// call-0：覆盖一个「已存在的小文件」，其旧内容快照进 writeExistedBefore=true。
	const first = join(dir, "first.txt");
	writeFileSync(first, "old content here\n", "utf-8");
	await write.execute("call-0", { path: first, content: "new content\n" }, undefined, undefined, { cwd: dir });

	// 之后做 200 次不同 toolCallId 的 write，把 call-0 挤出上限
	// （MAX_WRITE_SNAPSHOTS=64，FIFO 淘汰最旧）。
	for (let i = 1; i <= 200; i += 1) {
		const target = join(dir, `f${i}.txt`);
		await write.execute(`call-${i}`, { path: target, content: `line ${i}\n` }, undefined, undefined, { cwd: dir });
	}

	// 渲染 call-0：修复后它的 existedBefore/oldContent 已被淘汰 → 当新文件渲染
	// （"Wrote N lines to"）。修复前 map 无界，call-0 仍在 → 渲染成 diff（含 ╌）。
	const theme = new FakeTheme("claude-code-dark");
	const ctx: any = {
		state: {}, lastComponent: undefined, invalidate: () => {}, toolCallId: "call-0",
		cwd: dir, executionStarted: true, argsComplete: true, isPartial: false, expanded: false,
		isError: false, args: { path: first, content: "new content\n" },
	};
	const comp = write.renderResult({ content: [{ type: "text", text: "" }] }, { expanded: false, isPartial: false }, theme, ctx);
	const text = plainText(comp, 100);
	assert.ok(!text.includes("╌"), `call-0 的快照应已被淘汰、按新文件渲染，而不是 diff 卡片:\n${text}`);
	assert.match(text, /Wrote\s+1\s+line to/);

	rmSync(dir, { recursive: true, force: true });
});
