/**
 * AUDIT §5 ×2 P2 ansi-color — diff.ts:182 wrapAnsi 的 ansiState 漏了 dim(SGR 2)。
 *
 * unified 的 ctx（上下文）行正文包在 `\x1b[2m`(D_DIM) 里渲染。当该行折行时，
 * 续行的样式由 ansiState(row) 回放；修复前 ansiState 只回放 fg/bg/bold/italic，
 * 不回放 dim，导致折行后第二行不再变暗（比第一行亮一档）。
 *
 * 断言：一条足够长、会折成 ≥2 行的 ctx 行，其每一续行都必须带 `\x1b[2m`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderUnified, type ParsedDiff } from "../extension/tools/diff.js";
import { resolvePalette } from "../extension/palette.js";

const P = resolvePalette("claude-code-dark", () => undefined);

test("ctx 行折行后每个续行都保留 dim(SGR 2)", () => {
	// width>=120 → adaptiveWrapRows=2；ctx 行足够长以触发折行。
	const longCtx = "this is a very long context line that will certainly exceed the code column width and wrap onto a second row for sure";
	const diff: ParsedDiff = {
		added: 1,
		removed: 0,
		chars: longCtx.length + 20,
		lines: [
			{ type: "ctx", oldNum: 1, newNum: 1, content: longCtx },
			{ type: "add", oldNum: null, newNum: 2, content: "added" },
		],
	};
	const rows = renderUnified(P, diff, 120);
	// ctx 主行含行号 1 + 前缀文字；续行是 continuation gutter（空格填充 + │）+ ctx 尾部文字。
	const ctxMain = rows.find((r) => r.includes("this is a very long"));
	assert.ok(ctxMain !== undefined, `应渲染 ctx 主行:\n${rows.join("\n")}`);
	assert.ok(ctxMain!.includes("\x1b[2m"), "ctx 主行应带 dim");
	// 续行：含 ctx 尾部文字（折到第二行的部分），但不含主行前缀。
	const ctxCont = rows.find((r) => r.includes("sure") && !r.includes("this is a very long"));
	assert.ok(ctxCont !== undefined, `应有 ctx 续行，实际:\n${rows.join("\n")}`);
	assert.ok(ctxCont!.includes("\x1b[2m"), `ctx 续行必须保留 dim(SGR 2)，实际:\n${JSON.stringify(ctxCont)}`);
});
