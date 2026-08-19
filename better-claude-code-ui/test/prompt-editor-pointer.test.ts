/**
 * AUDIT §6 启动 Logo/输入框 P1 — CC 输入框行首的 `❯ ` 提示符。
 *
 * PromptEditor 继承 pi 的 CustomEditor(保留 app 快捷键路由),paddingX 恒
 * ≥2(宿主 setCustomEditorComponent 会用默认 editor 的 paddingX 覆盖,
 * interactive-mode.js:2067),render 后把首条内容行的左 padding 画成 ❯。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { PromptEditor } from "../extension/prompt-editor.js";

function makeEditor(): PromptEditor {
	const tui = { terminal: { rows: 40 } } as never;
	const theme = { borderColor: (s: string) => `\x1b[38;5;244m${s}\x1b[0m` } as never;
	const keybindings = { matches: () => false } as never;
	return new PromptEditor(tui, theme, keybindings);
}

test("首条内容行以 ❯ 开头,上下是 ─ 边框", () => {
	const ed = makeEditor();
	ed.setText("hello");
	const rows = ed.render(80).map((r) => stripTerminalSequences(r));
	assert.match(rows[0] ?? "", /^─+$/, `首行应是顶边框,实际: ${JSON.stringify(rows[0])}`);
	assert.match(rows[1] ?? "", /^❯ hello/, `内容行应为 ❯ + 文本,实际: ${JSON.stringify(rows[1])}`);
	assert.match(rows[rows.length - 1] ?? "", /^─+$/, "末行应是底边框");
	for (const r of rows) {
		assert.ok(visibleWidth(r) <= 80, `行宽 ${visibleWidth(r)} 不应超过 80: ${JSON.stringify(r)}`);
	}
});

test("宿主拷贝 paddingX=0 也不丢提示符列(保底 2)", () => {
	const ed = makeEditor();
	ed.setPaddingX(0); // 宿主 setCustomEditorComponent 的拷贝路径
	ed.setText("world");
	const rows = ed.render(60).map((r) => stripTerminalSequences(r));
	assert.match(rows[1] ?? "", /^❯ world/, `paddingX 被压后仍应有 ❯ 且不吃字,实际: ${JSON.stringify(rows[1])}`);
});

test("空文本时 ❯ 与光标共存,不超宽", () => {
	const ed = makeEditor();
	const rows = ed.render(40);
	const plain = stripTerminalSequences(rows[1] ?? "");
	assert.match(plain, /^❯ /, `空输入也应显示 ❯,实际: ${JSON.stringify(plain)}`);
	for (const r of rows) {
		assert.ok(visibleWidth(stripTerminalSequences(r)) <= 40, `不超宽: ${JSON.stringify(r)}`);
	}
});
