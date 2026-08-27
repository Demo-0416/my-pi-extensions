/**
 * CC 视觉行预算在带 ANSI 的真实主题下的契约（harness 的 FakeTheme 不输出转义，
 * 覆盖不到 sliceByColumn 的 SGR 重开逻辑）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtension, makeToolCtx } from "./harness.js";
import { renderLines, plain, width } from "./helpers.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

class AnsiTheme {
	name = "ansi";
	fg(token: string, text: string): string { return `\u001b[2m${text}\u001b[22m`; }
	bold(text: string): string { return `\u001b[1m${text}\u001b[22m`; }
	getColorMode() { return "dark" as const; }
}

test("ANSI 主题下：宽度契约、无裸转义泄漏、内容不丢", async () => {
	const pi = await loadExtension();
	const bash = pi.tools.get("bash")!;
	const theme = new AnsiTheme() as any;
	const payload = "A".repeat(400) + "\n" + "B".repeat(400);
	const { ctx } = makeToolCtx({ args: { command: "cat x" }, expanded: false });
	const comp = bash.renderResult({ content: [{ type: "text", text: payload }] }, { expanded: false, isPartial: false }, theme, ctx);
	const raw = renderLines(comp, 60);
	for (const [i, l] of raw.entries()) {
		const vis = width(stripTerminalSequences(l));
		assert.ok(vis <= 60, `行 ${i} 可见宽 ${vis} 超 60`);
	}
	const text = plain(comp, 60).join("");
	assert.ok(text.includes("AAAA"), "内容应保留");
	assert.match(plain(comp, 60).join("\n"), /\u2026 \+\d+ lines/, "应有 CC 提示");
	// 每行 SGR 开闭应配平（sliceByColumn 会重开状态）
	for (const [i, l] of raw.entries()) {
		const opens = (l.match(/\u001b\[2m/g) ?? []).length;
		assert.ok(opens >= 1 || l.trim() === "", `行 ${i} 应保留 dim 样式: ${JSON.stringify(l)}`);
	}
	console.log("sample:", JSON.stringify(raw[1]?.slice(0, 70)));
});
