import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiffCardComponent } from "../extension/tools/diff.js";
import { FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plain, renderLines, width } from "./helpers.js";

const oldText = "old one\nold two\nold three\nold four\n";
const newText = "new one\nnew two\nnew three\nnew four\nnew five\n";
const summary = "  ⎿  Added 5 lines, removed 4 lines";

function checkCard(card: DiffCardComponent): void {
	assert.equal(plain(card, 80)[0], summary);
	const narrow = plain(card, 28);
	assert.equal(narrow[0], "  ⎿  Added 5 lines, removed");
	assert.equal(narrow[1], "     4 lines");
	// Reuse the card across resizes, including widths below the old 20-column
	// minimum and below the diff gutter; cached rows must fit the actual width.
	for (const terminalWidth of [28, 35, 20, 10, 1, 0, 19, 80, 28]) {
		for (const line of renderLines(card, terminalWidth)) {
			assert.ok(width(line) <= terminalWidth,
				`width ${width(line)} > ${terminalWidth}: ${JSON.stringify(line)}`);
		}
	}
	assert.equal(plain(card, 80)[0], summary);
	card.invalidate();
	assert.deepEqual(plain(card, 28), narrow);
}

test("edit diff summary wraps at the crash width of 28 columns", async () => {
	const pi = await loadExtension();
	const edit = pi.tools.get("edit")!;
	const theme = new FakeTheme();
	for (const expanded of [false, true]) {
		const { ctx } = makeToolCtx({
			args: { path: "AGENTS.md", edits: [{ oldText, newText }] },
			expanded,
		});
		const card = edit.renderResult(
			{ content: [{ type: "text", text: "" }] },
			{ expanded, isPartial: false }, theme, ctx,
		);
		checkCard(card);
	}
});

test("write overwrite uses the same width-safe diff summary", async () => {
	const pi = await loadExtension();
	const write = pi.tools.get("write")!;
	const theme = new FakeTheme();
	const dir = mkdtempSync(join(tmpdir(), "cc-diff-narrow-"));
	try {
		const path = join(dir, "fixture.txt");
		writeFileSync(path, oldText);
		const args = { path, content: newText };
		const toolCallId = "write-narrow-overwrite";
		const result = await write.execute(toolCallId, args, undefined, undefined, { cwd: dir });
		for (const expanded of [false, true]) {
			const { ctx } = makeToolCtx({ args, cwd: dir, toolCallId, expanded });
			checkCard(write.renderResult(result, { expanded, isPartial: false }, theme, ctx));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("diff card bounds ANSI and CJK rows at the actual viewport width", () => {
	const row = "\x1b[31m中文内容".repeat(10) + "\x1b[0m";
	const card = new DiffCardComponent(() => [row]);
	for (const terminalWidth of [28, 10, 19, 0, 1, 80, 28]) {
		const rendered = card.render(terminalWidth);
		assert.ok(width(rendered[0]!) <= terminalWidth);
		assert.deepEqual(card.render(terminalWidth), rendered);
	}
});
