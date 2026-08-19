/**
 * CC thinking rendering — everything pi's API allows, aligned with
 * claude-code-main/src/components/messages/AssistantThinkingMessage.tsx and
 * src/components/Spinner/SpinnerAnimationRow.tsx.
 *
 * Three behaviors:
 *   1. markdown transformer: when pi renders the thinking body (expanded mode,
 *      hideThinkingBlock=false), every non-empty run of blocks gets a
 *      `∴ Thinking…` dim italic title line (CC's EXPANDED shape,
 *      AssistantThinkingMessage.tsx:62). The body keeps pi's thinkingText.
 *   2. hidden thinking label: EMPTY — CC leaves no collapsed-thinking line in
 *      the transcript at all (v2.1.234 user-verified). pi's
 *      setHiddenThinkingLabel is a GLOBAL label — it rewrites every history
 *      AssistantMessageComponent in chatContainer + the streaming one
 *      (interactive-mode.js:1655-1666), so it must NOT carry per-block data;
 *      "" is also the closest pi allows to CC's no-line-at-all.
 *   3. working message: while a thinking block is active the spinner row
 *      shows dim `(thinking)` — CC's SpinnerAnimationRow thinkingText.
 *
 * Default-collapse (AUDIT §6 P1 / §3-1): CC defaults thinking to a single
 * collapsed line `∴ Thinking (ctrl+o to expand)`; pi renders the body in full
 * whenever its OWN hideThinkingBlock setting is false. That default lives in
 * pi's agent settings.json and is read at InteractiveMode construction
 * (interactive-mode.js:389), BEFORE any extension session_start — and the
 * extension API exposes no setter for it. So the collapse DEFAULT cannot be
 * flipped from here; the user sets it once via ctrl+t (persisted) or in
 * settings.json (hideThinkingBlock: true — the shipped config already does).
 * What this file CAN own is the exact collapsed-line TEXT, which pi surfaces
 * through the global hidden label. CC's literal key is ctrl+o; pi's thinking
 * expand key is ctrl+t (app.thinking.toggle, keybindings.js:28 — ctrl+o is
 * tool output in pi), so the hint names ctrl+t. The key text is hardcoded to
 * the default; a user rebind makes it stale (AUDIT §6 P3, shared gap).
 *
 * pi API limits (see ALIGNMENT.md §13): no per-block toggle, no body
 * indentation (markdown would treat leading spaces as code), no shimmer
 * animation (frames are static strings). pi also joins consecutive thinking
 * blocks into one markdown section, so a run of N blocks shares a single
 * `∴ Thinking…` title (CC renders one title per block).
 *
 * AUDIT §5 thinking.ts:77 (P2 api-contract): the earlier `∴ Thought for Xs`
 * per-block duration written into the global label relabelled EVERY history
 * thinking block to the latest block's duration (the `∴ 15s` four-way mismatch
 * of AUDIT §3-1). The `thought for Xs` spinner-row byline is a separate spinner
 * concern (AUDIT §6 spinner P2, B6); it does not belong in this global label.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dim, italic } from "./palette.js";

const THINKING_TITLE = "∴ Thinking…";
// CC v2.1.234 (user-verified renders): collapsed thinking leaves NO line at all
// in the transcript — its only trace is the spinner byline (`thought for Ns`)
// and the collapsed tool-group summary (`Thought for 3s, read 1 file`). pi's
// hide branch unconditionally renders one Text(label) row
// (assistant-message.js:109), so an empty label is the closest reachable state:
// the host wraps it in ANSI color, leaving a single blank row. The full body
// stays reachable via ctrl+t (hideThinkingBlock=false → transformer above).
const HIDDEN_LABEL_THINKING = "";

export function registerThinking(pi: ExtensionAPI): void {
	// --- 1. Expanded-shape title for every thinking block -----------------
	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType !== "assistant-thinking") return markdown;
		const body = markdown.trim();
		if (!body) return markdown;
		// Title on its own line — never prefix the body's first line (that
		// corrupts markdown syntax when the block starts with `# ` or `- `).
		return `${dim(italic(THINKING_TITLE))}\n\n${body}`;
	});

	// --- 2. Collapsed-line label (constant, GLOBAL) -----------------------
	// pi resets the label to its default on session invalidate (resetExtensionUI
	// → interactive-mode.js:1743), so re-assert on every session_start.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setHiddenThinkingLabel?.(HIDDEN_LABEL_THINKING);
		} catch {
			/* older pi without setHiddenThinkingLabel */
		}
	});

	// --- 3. Keep the global collapsed-line label asserted ------------------
	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			// The label is constant, but keep it asserted in case anything else
			// touched pi's global label mid-request.
			ctx.ui.setHiddenThinkingLabel?.(HIDDEN_LABEL_THINKING);
		} catch {
			/* best-effort */
		}
	});

	// Spinner-row thinking display (the "(thinking)" byline segment, including
	// the message_end abort fallback) is owned entirely by spinner.ts — its 50ms
	// repaint loop listens to thinking_start/end itself. Writing the working
	// message from here too raced it: a glyph-less bare line flickered for a
	// frame before the spinner's repaint overwrote it (对抗复审 confirmed).

}
