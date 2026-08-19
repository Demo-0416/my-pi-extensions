/**
 * AUDIT §6 P1(思考块默认折叠观感)+ §3-1,按 CC v2.1.234 用户实测复核:
 * CC 折叠状态的 thinking 在 transcript 里**没有任何独立行**——痕迹只出现在
 * spinner byline(`thought for Ns`)和折叠组行(`Thought for 3s, read 1 file`)。
 *
 * pi 侧的事实(已核实,决定了本条能做到哪一步):
 *  - 折叠/展开由 pi 自己的 hideThinkingBlock 设置驱动;hide 分支会无条件渲染
 *    一行 Text(全局隐藏标签)(assistant-message.js:107-109),扩展改不掉这个
 *    结构,只能拥有标签文案。
 *  - 因此最接近 CC 的可达状态是**空标签**:宿主会包一层 ANSI 色,渲染为一条
 *    空白行(比一行文字接近"无痕")。
 *  - 展开(ctrl+t,hideThinkingBlock=false)时 thinking 正文仍完整可见,由
 *    markdown transformer 加 `∴ Thinking…` 标题。
 *
 * 本测试直接驱动 registerThinking(pi),观察 FakeUI 捕获的 hiddenThinkingLabel。
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

test("折叠标签为空——CC 折叠 thinking 在 transcript 无独立行", async () => {
	const pi = thinkingPi();
	await pi.emit("session_start", { reason: "startup" });
	assert.equal(
		pi.ui.hiddenThinkingLabel,
		"",
		`折叠标签应为空串(覆盖 pi 默认 "Thinking..."),实际: ${JSON.stringify(pi.ui.hiddenThinkingLabel)}`,
	);
});

test("空标签是显式设置,不是漏设(session_start 必须调 setHiddenThinkingLabel)", async () => {
	const pi = thinkingPi();
	assert.equal(pi.ui.hiddenThinkingLabel, undefined, "前提:注册后未 session_start 时无标签");
	await pi.emit("session_start", { reason: "startup" });
	assert.notEqual(
		pi.ui.hiddenThinkingLabel,
		undefined,
		"session_start 后必须已显式写入空标签,否则 pi 会用默认 'Thinking...'",
	);
});

test("turn_start 维持空标签不变", async () => {
	const pi = thinkingPi();
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("turn_start");
	assert.equal(pi.ui.hiddenThinkingLabel, "", `turn_start 后仍应是空标签,实际: ${JSON.stringify(pi.ui.hiddenThinkingLabel)}`);
});
