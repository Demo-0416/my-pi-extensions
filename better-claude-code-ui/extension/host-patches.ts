/**
 * Runtime patches on HOST classes — the extension-side landing of the
 * upstream PR draft (scratchpad/pi-upstream-pr.md). Remove once upstream
 * merges the equivalent fixes.
 *
 * Technique (learned from npm's pi-claude-code-ui / FammasMaz/pi-cc-tools):
 * `AssistantMessageComponent` and `InteractiveMode` are PUBLIC exports of
 * @earendil-works/pi-coding-agent, and pi's extension loader aliases that
 * specifier to the host's own running module (loader.js getAliases /
 * bundledModules) — so wrapping their prototype methods here patches the
 * live classes the host renders with. No host files are modified; the
 * patch ships with the extension.
 *
 * Patch 1 — AssistantMessageComponent.prototype.render:
 *   (a) A message whose entire rendered output is whitespace returns [].
 *   Why: updateContent predicts spacing from RAW message data — a non-empty
 *   thinking block earns a top Spacer(1) even when the thinking renders zero
 *   rows (our transformer collapses it, CC-style). Every thinking+toolCall
 *   message thus left one orphan blank row; with a thinking model and tool
 *   grouping (tools drawn by the group leader) those stacked into 8+
 *   consecutive blank rows after the group line. CC renders such
 *   intermediate messages as nothing at all.
 *   (b) Leading blank rows collapse to one. A thinking+text message renders
 *   [top Spacer, (thinking → 0 rows), trailing Spacer, body] — two blank
 *   rows before the body where CC has one. The first row is kept (it may
 *   carry the OSC133 copy-zone start mark), the redundant blanks after it
 *   are dropped. Legitimate messages never start with two blank rows: the
 *   host emits at most one top Spacer, and Markdown bodies are trimmed.
 *
 * Patch 2 — InteractiveMode.prototype.showStatus:
 *   Drops exactly the "Tool output: expanded|collapsed" notice. showStatus
 *   appends a Spacer+Text pair to chatContainer, so every Ctrl+O press left
 *   a permanent status row scrolling with the transcript. CC's ctrl+o is
 *   traceless — the expansion itself is the feedback. Every other
 *   showStatus message passes through untouched.
 *
 * Both wrappers call the original method and are Symbol-flag guarded
 * (idempotent across reloads and across multiple extension instances).
 */
import { AssistantMessageComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";

// CSI + OSC (BEL or ST terminated) + charset selects. OSC matters: the host
// render wraps a message's first/last row in OSC133 zone marks, which the
// all-blank check must see through.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]/g;

function isBlankRow(line: unknown): boolean {
	return typeof line === "string" && line.replace(ANSI_RE, "").trim() === "";
}

const BLANK_RENDER_FLAG = Symbol.for("better-cc-ui:assistant-blank-render");
const STATUS_FLAG = Symbol.for("better-cc-ui:tool-output-status");

/** The exact host notice dropped by patch 2 (interactive-mode.js setToolsExpanded). */
const TOOL_OUTPUT_STATUS_RE = /^Tool output: (?:expanded|collapsed)$/;

export function installHostPatches(): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const amProto = AssistantMessageComponent.prototype as any;
	if (!amProto[BLANK_RENDER_FLAG] && typeof amProto.render === "function") {
		const originalRender = amProto.render;
		amProto.render = function ccUiBlankMessageRender(width: number): string[] {
			const lines = originalRender.call(this, width);
			if (!Array.isArray(lines) || lines.length === 0) return lines;
			let blank = 0;
			while (blank < lines.length && isBlankRow(lines[blank])) blank++;
			if (blank === lines.length) return [];
			// (b) collapse a run of leading blank rows to one; keep lines[0] — it
			// may carry the OSC133 zone-start mark.
			if (blank > 1) lines.splice(1, blank - 1);
			return lines;
		};
		amProto[BLANK_RENDER_FLAG] = true;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const imProto = InteractiveMode.prototype as any;
	if (!imProto[STATUS_FLAG] && typeof imProto.showStatus === "function") {
		const originalShowStatus = imProto.showStatus;
		imProto.showStatus = function ccUiFilteredShowStatus(message: unknown): unknown {
			if (typeof message === "string" && TOOL_OUTPUT_STATUS_RE.test(message)) return undefined;
			return originalShowStatus.call(this, message);
		};
		imProto[STATUS_FLAG] = true;
	}
}
