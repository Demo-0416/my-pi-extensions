/**
 * AUDIT §5 批次 R3（grouping.ts / commands.ts）：
 *
 *  1. §5:372 / commands.ts:88 — /cc-tools group off 切换后不重绘：已渲染的隐藏
 *     成员行永久留空、leader 摘要行滞留。修复：repaintGroupedRows() 推动当前
 *     turn 的全部工具 + 归档 turn 的全部成员重新渲染。
 *  2. §5:701 — 同一次 grep 在独立行叫 "Search"（CC userFacingName）、在展开
 *     glance 行叫 "Grep"。统一为 Search。
 *  3. §5:577 — 展开分组后 pending 成员的状态点没有前景色，比其他 pending 点亮
 *     一档。统一走 theme.fg("dim", ⏺)。
 *  4. §5 commands.ts:180 — ctrl+shift+o 在非 Kitty 协议终端收不到；曾注册 alt+o
 *     作为降级键。2026-09-22 对齐 claude-code-main 时移除两个快捷键：CC 的
 *     verbose 只在 /config 面板切换、无键盘绑定（ctrl+shift+o 在 CC 是
 *     app:toggleTeammatePreview）；持久化开关 + 单修饰键和弦 + 无状态指示
 *     导致误触后默默刷几千行。extra detail 现在只能 /cc-tools detail 切换，
 *     开启时状态栏显示 detail 段（见 status-line-detail-indicator.test.ts）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";
import { registerGroupInvalidator, repaintGroupedRows } from "../extension/tools/grouping.js";

const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

async function beginTurn(pi: FakePi, turnIndex = 0): Promise<void> {
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex, timestamp: Date.now() });
}

test("repaintGroupedRows 推动当前 turn 与归档 turn 的成员重绘（group off 立即生效）", async () => {
	const pi = await loadExtension();
	await pi.emit("session_start", { reason: "startup" });
	await beginTurn(pi, 0);

	// 建一个 2 成员组并注册每个成员的 invalidator（真实路径是 renderCall 时注册）。
	const calls: string[] = [];
	for (const id of ["a1", "a2"]) {
		await pi.emit("tool_execution_start", { toolCallId: id, toolName: "read", args: { path: `${id}.txt` } });
		registerGroupInvalidator(id, () => calls.push(id));
		await pi.emit("tool_execution_end", {
			toolCallId: id,
			toolName: "read",
			result: { content: [{ type: "text", text: "x" }] },
			isError: false,
		});
	}

	// 归档：下一个 turn 开始时，本 turn 的组进入 archivedGroups（§5:399 路径）。
	await pi.emit("turn_start", { turnIndex: 1, timestamp: Date.now() });

	calls.length = 0;
	repaintGroupedRows();
	// 归档组的每个成员（含隐藏的非 leader）都必须被推到重绘，否则 group off 后
	// 历史成员行永远是空的。
	assert.ok(calls.includes("a1"), `归档组 leader a1 应被重绘，实际推了: ${JSON.stringify(calls)}`);
	assert.ok(calls.includes("a2"), `归档组隐藏成员 a2 应被重绘，实际推了: ${JSON.stringify(calls)}`);
});

test("/cc-tools group 切换会触发 repaint（经命令 handler 全链路）", async () => {
	const pi = await loadExtension();
	await pi.emit("session_start", { reason: "startup" });
	await beginTurn(pi);

	const calls: string[] = [];
	await pi.emit("tool_execution_start", { toolCallId: "g1", toolName: "read", args: { path: "g1.txt" } });
	registerGroupInvalidator("g1", () => calls.push("g1"));
	await pi.emit("tool_execution_end", {
		toolCallId: "g1",
		toolName: "read",
		result: { content: [{ type: "text", text: "x" }] },
		isError: false,
	});

	const cmd = pi.commands.get("cc-tools");
	assert.ok(cmd, "cc-tools 命令已注册");
	// writeSettingsKey 写 homedir()/.pi/settings.json；POSIX 的 os.homedir()
	// 优先 $HOME——重定向到临时目录，别污染真实用户设置。
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const fakeHome = mkdtempSync(join(tmpdir(), "cc-r3-home-"));
	const origHome = process.env.HOME;
	process.env.HOME = fakeHome;
	try {
		calls.length = 0;
		// off → on 各一次；每次切换都应推动重绘。
		await cmd.handler("group off", { hasUI: false });
		assert.ok(calls.includes("g1"), `group off 后 g1 应被重绘，实际: ${JSON.stringify(calls)}`);
		calls.length = 0;
		await cmd.handler("group on", { hasUI: false });
		assert.ok(calls.includes("g1"), `group on 后 g1 应被重绘，实际: ${JSON.stringify(calls)}`);
	} finally {
		process.env.HOME = origHome;
	}
});

test("展开 glance 行：grep 叫 Search（与独立行一致），pending 点走 dim", async () => {
	const pi = await loadExtension();
	await pi.emit("session_start", { reason: "startup" });
	await beginTurn(pi);

	// 组：read（已结束）+ grep（pending，保持组 active 且点在闪烁相位）。
	await pi.emit("tool_execution_start", { toolCallId: "r1", toolName: "read", args: { path: "r1.txt" } });
	await pi.emit("tool_execution_end", {
		toolCallId: "r1",
		toolName: "read",
		result: { content: [{ type: "text", text: "x" }] },
		isError: false,
	});
	await pi.emit("tool_execution_start", { toolCallId: "s1", toolName: "grep", args: { pattern: "foo", path: "src" } });

	const read = pi.tools.get("read")!;
	const theme = new FakeTheme();
	const { ctx } = makeToolCtx({ args: { path: "r1.txt" }, toolCallId: "r1", expanded: true });
	const text = plainText(read.renderCall({ path: "r1.txt" }, theme, ctx));

	assert.match(text, /Search\("foo"/, `glance 行 grep 应叫 Search，实际:\n${text}`);
	assert.doesNotMatch(text, /Grep\(/, `glance 行不应再出现 Grep，实际:\n${text}`);

	// §5:577 — pending 成员的状态点必须带 dim 前景（blink 亮相位下），与其他
	// pending 点同一亮度档。FakeTheme 记录每次 fg 调用。
	const dimmedDot = theme.fgCalls.some((c) => c.token === "dim" && c.text === BLACK_CIRCLE);
	assert.ok(dimmedDot, `pending 状态点应经 theme.fg("dim", ${BLACK_CIRCLE})，实际 fg 调用: ${JSON.stringify(theme.fgCalls.slice(0, 20))}`);
});

test("extra-detail 无键盘快捷键（对齐 CC verbose 只能在 /config 切换），只能 /cc-tools 切换", async () => {
	const pi = await loadExtension();
	// 对齐 claude-code-main：verbose 没有键盘绑定（ctrl+shift+o 在 CC 是
	// app:toggleTeammatePreview）。误触持久化的 extra-detail 会刷几千行，
	// 两个快捷键都必须不存在。
	assert.ok(!pi.shortcuts.has("ctrl+shift+o"), "ctrl+shift+o 不应再注册");
	assert.ok(!pi.shortcuts.has("alt+o"), "alt+o 不应再注册");

	// setDetail 持久化到 homedir()/.pi/settings.json——重定向 HOME 免污染。
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const fakeHome = mkdtempSync(join(tmpdir(), "cc-r3-home-"));
	const origHome = process.env.HOME;
	process.env.HOME = fakeHome;
	try {
		const commands = await import("../extension/commands.js");
		const before = commands.isExtraDetail();
		const handler = pi.commands.get("cc-tools")!.handler;
		await handler("detail", { hasUI: false } as any);
		assert.equal(commands.isExtraDetail(), !before, "/cc-tools detail 应翻转 extra-detail 开关");
		await handler("detail", { hasUI: false } as any);
		assert.equal(commands.isExtraDetail(), before, "再切一次应翻转回来");
	} finally {
		process.env.HOME = origHome;
	}
});
