/**
 * status line cache 段（本地 fork 新增）：
 *
 * 显示 session 累计的 prompt-cache 命中率 cacheRead / (input + cacheRead + cacheWrite)，
 * 与 pi /session 的 "Cached" 行同口径。pi 内置 footer 的 CH 段（latest 口径）被
 * setFooter 整体替换后不再可见，故在此补上。
 *
 * 规则：
 * - 只在 provider 报告过缓存活动（累计 cacheRead + cacheWrite > 0，即 promptTokens > 0）
 *   时渲染，避免无缓存支持的 provider 显示 cache 0.0%。
 * - message_end（assistant）实时累加；session_start 时从历史 getBranch() seed（resume 场景）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme } from "./harness.js";
import { registerStatusLine } from "../extension/status-line.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

function renderLine(pi: FakePi): string {
	const factory = pi.ui.footerFactory as any;
	const footerData = { onBranchChange: () => () => {}, getGitBranch: () => undefined };
	const footer = factory({ requestRender: () => {} }, new FakeTheme("claude-code-dark"), footerData);
	return stripTerminalSequences(footer.render(200)[0]);
}

test("assistant message_end 累加 usage，footer 显示累计 cache 命中率", async () => {
	const pi = new FakePi();
	pi.sessionManager = { ...pi.sessionManager, getBranch: () => [] as any } as any;
	registerStatusLine(pi);
	await pi.emit("session_start", { reason: "startup" });

	// 第一条：prompt 1000（200 input + 800 cacheRead）；第二条：prompt 1000（全 cacheRead）。
	// 累计 cacheRead=1800 / promptTokens=2000 → 90.0%。
	await pi.emit("message_end", {
		message: { role: "assistant", usage: { input: 200, output: 50, cacheRead: 800, cacheWrite: 0, cost: { total: 0.01 } } },
	});
	await pi.emit("message_end", {
		message: { role: "assistant", usage: { input: 0, output: 40, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.02 } } },
	});

	const line = renderLine(pi);
	assert.match(line, /cache 90\.0%/, `应显示累计 cache 命中率 90.0%，实际: ${line}`);
	// cost 段不受影响。
	assert.match(line, /\$0\.03/, `cost 应正常累加，实际: ${line}`);
});

test("cacheWrite 计入分母（写缓存也算 prompt 体积，但未命中）", async () => {
	const pi = new FakePi();
	pi.sessionManager = { ...pi.sessionManager, getBranch: () => [] as any } as any;
	registerStatusLine(pi);
	await pi.emit("session_start", { reason: "startup" });

	// prompt = 0 input + 0 cacheRead + 1000 cacheWrite → 命中率 0%，但段仍渲染。
	await pi.emit("message_end", {
		message: { role: "assistant", usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 1000, cost: { total: 0.01 } } },
	});

	const line = renderLine(pi);
	assert.match(line, /cache 0\.0%/, `cacheWrite-only 请求应显示 cache 0.0%，实际: ${line}`);
});

test("provider 无缓存活动时不渲染 cache 段", async () => {
	const pi = new FakePi();
	pi.sessionManager = { ...pi.sessionManager, getBranch: () => [] as any } as any;
	registerStatusLine(pi);
	await pi.emit("session_start", { reason: "startup" });

	await pi.emit("message_end", {
		message: { role: "assistant", usage: { input: 500, output: 100, cost: { total: 0.01 } } },
	});
	await pi.emit("message_end", {
		message: { role: "assistant", usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
	});

	const line = renderLine(pi);
	assert.doesNotMatch(line, /cache /, `无缓存活动不应出现 cache 段，实际: ${line}`);
});

test("缺少 usage 的 assistant 消息不抛错、不影响累加", async () => {
	const pi = new FakePi();
	pi.sessionManager = { ...pi.sessionManager, getBranch: () => [] as any } as any;
	registerStatusLine(pi);
	await pi.emit("session_start", { reason: "startup" });

	// 失败路径的 assistant 消息可能不带 usage（status-line.ts 注释同）。
	await pi.emit("message_end", { message: { role: "assistant", content: [] } });
	await pi.emit("message_end", {
		message: { role: "assistant", usage: { input: 100, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 } } },
	});

	const line = renderLine(pi);
	assert.match(line, /cache 50\.0%/, `缺 usage 的消息应被跳过，实际: ${line}`);
});

test("resume 时 cache 统计从历史 seed", async () => {
	const pi = new FakePi();
	const entries = [
		{ type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } },
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [], usage: { input: 300, output: 10, cacheRead: 100, cacheWrite: 0, cost: { total: 0.05 } } },
		},
	];
	pi.sessionManager = {
		...pi.sessionManager,
		getBranch: () => entries as any,
		entries: entries as any,
		getEntries: () => entries as any,
	} as any;

	registerStatusLine(pi);
	await pi.emit("session_start", { reason: "resume" });

	// 历史 prompt = 300 + 100 = 400，cacheRead = 100 → 25.0%。
	const line = renderLine(pi);
	assert.match(line, /cache 25\.0%/, `resume 应从历史 seed cache 统计，实际: ${line}`);
});
