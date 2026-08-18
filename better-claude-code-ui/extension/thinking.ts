/**
 * CC thinking rendering — everything pi's API allows, aligned with
 * claude-code-main/src/components/messages/AssistantThinkingMessage.tsx and
 * src/components/Spinner/SpinnerAnimationRow.tsx.
 *
 * Three behaviors:
 *   1. markdown transformer: every non-empty thinking block gets a
 *      `∴ Thinking…` dim italic title line (CC's expanded shape). The body
 *      keeps pi's built-in thinkingText styling.
 *   2. hidden thinking label: `∴ Thinking` while a block is streaming,
 *      `∴ Thought for Xs` after each block completes (CC's spinner-row
 *      "thought for Xs", surfaced through pi's global hidden label).
 *   3. working message: while a thinking block is active the spinner row
 *      shows dim `(thinking)` — CC's SpinnerAnimationRow thinkingText.
 *
 * pi API limits (see ALIGNMENT.md §13): no per-block toggle, no body
 * indentation (markdown would treat leading spaces as code), no shimmer
 * animation (frames are static strings). pi also joins consecutive thinking
 * blocks into one markdown section, so a run of N blocks shares a single
 * `∴ Thinking…` title (CC renders one title per block).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dim, italic } from "./palette.js";
import { formatTurnDuration } from "./turn-footer.js";
import { currentWorkingVerb } from "./spinner.js";

const THINKING_TITLE = "∴ Thinking…";
const HIDDEN_LABEL_THINKING = "∴ Thinking";

/** Format like CC's `thought for 4s` / `thought for 4m 36s`. */
function thoughtFor(ms: number): string {
	// CC SpinnerAnimationRow.tsx:172 — Math.max(1, Math.round(ms/1000)):
	// rounded to the nearest second, floored at 1s, never "0s". The minutes
	// branch reuses the turn-footer formatter (4m 36s shape, per ALIGNMENT §1).
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
	return formatTurnDuration(ms);
}

/** CC effort.ts:188-196 — the spinner row names the active thinking level. */
function thinkingText(level: string | undefined): string {
	if (!level || level === "none" || level === "off") return dim("(thinking)");
	return dim(`(thinking · ${level})`);
}

export function registerThinking(pi: ExtensionAPI): void {
	let blockStartMs = 0;
	let lastBlockMs = 0;

	// --- 1. Expanded-shape title for every thinking block -----------------
	pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
		if (messageType !== "assistant-thinking") return markdown;
		const body = markdown.trim();
		if (!body) return markdown;
		// Title on its own line — never prefix the body's first line (that
		// corrupts markdown syntax when the block starts with `# ` or `- `).
		return `${dim(italic(THINKING_TITLE))}\n\n${body}`;
	});

	// --- 2 + 3. Duration tracking → hidden label + working message --------
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setHiddenThinkingLabel?.(HIDDEN_LABEL_THINKING);
		} catch {
			/* older pi without setHiddenThinkingLabel */
		}
	});

	// New turn: the previous turn's "Thought for Xs" must not linger — restore
	// the resting label and drop the stale duration (CC's spinner state is
	// per-turn; Spinner.tsx:125-126,147).
	pi.on("turn_start", async (_event, ctx) => {
		blockStartMs = 0;
		lastBlockMs = 0;
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setHiddenThinkingLabel?.(HIDDEN_LABEL_THINKING);
		} catch {
			/* best-effort */
		}
	});

	pi.on("message_update", async (event, ctx) => {
		const kind = event.assistantMessageEvent?.type;
		if (kind === "thinking_start") {
			blockStartMs = Date.now();
			if (ctx.hasUI) {
				try {
					ctx.ui.setWorkingMessage(thinkingText(ctx.thinkingLevel));
				} catch {
					/* best-effort */
				}
			}
		} else if (kind === "thinking_end") {
			if (blockStartMs) {
				lastBlockMs = Date.now() - blockStartMs;
				blockStartMs = 0;
			}
			if (ctx.hasUI) {
				try {
					if (lastBlockMs > 0) {
						ctx.ui.setHiddenThinkingLabel?.(`∴ ${thoughtFor(lastBlockMs)}`);
					}
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
		// through message_end with a failure message). Settle the open block
		// here so its partial duration survives — CC settles on mode-leave,
		// not on the event (Spinner.tsx:136-153).
		if (blockStartMs) {
			lastBlockMs = Date.now() - blockStartMs;
			blockStartMs = 0;
		}
		if (!ctx.hasUI) return;
		try {
			if (lastBlockMs > 0) {
				ctx.ui.setHiddenThinkingLabel?.(`∴ ${thoughtFor(lastBlockMs)}`);
			}
			ctx.ui.setWorkingMessage(`${currentWorkingVerb()}…`);
		} catch {
			/* best-effort */
		}
	});
}
