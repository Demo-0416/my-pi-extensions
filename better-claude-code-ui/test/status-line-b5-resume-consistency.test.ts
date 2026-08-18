/**
 * AUDIT §5 status-line.ts:41 (P3 ×1):
 *
 * status line 的 cost 从历史累加（session_start 时遍历 getBranch），时长和 turn
 * 数却从 resume 那一刻从零开始 —— 同一行的 cost 反映整段历史、时长/turn 反映本次
 * 续跑，两半互相矛盾。CC 的 setCostStateForRestore 把三者一起 seed（startTime =
 * Date.now() - lastDuration）。修复：turns 从历史 user 消息 seed，时长基线锚到
 * 最早 entry 的 timestamp。
 *
 * 本测试构造带历史（2 条 user + 1 条 assistant + 早于现在的 timestamp）的
 * sessionManager，resume 后取 footer 渲染，断言 turns 已计入历史、时长 > 0。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme } from "./harness.js";
import { registerStatusLine } from "../extension/status-line.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

function isoDaysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

test("resume 后 turns 从历史 seed、时长基线锚历史（cost/时长/turn 三者一致）", async () => {
	const pi = new FakePi();
	// 造历史：一天前的两问一答（2 条 user + 1 条 assistant，带 cost）。
	const entries = [
		{ type: "message", id: "e1", parentId: null, timestamp: isoDaysAgo(1), message: { role: "user", content: "hi" } },
		{ type: "message", id: "e2", parentId: "e1", timestamp: isoDaysAgo(1), message: { role: "assistant", content: [], usage: { cost: { total: 0.42 } } } },
		{ type: "message", id: "e3", parentId: "e2", timestamp: isoDaysAgo(1), message: { role: "user", content: "again" } },
	];
	pi.sessionManager = {
		...pi.sessionManager,
		getBranch: () => entries as any,
		entries: entries as any,
		getEntries: () => entries as any,
	} as any;

	registerStatusLine(pi);
	await pi.emit("session_start", { reason: "resume" });

	const factory = pi.ui.footerFactory as any;
	assert.ok(factory, "setFooter 应已被调用");

	// footerData 替身：status-line 用 onBranchChange / getGitBranch。
	const footerData = {
		onBranchChange: () => () => {},
		getGitBranch: () => undefined,
	};
	const tui = { requestRender: () => {} };
	const theme = new FakeTheme("claude-code-dark");
	const footer = factory(tui, theme, footerData);
	const line = stripTerminalSequences(footer.render(200)[0]);

	// cost 从历史累加：$0.42。
	assert.match(line, /\$0\.42/, `cost 应含历史 $0.42，实际: ${line}`);
	// turns 从历史 2 条 user seed（不是 0；> 0 才会渲染出 turns 段）。
	assert.match(line, /2 turns/, `turns 应从历史 seed 为 2，实际: ${line}`);
	// 时长基线锚到一天前 → 24h，不该是从 resume 那刻起的近 0 值。
	assert.match(line, /24h /, `时长应体现历史（含小时），实际: ${line}`);
});

test("全新会话（无历史）turns 段不出现、时长从 ~0 起", async () => {
	const pi = new FakePi();
	pi.sessionManager = {
		...pi.sessionManager,
		getBranch: () => [] as any,
	} as any;
	registerStatusLine(pi);
	await pi.emit("session_start", { reason: "startup" });
	const factory = pi.ui.footerFactory as any;
	const footerData = { onBranchChange: () => () => {}, getGitBranch: () => undefined };
	const footer = factory({ requestRender: () => {} }, new FakeTheme("claude-code-dark"), footerData);
	const line = stripTerminalSequences(footer.render(200)[0]);
	assert.doesNotMatch(line, /turns?\b/, `无历史时不应出现 turn 段，实际: ${line}`);
});
