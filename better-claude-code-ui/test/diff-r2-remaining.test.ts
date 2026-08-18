/**
 * AUDIT §5 diff.ts R2 批次回归：
 *  - :349 折叠提示剩 1 行时用单数 "1 more diff line"
 *  - :523 CRLF 文件的 \r 不进入渲染行（解析入口统一剥掉）
 *  - :733 unified 同一 hunk 内按 patch 块序输出（del 块在前、add 块在后），
 *         未配对余量不再落在 additions 之后造成行号回跳
 *  - :904 split 短侧补齐行沿用该侧 add/del 底色，色块不断裂
 *  - :843 split 的 per-side sep 分支与 fit() 是不可达死代码（已删）；
 *         hunk 分隔渲染为整行 dim "..."（与 unified 一致）
 *  - :942 DiffCardComponent 换主题后（invalidate 不重建闭包）用活跃 palette 重建
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	collapsedDiffHint,
	parseDiff,
	renderSplit,
	renderUnified,
	setDiffPalette,
	DiffCardComponent,
	type ParsedDiff,
} from "../extension/tools/diff.js";
import { resolvePalette } from "../extension/palette.js";

const P = resolvePalette("claude-code-dark", () => undefined);

test(":349 折叠提示单复数", () => {
	assert.match(collapsedDiffHint(1, 0, 120), /1 more diff line\b/);
	assert.doesNotMatch(collapsedDiffHint(1, 0, 120), /1 more diff lines/);
	assert.match(collapsedDiffHint(2, 0, 120), /2 more diff lines/);
	assert.match(collapsedDiffHint(1, 1, 120), /1 more hunk\b/);
	assert.match(collapsedDiffHint(2, 3, 120), /3 more hunks/);
});

test(":523 CRLF 内容不把 \\r 带进渲染行", () => {
	const oldContent = "alpha\r\nbeta\r\ngamma\r\n";
	const newContent = "alpha\r\nBETA\r\ngamma\r\n";
	const diff = parseDiff(oldContent, newContent);
	for (const line of diff.lines) {
		assert.ok(!line.content.includes("\r"), `解析行不应含 \\r: ${JSON.stringify(line.content)}`);
	}
	const rows = renderUnified(P, diff, 80);
	for (const r of rows) {
		assert.ok(!r.includes("\r"), `渲染行不应含 \\r: ${JSON.stringify(stripTerminalSequences(r))}`);
	}
});

test(":733 unified 同 hunk 按块序输出：del 全部在 add 之前，行号不回跳", () => {
	// 3 删 1 增：旧逻辑交错输出 del1,add1,del2,del3 → add 后还有 del。
	const diff: ParsedDiff = {
		added: 1,
		removed: 3,
		chars: 100,
		lines: [
			{ type: "del", oldNum: 10, newNum: null, content: "old ten" },
			{ type: "del", oldNum: 11, newNum: null, content: "old eleven" },
			{ type: "del", oldNum: 12, newNum: null, content: "old twelve" },
			{ type: "add", oldNum: null, newNum: 10, content: "new ten" },
		],
	};
	const rows = renderUnified(P, diff, 80).map((r) => stripTerminalSequences(r));
	const firstAdd = rows.findIndex((r) => /\+\s*│/.test(r) || /\d+\+/.test(r));
	const lastDel = rows.reduce((acc, r, i) => (/\d+-/.test(r) ? i : acc), -1);
	assert.ok(firstAdd > 0 && lastDel > 0, `应同时有 add 与 del 行:\n${rows.join("\n")}`);
	assert.ok(lastDel < firstAdd, `所有 del 行应在第一条 add 行之前 (lastDel=${lastDel}, firstAdd=${firstAdd}):\n${rows.join("\n")}`);
});

test(":904 split 短侧补齐行沿用该侧底色（不再是 BG_DEFAULT 断裂）", () => {
	// 左长右短：del 行长到会折行（宽 160 → split 生效，codeWidth 内折 2 行），
	// add 行短。第二个 body row 里右侧是补齐行，应带 BG_ADD 而非默认背景。
	const longDel = "x".repeat(200);
	const lines: ParsedDiff["lines"] = [];
	// 填充足量 ctx 行避免 shouldUseSplit 因 wrap 比例拒绝 split。
	for (let i = 1; i <= 40; i++) lines.push({ type: "ctx", oldNum: i, newNum: i, content: `context line ${i}` });
	lines.push({ type: "del", oldNum: 41, newNum: null, content: longDel });
	lines.push({ type: "add", oldNum: null, newNum: 41, content: "short" });
	const diff: ParsedDiff = { added: 1, removed: 1, chars: 500, lines };
	const rows = renderSplit(P, diff, 160);
	// 补齐行特征：最后一个 │（右侧 gutter 之后）的 body 区 strip 后是纯空格。
	// del 折成 2 行、add 只有 1 行 → 第二个 body row 的右半是补齐行。
	const fillerRows = rows.filter((r) => {
		const plain = stripTerminalSequences(r);
		const lastBar = plain.lastIndexOf("│");
		if (lastBar < 0) return false;
		const rightBody = plain.slice(lastBar + 1);
		return rightBody.length >= 10 && rightBody.trim() === "";
	});
	assert.ok(fillerRows.length >= 1, `应存在右半为纯空格的补齐行:\n${rows.map((r) => stripTerminalSequences(r)).join("\n")}`);
	for (const r of fillerRows) {
		const rightRaw = r.slice(r.lastIndexOf("│") + 1);
		assert.match(rightRaw, /\x1b\[48;2;/, `补齐行右半应带 add/del 底色(48;2),实际: ${JSON.stringify(rightRaw)}`);
	}
});

test(":843 split 的 hunk 分隔渲染为整行 dim ...（sep 成对拦截，不走 halfBuild）", () => {
	// 两个相距很远的修改 → structuredPatch 产出两个 hunk → sep 行。
	const oldLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
	const newLines = [...oldLines];
	newLines[0] = "LINE 1";
	newLines[59] = "LINE 60";
	const diff = parseDiff(oldLines.join("\n"), newLines.join("\n"));
	assert.ok(diff.lines.some((l) => l.type === "sep"), "应有 sep 行");
	const rows = renderSplit(P, diff, 160).map((r) => stripTerminalSequences(r));
	const sepRows = rows.filter((r) => r.trim() === "...");
	assert.ok(sepRows.length >= 1, `sep 应渲染为整行 "..."（与 unified 一致）:\n${rows.join("\n")}`);
});

test(":942 DiffCardComponent 跨主题：palette 变化时缓存作废并把活跃 palette 交给 buildFn", () => {
	const dark = resolvePalette("claude-code-dark", () => undefined);
	const light = resolvePalette("claude-code-light", () => undefined);
	setDiffPalette(dark);
	const seen: unknown[] = [];
	const card = new DiffCardComponent((_w, palette) => {
		seen.push(palette);
		return ["row"];
	});
	card.render(80);
	card.render(80); // 同宽同 palette → 命中缓存，不重建
	assert.equal(seen.length, 1, "同 palette 下第二次渲染应命中缓存");
	assert.equal(seen[0], dark, "buildFn 应收到活跃 palette (dark)");
	setDiffPalette(light);
	card.render(80); // palette 换了 → 缓存作废,用新 palette 重建
	assert.equal(seen.length, 2, "palette 变化后应重建");
	assert.equal(seen[1], light, "buildFn 应收到新的活跃 palette (light)");
	setDiffPalette(dark); // 还原,避免影响其他测试
});
