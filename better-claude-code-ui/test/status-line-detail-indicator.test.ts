/**
 * 2026-09-22 刷屏事故：extra detail（≈CC verbose）是持久化开关，但状态栏没有任何
 * 指示——alt+o/ctrl+shift+o 误触后，用户面对每屏上千行的输出完全不知道来源。
 *
 * 修复（对齐 claude-code-main 的 verbose 可见性）：
 *  1. extra detail 开启时，CC 状态栏（footer）必须出现 `detail` 指示段。
 *     CC 状态栏本身没有 verbose 段（已核实 StatusLine.tsx），这段是自有元素：
 *     只用 dim 作模式指示，不用 warning——warning 保留给上下文将尽这类告警。
 *  2. 关闭时不出现。
 *  3. 指示是渲染期读取 isExtraDetail()，/cc-tools detail 切换后无需重启即生效。
 *
 * 本测试在 fake HOME（默认无 ccToolsExtraDetail）下加载，先断言关闭态无指示，
 * 再经 /cc-tools 命令打开，断言指示出现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("extra detail 开启时状态栏出现 detail 指示，关闭时不出现", async () => {
	// commands.ts 在模块顶层读 settings——import 前重定向 HOME 到空目录（默认 off）。
	const fakeHome = mkdtempSync(join(tmpdir(), "cc-detail-indicator-home-"));
	const origHome = process.env.HOME;
	process.env.HOME = fakeHome;
	try {
		const { FakeTheme, loadExtension } = await import("./harness.js");
		const { stripTerminalSequences } = await import("@earendil-works/pi-tui");

		// 全量加载（含 registerCommands → /cc-tools 与 registerStatusLine）。
		const pi = await loadExtension();
		await pi.emit("session_start", { reason: "startup" });

		const factory = pi.ui.footerFactory as any;
		assert.ok(factory, "setFooter 应已被调用");
		const footerData = { onBranchChange: () => () => {}, getGitBranch: () => undefined };
		const tui = { requestRender: () => {} };
		const theme = new FakeTheme("claude-code-dark");
		const renderLine = () => stripTerminalSequences(factory(tui, theme, footerData).render(200)[0]);

		// 默认关闭：无 detail 段。
		assert.ok(!/\bdetail\b/.test(renderLine()), `关闭时不应有 detail 指示: ${renderLine()}`);

		// /cc-tools detail on → 指示出现（dim 模式指示， FakeTheme 记录 fg 调用）。
		const handler = pi.commands.get("cc-tools")!.handler;
		await handler("detail on", { hasUI: false } as any);
		const line = renderLine();
		assert.match(line, /\bdetail\b/, `开启后状态栏应显示 detail 指示: ${line}`);
		assert.ok(
			theme.fgCalls.some((c) => c.token === "dim" && c.text === "detail"),
			`detail 指示应使用 dim 模式色（不用 warning——warning 保留给上下文告警），实际 fg 调用: ${JSON.stringify(theme.fgCalls)}`,
		);

		// 再关闭 → 指示消失（渲染期读取，无需重启）。
		await handler("detail off", { hasUI: false } as any);
		assert.ok(!/\bdetail\b/.test(renderLine()), `关闭后 detail 指示应消失: ${renderLine()}`);
	} finally {
		process.env.HOME = origHome;
	}
});
