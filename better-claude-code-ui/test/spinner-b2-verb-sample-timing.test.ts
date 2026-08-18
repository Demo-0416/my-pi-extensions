/**
 * AUDIT §5 spinner.ts:87 — spinner 动词的采样时机。
 *
 * 缺陷：旧代码在 turn_start 重新采样动词，而 turn_start 在 agent_start 之后才触发
 * （AUDIT §3-2：一次请求 = agent_start + N×turn_start），所以 agent_start 展示出来
 * 的永远是上一轮的动词，且动词会在一次请求中途乱跳。
 *
 * 修法：改在 agent_start 采样并立即展示（对齐 CC Spinner.tsx:204 的 mount-time
 * useState 初始化），turn_start 不再重掷。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, loadExtension } from "./harness.js";
import { currentWorkingVerb } from "../extension/spinner.js";

test("agent_start 立即把当前采样的动词画进 working message", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("agent_start");
	// agent_start 之后画出来的行里含当前采样动词——不是"上一轮"的。
	// （FakeTheme.fg 是恒等函数，所以 verb 原样出现在渲染行里。）
	assert.ok(
		typeof pi.ui.workingMessage === "string" && pi.ui.workingMessage.includes(`${currentWorkingVerb()}…`),
		`working message 应含当前动词，实际=${pi.ui.workingMessage}`,
	);
});

test("turn_start 不重新采样：一次请求内动词稳定不跳", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("agent_start");
	const verbAtStart = currentWorkingVerb();
	// 一次请求里的多个 turn 迭代不应改变动词。
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await pi.emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
	assert.equal(currentWorkingVerb(), verbAtStart, "turn_start 不应重掷动词");
});
