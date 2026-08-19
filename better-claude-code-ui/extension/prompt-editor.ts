/**
 * CC prompt pointer — the `❯ ` at the head of the input box (AUDIT §6 启动
 * Logo/输入框 P1 "输入框缺少 CC 的 ❯ 提示符").
 *
 * pi's editor renders `─` borders top/bottom with content lines between them
 * (pi-tui editor.js render). We extend pi's CustomEditor (NOT the bare pi-tui
 * Editor — CustomEditor routes app keybindings and extension shortcuts,
 * custom-editor.js) and paint the pointer into the left padding of the first
 * content row. The pointer takes the editor's borderColor, so pi's own
 * bash-mode border swap (interactive-mode.js:3311-3320 copies borderColor onto
 * the active editor) recolors it in step with the frame.
 */
import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

/** Columns reserved for the pointer: `❯` + one space. */
const PROMPT_COL = 2;

export class PromptEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { paddingX: PROMPT_COL });
	}

	/** The host copies the DEFAULT editor's paddingX onto a custom editor right
	 *  after construction (interactive-mode.js:2067); never drop below the
	 *  pointer column or the glyph would overwrite text. */
	override setPaddingX(padding: number): void {
		super.setPaddingX(Math.max(padding, PROMPT_COL));
	}

	override render(width: number): string[] {
		const rows = super.render(width);
		// rows[0] is the top border; rows[1] is the first content row, which
		// starts with paddingX spaces of left padding. Extremely narrow widths
		// clamp padding below 2 — then skip painting rather than eat a column.
		const first = rows[1];
		if (first !== undefined && first.startsWith("  ")) {
			rows[1] = `${this.borderColor("❯")} ${first.slice(2)}`;
		}
		return rows;
	}
}

export function registerPromptPointer(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new PromptEditor(tui, theme, keybindings));
	});
}
