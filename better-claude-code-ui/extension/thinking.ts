/**
 * CC thinking rendering — aligned with CC v2.1.234 user-verified renders (the
 * local CC snapshot predates them).
 *
 * CC's collapsed thinking leaves NO line in the transcript at all — its only
 * traces are the spinner byline (`thought for Ns`, spinner.ts) and the
 * collapsed tool-group summary (`Thought for 3s, read 1 file`, grouping.ts).
 *
 * How that maps onto pi (with the local host patch, see below):
 *   - collapsed = pi's own hideThinkingBlock=true (the shipped default) with an
 *     EMPTY global hidden label. Stock pi renders one Text(label) row even for
 *     an empty label (assistant-message.js:107-109 — the host wraps the label
 *     in ANSI color, defeating Text's empty-string check), which left a stray
 *     blank row; the local one-line host patch (`if (!label) continue;`, marked
 *     "cc-ui patch" in /opt/homebrew/.../assistant-message.js, backup at
 *     *.bak-cc-ui) skips the row AND the trailing Spacer, matching CC's
 *     one-blank-line message gap exactly. Without the patch (e.g. after a pi
 *     update overwrites it) the cost is one extra blank row — degraded, not
 *     broken.
 *   - expanded = pi's native ctrl+t (app.thinking.toggle → hide=false): the
 *     thinking body renders through Markdown with our transformer, which adds
 *     the CC `∴ Thinking…` dim-italic title above the body.
 *
 * The label must stay per-block-agnostic (AUDIT §5 thinking.ts:77): it is
 * GLOBAL — one write rewrites every history AssistantMessageComponent
 * (interactive-mode.js:1655-1666). "" is both that and CC's no-line-at-all.
 *
 * Key history: a self-managed collapse (transformer returning "" + own
 * shortcut) was tried first, but every usable key was taken — ctrl+t is
 * host-reserved (runner.js:7-17 rejects extension registrations), ctrl+shift+t
 * lost the extension conflict to rpiv-todo — and it still could not remove the
 * host's trailing Spacer. The host patch made pi's own ctrl+t flow correct, so
 * the extension needs no shortcut at all.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dim, italic } from "./palette.js";

const THINKING_TITLE = "∴ Thinking…";
/** Empty: CC has no collapsed-thinking line (see header). */
const HIDDEN_LABEL_THINKING = "";

export function registerThinking(pi: ExtensionAPI): void {
	// --- 1. Expanded-shape title for every thinking run -------------------
	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType !== "assistant-thinking") return markdown;
		const body = markdown.trim();
		if (!body) return markdown;
		// Title on its own line — never prefix the body's first line (that
		// corrupts markdown syntax when the block starts with `# ` or `- `).
		return `${dim(italic(THINKING_TITLE))}\n\n${body}`;
	});

	// --- 2. Keep the global hidden label empty ----------------------------
	// pi resets the label to its default ("Thinking...") on session invalidate
	// (resetExtensionUI → interactive-mode.js:1743), so re-assert it.
	const assertLabel = (ctx: { hasUI: boolean; ui: { setHiddenThinkingLabel?: (l: string) => void } }): void => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setHiddenThinkingLabel?.(HIDDEN_LABEL_THINKING);
		} catch {
			/* older pi without setHiddenThinkingLabel */
		}
	};
	pi.on("session_start", async (_event, ctx) => assertLabel(ctx));
	pi.on("turn_start", async (_event, ctx) => assertLabel(ctx));

	// Spinner-row thinking display (the byline, including the message_end abort
	// fallback) is owned entirely by spinner.ts — see its 50ms repaint loop.
}
