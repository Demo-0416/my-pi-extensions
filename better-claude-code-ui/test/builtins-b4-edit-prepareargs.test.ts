/**
 * AUDIT §5 ×3 P1 builtins.ts:778 — edit 覆盖必须透传 prepareArguments。
 *
 * pi 的 edit 工具用 prepareEditArguments 把 (a) edits 发成 JSON 字符串、
 * (b) 顶层 oldText/newText 旧格式 归一化成 edits[] 数组。扩展覆盖 edit 时
 * 若不透传，这两种形状在 schema 校验前直接失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "./harness.js";

test("edit 透传 prepareArguments（存在且是函数）", async () => {
	const pi = await loadExtension();
	const edit = pi.tools.get("edit")!;
	assert.equal(typeof edit.prepareArguments, "function", "edit.prepareArguments 应是函数");
});

test("prepareArguments 把 edits JSON 字符串解析成数组", async () => {
	const pi = await loadExtension();
	const edit = pi.tools.get("edit")!;
	const out = edit.prepareArguments({ path: "a.ts", edits: JSON.stringify([{ oldText: "x", newText: "y" }]) });
	assert.ok(Array.isArray(out.edits), "edits 应被解析成数组");
	assert.equal(out.edits[0].oldText, "x");
	assert.equal(out.edits[0].newText, "y");
});

test("prepareArguments 把顶层 oldText/newText 提升进 edits[]", async () => {
	const pi = await loadExtension();
	const edit = pi.tools.get("edit")!;
	const out = edit.prepareArguments({ path: "a.ts", oldText: "foo", newText: "bar" });
	assert.ok(Array.isArray(out.edits), "应生成 edits 数组");
	assert.equal(out.edits.at(-1).oldText, "foo");
	assert.equal(out.edits.at(-1).newText, "bar");
});
