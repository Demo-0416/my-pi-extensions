/**
 * AUDIT §5 ×1 P1 builtins.ts:403 — 覆盖内置工具时透传 promptSnippet/promptGuidelines。
 *
 * 修复前扩展只转发 description/parameters，system prompt 里 read/bash/edit/write/
 * grep/find/ls 的 Available-tools 片段和 Guidelines 全部消失。修复后每个工具都
 * 从 pi 的 create*ToolDefinition 结果透传这两个字段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "./harness.js";

test("7 个内置工具全部透传 promptSnippet（与 pi builtin 一致）", async () => {
	const pi = await loadExtension();
	for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
		const tool = pi.tools.get(name)!;
		assert.equal(typeof tool.promptSnippet, "string", `${name} 应有 promptSnippet`);
		assert.ok(tool.promptSnippet.length > 0, `${name} promptSnippet 非空`);
	}
});

test("read/edit/write/bash 透传 promptGuidelines 数组（grep/find/ls 在 pi 里本就没有）", async () => {
	const pi = await loadExtension();
	// pi 只有 read/edit/write/bash 定义了 promptGuidelines（grep/find/ls 无）。
	for (const name of ["read", "edit", "write", "bash"]) {
		const tool = pi.tools.get(name)!;
		assert.ok(Array.isArray(tool.promptGuidelines), `${name} promptGuidelines 应是数组，实际 ${typeof tool.promptGuidelines}`);
		assert.ok(tool.promptGuidelines.length > 0, `${name} promptGuidelines 非空`);
	}
	// grep/find/ls 应原样透传 undefined（pi 本就未定义）。
	for (const name of ["grep", "find", "ls"]) {
		const tool = pi.tools.get(name)!;
		assert.equal(tool.promptGuidelines, undefined, `${name} promptGuidelines 应为 undefined`);
	}
});
