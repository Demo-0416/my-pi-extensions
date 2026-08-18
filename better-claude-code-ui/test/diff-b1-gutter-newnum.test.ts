/**
 * AUDIT §5 ×3 P2 dead-code — diff.ts:281 maxLineNumber 忽略 ctx 行的 newNum。
 *
 * maxLineNumber 用 `oldNum ?? newNum`：对 ctx 行（两侧都有号）恒取 oldNum，
 * 但 renderUnified 的 ctx 行渲染的是 newNum（diff.ts:710）。当净增行把 newNum
 * 推进到比 oldNum 多一位时（增行在前、上下文延伸到文件尾部），gutter 按 oldNum
 * 定宽偏窄，ctx 行的 newNum 撑破一列，`│` 分隔符相对其它行右移一格。
 *
 * 断言方式：渲染后所有含 `│` 的行，其首个 `│` 的可见列位必须一致（gutter 对齐）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderUnified, type ParsedDiff } from "../extension/tools/diff.js";
import { resolvePalette } from "../extension/palette.js";

const P = resolvePalette("claude-code-dark", () => undefined);

/** 每行首个 `│`（strip ANSI 后）的列位；无 `│` 的行返回 -1。 */
function dividerCols(lines: string[]): number[] {
	return lines
		.map((l) => stripTerminalSequences(l))
		.map((l) => l.indexOf("│"))
		.filter((c) => c >= 0);
}

test("net-add 后 ctx 行的 newNum 比 oldNum 宽一位时 gutter 不溢出", () => {
	// 增行在前把 new 侧推到 3 位，尾部上下文 oldNum 仍是 2 位。
	// old maxLineNumber = 90（取 oldNum）→ numberWidth 2；ctx 行渲染 newNum=100 撑破。
	const diff: ParsedDiff = {
		added: 1,
		removed: 0,
		chars: 40,
		lines: [
			{ type: "add", oldNum: null, newNum: 5, content: "added line" },
			{ type: "ctx", oldNum: 88, newNum: 98, content: "context a" },
			{ type: "ctx", oldNum: 89, newNum: 99, content: "context b" },
			{ type: "ctx", oldNum: 90, newNum: 100, content: "context c" },
		],
	};
	const rows = renderUnified(P, diff, 80);
	const cols = dividerCols(rows);
	assert.ok(cols.length >= 3, "应有多行带 │ 分隔符");
	const first = cols[0]!;
	for (const c of cols) {
		assert.equal(c, first, `所有 │ 必须在同一列（gutter 对齐）；实际列位 ${JSON.stringify(cols)}`);
	}
});

test("纯上下文（无净增）时 gutter 依旧对齐（回归保护）", () => {
	const diff: ParsedDiff = {
		added: 1,
		removed: 1,
		chars: 20,
		lines: [
			{ type: "ctx", oldNum: 1, newNum: 1, content: "a" },
			{ type: "del", oldNum: 2, newNum: null, content: "old" },
			{ type: "add", oldNum: null, newNum: 2, content: "new" },
			{ type: "ctx", oldNum: 3, newNum: 3, content: "b" },
		],
	};
	const cols = dividerCols(renderUnified(P, diff, 80));
	const first = cols[0]!;
	for (const c of cols) assert.equal(c, first, `列位 ${JSON.stringify(cols)}`);
});
