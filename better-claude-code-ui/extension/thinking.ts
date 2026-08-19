/**
 * CC thinking rendering — everything pi's API allows, aligned with CC v2.1.234
 * user-verified renders (the local CC snapshot predates them).
 *
 * CC's collapsed thinking leaves NO line in the transcript at all — its only
 * traces are the spinner byline (`thought for Ns`, spinner.ts) and the
 * collapsed tool-group summary (`Thought for 3s, read 1 file`, grouping.ts).
 * pi's own hide path (hideThinkingBlock=true) can't reach that: it renders one
 * Text(hiddenThinkingLabel) row unconditionally (assistant-message.js:107-109),
 * so even an empty label leaves a blank row (the host wraps the label in ANSI
 * color, defeating Text's empty-string check).
 *
 * So this extension owns the collapse itself, on the EXPANDED path:
 *   - ship hideThinkingBlock=false (pi renders thinking through Markdown with
 *     our transformer, assistant-message.js:112-119);
 *   - the transformer returns "" while collapsed — Markdown renders an empty
 *     string as ZERO rows, so collapsed thinking is truly invisible;
 *   - ctrl+shift+t (alt+t on legacy terminals — same Kitty-protocol caveat as
 *     commands.ts's ctrl+shift+o) toggles a module-level expanded flag, then
 *     calls setHiddenThinkingLabel, whose host path runs updateContent() on
 *     every history AssistantMessageComponent + the streaming one
 *     (interactive-mode.js:1655-1666, assistant-message.js:46-50) — rebuilding
 *     each Markdown child so the transformer re-runs with the new state.
 *
 * The hidden label itself stays "" — with hideThinkingBlock=false it is never
 * rendered, and if the user flips pi's own ctrl+t (hide=true) the fallback is
 * a single blank row rather than a stray "Thinking..." line.
 *
 * AUDIT §5 thinking.ts:77 (P2 api-contract): the label is GLOBAL — it rewrites
 * every history component — so it must never carry per-block data (the
 * `∴ 15s` four-way mismatch of AUDIT §3-1). The `thought for Xs` live byline
 * belongs to spinner.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dim, italic } from "./palette.js";

const THINKING_TITLE = "∴ Thinking…";
/** Kept empty: CC has no collapsed-thinking line (see header). */
const HIDDEN_LABEL_THINKING = "";

/** Session-scoped expanded state (CC's transcript view is transient too). */
let thinkingExpanded = false;

/** Test hook / other-module read. */
export function isThinkingExpanded(): boolean {
	return thinkingExpanded;
}

export function registerThinking(pi: ExtensionAPI): void {
	// --- 1. The collapse itself: empty while collapsed, titled body expanded --
	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType !== "assistant-thinking") return markdown;
		if (!thinkingExpanded) return "";
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

	// --- 3. Expand/collapse toggle ----------------------------------------
	const toggle = async (ctx: Parameters<Parameters<typeof pi.registerShortcut>[1]["handler"]>[0]) => {
		thinkingExpanded = !thinkingExpanded;
		if (!ctx.hasUI) return;
		try {
			// Same-value set: the host still walks every AssistantMessageComponent
			// and calls updateContent(), rebuilding the Markdown children so the
			// transformer re-runs with the flipped state.
			ctx.ui.setHiddenThinkingLabel?.(HIDDEN_LABEL_THINKING);
		} catch {
			/* best-effort */
		}
		ctx.ui.notify(`Thinking: ${thinkingExpanded ? "expanded" : "hidden"}`, "info");
	};
	pi.registerShortcut("ctrl+shift+t", {
		description: "Toggle thinking visibility (CC-style)",
		handler: toggle,
	});
	pi.registerShortcut("alt+t", {
		description: "Toggle thinking visibility (fallback for terminals without the Kitty keyboard protocol)",
		handler: toggle,
	});

	// Spinner-row thinking display (the byline, including the message_end abort
	// fallback) is owned entirely by spinner.ts — see its 50ms repaint loop.
}
