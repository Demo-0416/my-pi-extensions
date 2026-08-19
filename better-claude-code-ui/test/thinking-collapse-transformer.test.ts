/**
 * CC 折叠 thinking 无痕——最终形态(配合宿主一行 patch):
 *
 *  - 折叠 = pi 原生 hideThinkingBlock=true + 空全局 label。宿主 patch
 *    (`if (!label) continue;`,assistant-message.js hide 分支)让空 label
 *    整块跳过(连尾随 Spacer 都不渲染)→ 正文前 1 空行 = CC。
 *  - 展开 = pi 原生 ctrl+t(hide=false)→ transformer 给 thinking 正文加
 *    `∴ Thinking…` 标题。
 *  - 扩展不再注册任何 thinking 快捷键(ctrl+t 是宿主保留键、ctrl+shift+t
 *    与 rpiv-todo 冲突——原生键本身已是正确入口)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { FakePi } from "./harness.js";
import { registerThinking } from "../extension/thinking.js";

function setup(): { pi: FakePi; transform: (md: string, ctx: { messageType: string }) => string } {
	const pi = new FakePi();
	registerThinking(pi);
	const transform = pi.markdownTransformers[0] as (md: string, ctx: { messageType: string }) => string;
	return { pi, transform };
}

test("thinking 正文经 transformer 加 ∴ 标题(展开态渲染形状)", () => {
	const { transform } = setup();
	const out = stripTerminalSequences(transform("deep thoughts", { messageType: "assistant-thinking" }));
	assert.equal(out, "∴ Thinking…\n\ndeep thoughts");
});

test("非 thinking 消息不受影响;空白 thinking 原样返回(不加孤立标题)", () => {
	const { transform } = setup();
	assert.equal(transform("# hi", { messageType: "assistant" }), "# hi");
	assert.equal(transform("   ", { messageType: "assistant-thinking" }), "   ");
});

test("不注册任何 thinking 快捷键(ctrl+t 宿主保留、ctrl+shift+t 与 rpiv-todo 冲突)", () => {
	const { pi } = setup();
	for (const key of ["ctrl+t", "ctrl+shift+t", "alt+t"]) {
		assert.ok(!pi.shortcuts.get(key), `不应注册 ${key}`);
	}
});
