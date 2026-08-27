/**
 * host-patches.ts — prototype wraps on PUBLIC pi exports (the technique npm's
 * pi-claude-code-ui ships with; pi's loader aliases the package specifier to
 * the host's live module, so in production the same class object is patched).
 *
 * Patch 1: AssistantMessageComponent.render → all-whitespace output becomes []
 *   (kills the ghost-Spacer stacking: 8+ blank rows after a collapsed tool
 *   group with a thinking model).
 * Patch 2: InteractiveMode.showStatus → "Tool output: expanded|collapsed" is
 *   dropped entirely (Ctrl+O left a permanent status row in the transcript);
 *   all other notices pass through.
 *
 * Tests build instances via Object.create(prototype) so no theme/session
 * bootstrapping is needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { installHostPatches } from "../extension/host-patches.js";

// 原始 showStatus 会取 theme.fg("dim") — pass-through 用例需要已初始化的主题。
initTheme("dark");
installHostPatches();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeAssistant(childLines: string[]): any {
	const fake = Object.create(AssistantMessageComponent.prototype);
	fake.children = [{ render: () => [...childLines] }];
	fake.hasToolCalls = false;
	return fake;
}

test("patch1: 全空白渲染(含 ANSI/OSC 包裹)返回 [] — 幽灵 Spacer 消失", () => {
	const fake = fakeAssistant([
		"   ",
		"\x1b[2m   \x1b[22m", // ANSI 包裹的空白
		"\x1b]133;A\x07 ", // OSC133 zone 标记 + 空白
		"",
	]);
	assert.deepEqual(fake.render(80), [], "全空白消息应渲染为零行");
});

test("patch1: 有可见内容的消息原样返回(不误伤)", () => {
	const fake = fakeAssistant(["", "hello world", ""]);
	const lines = fake.render(80) as string[];
	assert.equal(lines.length, 3, "行数不变");
	assert.ok(
		lines.some((l) => l.includes("hello world")),
		"可见内容保留",
	);
});

test("patch1: 开头连续空白折叠为 1(thinking 清空后的双 Spacer),保留首行 OSC 标记", () => {
	// [顶 Spacer, thinking→0 行后的尾随 Spacer, 正文] — CC 只有 1 空行。
	const fake = fakeAssistant(["", "\x1b[2m \x1b[22m", "body text", ""]);
	const lines = fake.render(80) as string[];
	// 原始 render 会给 lines[0] 加 OSC133 zone-start 前缀(hasToolCalls=false)。
	assert.equal(lines.length, 3, `开头 2 空白应折叠为 1,实际 ${JSON.stringify(lines)}`);
	assert.ok(lines[0]!.startsWith("\x1b]133;A\x07"), "首行保留 zone-start 标记");
	assert.equal(lines[1], "body text");
});

test("patch1: 开头仅 1 空白行不折叠(正常布局不受影响)", () => {
	const fake = fakeAssistant(["", "body", ""]);
	assert.equal((fake.render(80) as string[]).length, 3);
});

test("patch1: 空数组输出原样返回(宿主已零行时不干预)", () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const fake: any = Object.create(AssistantMessageComponent.prototype);
	fake.children = [];
	fake.hasToolCalls = false;
	assert.deepEqual(fake.render(80), []);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeMode(): { mode: any; children: unknown[] } {
	const children: unknown[] = [];
	const mode = Object.create(InteractiveMode.prototype);
	mode.chatContainer = {
		children,
		addChild(c: unknown) {
			children.push(c);
		},
	};
	mode.lastStatusText = undefined;
	mode.lastStatusSpacer = undefined;
	mode.ui = { requestRender() {} };
	return { mode, children };
}

test("patch2: 'Tool output: collapsed/expanded' 被完全丢弃(Spacer+Text 都不追加)", () => {
	const { mode, children } = fakeMode();
	mode.showStatus("Tool output: collapsed");
	mode.showStatus("Tool output: expanded");
	assert.equal(children.length, 0, `ctrl+o 的 status 不应进 transcript,实际追加 ${children.length} 个组件`);
});

test("patch2: 其他 status 照常追加(Spacer+Text 一对)", () => {
	const { mode, children } = fakeMode();
	mode.showStatus("Switched to some-model");
	assert.equal(children.length, 2, `普通 status 应追加 Spacer+Text,实际 ${children.length}`);
});

test("patch2: 近似但不精确匹配的文案不被误杀", () => {
	const { mode, children } = fakeMode();
	mode.showStatus("Tool output: collapsed for now"); // 前缀相同但非宿主原文
	assert.equal(children.length, 2, "仅精确匹配宿主原文才丢弃");
});

test("幂等: 重复 installHostPatches 不二次包装", () => {
	const amBefore = (AssistantMessageComponent.prototype as { render: unknown }).render;
	const imBefore = (InteractiveMode.prototype as { showStatus: unknown }).showStatus;
	installHostPatches();
	installHostPatches();
	assert.equal((AssistantMessageComponent.prototype as { render: unknown }).render, amBefore);
	assert.equal((InteractiveMode.prototype as { showStatus: unknown }).showStatus, imBefore);
});
