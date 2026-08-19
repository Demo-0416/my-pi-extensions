/**
 * CC 折叠 thinking 无痕——自管折叠方案(CC v2.1.234 实测:折叠态在 transcript
 * 里没有任何行)。
 *
 * pi 的 hide 分支(hideThinkingBlock=true)必渲染一行 Text,连空 label 也会
 * 留下一条空白行;而展开分支走 Markdown + 我们的 transformer,pi-tui Markdown
 * 对空串渲染 **0 行**。所以折叠交给 transformer:折叠态返回 ""(无痕),
 * 展开态返回 `∴ Thinking…` 标题+正文。ctrl+t 切换(扩展快捷键先于内置
 * keybinding 分发,custom-editor.js:26,故接管 pi 原生 toggle;ctrl+shift+t
 * 曾与 rpiv-todo 冲突而弃用),并借
 * setHiddenThinkingLabel 的宿主路径(对每个历史组件跑 updateContent 重建
 * Markdown,assistant-message.js:46-50)让 transformer 以新状态重跑。
 * 配套:用户 settings hideThinkingBlock=false。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { FakePi } from "./harness.js";
import { isThinkingExpanded, registerThinking } from "../extension/thinking.js";

function setup(): { pi: FakePi; transform: (md: string, ctx: { messageType: string }) => string } {
	const pi = new FakePi();
	registerThinking(pi);
	const transform = pi.markdownTransformers[0] as (md: string, ctx: { messageType: string }) => string;
	return { pi, transform };
}

test("折叠态(默认):assistant-thinking 变换为空串(Markdown 渲染 0 行,无痕)", () => {
	const { transform } = setup();
	assert.equal(isThinkingExpanded(), false, "默认应为折叠态");
	assert.equal(transform("deep thoughts", { messageType: "assistant-thinking" }), "");
});

test("非 thinking 消息不经过折叠", () => {
	const { transform } = setup();
	assert.equal(transform("# hi", { messageType: "assistant" }), "# hi");
});

test("ctrl+t 展开出标题+正文,再按折叠回空;宿主重建通道被触发", async () => {
	const { pi, transform } = setup();
	await pi.emit("session_start", { reason: "startup" });
	const shortcut = pi.shortcuts.get("ctrl+t") as { handler: (ctx: unknown) => Promise<void> };
	assert.ok(shortcut, "应注册 ctrl+t(接管 pi 原生 thinking toggle)");
	assert.ok(!pi.shortcuts.get("ctrl+shift+t"), "不再注册 ctrl+shift+t(与 rpiv-todo 冲突)");

	await shortcut.handler(pi.ctx());
	try {
		assert.equal(isThinkingExpanded(), true, "toggle 后应为展开态");
		const out = stripTerminalSequences(transform("deep thoughts", { messageType: "assistant-thinking" }));
		assert.equal(out, "∴ Thinking…\n\ndeep thoughts", "展开态应是标题+正文");
		// 宿主重建通道:toggle 会调 setHiddenThinkingLabel(空 label 不变,但宿主
		// 侧会对每个组件 updateContent),FakeUI 捕获到的值应仍是 ""。
		assert.equal(pi.ui.hiddenThinkingLabel, "", "label 保持空(全局标签绝不携带内容)");
	} finally {
		await shortcut.handler(pi.ctx()); // 翻回折叠,避免模块态泄漏给其他测试
	}
	assert.equal(isThinkingExpanded(), false, "再次 toggle 应回折叠态");
	assert.equal(transform("deep thoughts", { messageType: "assistant-thinking" }), "");
});

test("展开态不吞空 thinking(纯空白正文原样返回,不加孤立标题)", async () => {
	const { pi, transform } = setup();
	const shortcut = pi.shortcuts.get("ctrl+t") as { handler: (ctx: unknown) => Promise<void> };
	await shortcut.handler({ hasUI: false });
	try {
		assert.equal(transform("   ", { messageType: "assistant-thinking" }), "   ");
	} finally {
		await shortcut.handler({ hasUI: false });
	}
});
