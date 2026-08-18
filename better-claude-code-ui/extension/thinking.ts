/**
 * CC thinking rendering — everything pi's API allows, aligned with
 * claude-code-main/src/components/messages/AssistantThinkingMessage.tsx and
 * src/components/Spinner/SpinnerAnimationRow.tsx.
 *
 * Three behaviors:
 *   1. markdown transformer: every non-empty thinking block gets a
 *      `∴ Thinking…` dim italic title line (CC's expanded shape). The body
 *      keeps pi's built-in thinkingText styling.
 *   2. hidden thinking label: a CONSTANT `∴ Thinking` collapsed line. pi's
 *      setHiddenThinkingLabel is a GLOBAL label — it rewrites every history
 *      AssistantMessageComponent in chatContainer + the streaming one
 *      (interactive-mode.js:1655-1666), so it must NOT carry per-block data.
 *   3. working message: while a thinking block is active the spinner row
 *      shows dim `(thinking)` — CC's SpinnerAnimationRow thinkingText.
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
import { currentWorkingVerb } from "./spinner.js";

const THINKING_TITLE = "∴ Thinking…";
const HIDDEN_LABEL_THINKING = "∴ Thinking";

/** CC effort.ts:188-196 — the spinner row names the active thinking level. */
function thinkingText(level: string | undefined): string {
	if (!level || level === "none" || level === "off") return dim("(thinking)");
	return dim(`(thinking · ${level})`);
}

export function registerThinking(pi: ExtensionAPI): void {
	// Whether a thinking block opened without a matching thinking_end, so the
	// abort path can restore the spinner verb. NOT a duration — the global
	// hidden label must never carry per-block data (AUDIT §5 thinking.ts:77).
	let thinkingActive = false;

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

	// --- 3. Spinner working message: (thinking) → verb -------------------
	pi.on("turn_start", async (_event, ctx) => {
		thinkingActive = false;
		if (!ctx.hasUI) return;
		try {
			// The label is constant, but keep it asserted in case anything else
			// touched pi's global label mid-request.
			ctx.ui.setHiddenThinkingLabel?.(HIDDEN_LABEL_THINKING);
		} catch {
			/* best-effort */
		}
	});

	pi.on("message_update", async (event, ctx) => {
		const kind = event.assistantMessageEvent?.type;
		if (kind === "thinking_start") {
			thinkingActive = true;
			if (ctx.hasUI) {
				try {
					ctx.ui.setWorkingMessage(thinkingText(ctx.thinkingLevel));
				} catch {
					/* best-effort */
				}
			}
		} else if (kind === "thinking_end") {
			thinkingActive = false;
			if (ctx.hasUI) {
				try {
					// Restore the turn's spinner verb (CC: thinking text gives
					// way to the verb once the block ends).
					ctx.ui.setWorkingMessage(`${currentWorkingVerb()}…`);
				} catch {
					/* best-effort */
				}
			}
		}
	});

	pi.on("message_end", async (_event, ctx) => {
		// Abort path: thinking_end may never fire when the stream dies (pi goes
		// through message_end with a failure message), leaving the spinner stuck
		// on `(thinking)`. Restore the verb when a block was left open — CC
		// settles thinking on mode-leave, not on the event (Spinner.tsx:136-153).
		if (!thinkingActive) return;
		thinkingActive = false;
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWorkingMessage(`${currentWorkingVerb()}…`);
		} catch {
			/* best-effort */
		}
	});
}
