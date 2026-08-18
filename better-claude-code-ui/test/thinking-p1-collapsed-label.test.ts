/**
 * AUDIT §6 P1（思考块默认折叠观感）+ §3-1. CC 在 transcript 里把 thinking 默认
 * 折叠成一行 `∴ Thinking (ctrl+o to expand)`（AssistantThinkingMessage.tsx:44）。
 *
 * pi 侧的事实（已核实，决定了本条能做到哪一步）：
 *  - 折叠/展开由 pi 自己的 hideThinkingBlock 设置驱动，在 InteractiveMode 构造时
 *    读取（interactive-mode.js:389），早于任何扩展 session_start；扩展 API 没有
 *    setter，改不了这个默认。用户通过 ctrl+t 或 settings.json（hideThinkingBlock:
 *    true，出厂配置已置）来决定默认折叠。
 *  - 扩展能拥有的是折叠行的文案：pi 通过 GLOBAL 隐藏标签把它渲染出来
 *    （assistant-message.js:107-109）。
 *  - pi 的 thinking 展开键是 ctrl+t（app.thinking.toggle, keybindings.js:28），
 *    不是 CC 的 ctrl+o（在 pi 里 ctrl+o 是工具输出）。
 *
 * 修复：把折叠标签常量对齐 CC 折叠行 `∴ Thinking (…to expand)`，并用 pi 真实的
 * 展开键 ctrl+t，而不是 CC 的字面 ctrl+o。
 *
 * 本测试直接驱动 registerThinking(pi)，观察 FakeUI 捕获的 hiddenThinkingLabel。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi } from "./harness.js";
import { registerThinking } from "../extension/thinking.js";

function thinkingPi(): FakePi {
	const pi = new FakePi();
	registerThinking(pi);
	return pi;
}

test("折叠标签对齐 CC 折叠行 `∴ Thinking (ctrl+t to expand)`", async () => {
	const pi = thinkingPi();
	await pi.emit("session_start", { reason: "startup" });
	const label = pi.ui.hiddenThinkingLabel ?? "";
	assert.match(label, /^∴ Thinking/, `折叠标签应以 CC 的 "∴ Thinking" 开头，实际: ${label}`);
	assert.match(label, /\(ctrl\+t to expand\)/, `折叠标签应带 pi 真实展开键提示 (ctrl+t to expand)，实际: ${label}`);
});

test("折叠标签用 pi 的 ctrl+t，不误用 CC 字面 ctrl+o", async () => {
	const pi = thinkingPi();
	await pi.emit("session_start", { reason: "startup" });
	const label = pi.ui.hiddenThinkingLabel ?? "";
	assert.doesNotMatch(label, /ctrl\+o/, `不应写 ctrl+o（那是 pi 的工具输出键），实际: ${label}`);
});

test("turn_start 也把折叠标签维持成同一个 CC 折叠行", async () => {
	const pi = thinkingPi();
	await pi.emit("session_start", { reason: "startup" });
	const atStart = pi.ui.hiddenThinkingLabel;
	await pi.emit("turn_start");
	assert.equal(pi.ui.hiddenThinkingLabel, atStart, `turn_start 不应改变折叠标签，实际: ${pi.ui.hiddenThinkingLabel}`);
	assert.match(pi.ui.hiddenThinkingLabel ?? "", /\(ctrl\+t to expand\)/, "turn_start 后仍是 CC 折叠行");
});
