/**
 * Builtin tool rendering (read/bash/grep/find/ls/edit/write) — CC-aligned.
 *
 * execute delegates to pi's builtin tool factories; renderCall/renderResult
 * produce CC-style rows: `⏺ BoldName(detail)` call headers and `⎿`-prefixed
 * result bodies. Group-aware (non-leader group members render zero lines via
 * self-shell). Live preview for streaming bash. Width-keyed render caches.
 *
 * CC facts:
 * - Call row: [dot][bold name][(detail)] (AssistantToolUseMessage.tsx:186-285)
 * - Dot state machine: blinking dim while running, green success, red error
 *   (ToolUseLoader.tsx:19-33, useBlink.ts 600ms)
 * - Bash detail: 2 lines / 160 chars (BashTool/UI.tsx:26-127)
 * - Bash result: status line only when there is no output (or on failure);
 *   no output → dim "(No output)" (BashToolResultMessage.tsx:100-169)
 * - Result preview budget is in VISUAL rows (post-wrap), head-first, with a
 *   `… +N lines (ctrl+o to expand)` footer, and the input is sliced to
 *   `rows × wrapWidth × 4` BEFORE wrapping (utils/terminal.ts:7-113
 *   renderTruncatedContent, reached via OutputLine.tsx:73). Streaming keeps a
 *   5-row TAIL window instead (ShellProgressMessage.tsx:44,83).
 * - Edit/Write stat: "Added N lines, Removed M lines" numbers bold
 *   (FileEditToolUpdatedMessage.tsx:32-110)
 * - Read/Grep collapsed: "Read N lines" / "Found N files" numbers bold
 *   (FileReadTool/UI.tsx:131, GrepTool/UI.tsx:45)
 * - Write new file: "Wrote N lines to <path>" + first 10 lines highlighted +
 *   "… +N lines" + ctrl+o hint (FileWriteTool/UI.tsx:39-127)
 * - Write userFacingName is always "Write" (FileWriteTool/UI.tsx:128-136)
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative } from "node:path";
import {
	DiffCardComponent,
	parseDiff,
	renderDiffStatLine,
	renderUnified,
	shikiThemeForPalette,
	shouldUseSplit,
	renderSplit,
	MAX_RENDER_LINES,
	MAX_PREVIEW_LINES,
	diffLanguage,
	shikiHighlighter,
	warmHighlightCache,
	warmDiffHighlight,
	setDiffPalette,
	type DiffLine,
	type ParsedDiff,
} from "./diff.js";
import {
	getGroupRenderInfo,
	isHiddenGroupMember,
	makeText,
	registerGroupInvalidator,
	renderCollapsedSummary,
	renderGroupPreview,
	currentBlinkPhase,
	armBlink,
} from "./grouping.js";
import { resolvePalette, italic, type ResolvedPalette } from "../palette.js";

// CC figures.ts: BLACK_CIRCLE = env.platform === 'darwin' ? '⏺' : '●'.
const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

// CC MessageResponse: paddingLeft=2 + "⎿  " (⎿ + 2 spaces). The glyph sits at
// column 2 — the same column the tool name starts in on the call row — so a
// result reads as a child of its call. Continuation lines indent to column 5.
const RESULT_LEAD = `  ⎿  `;
const RESULT_INDENT = " ".repeat(RESULT_LEAD.length);

// CC BashTool/UI.tsx:26-27.
const MAX_COMMAND_DISPLAY_LINES = 2;
const MAX_COMMAND_DISPLAY_CHARS = 160;

// CC FileWriteTool/UI.tsx:26.
const WRITE_PREVIEW_LINES = 10;

// AUDIT §2 P0-3 — cap the pre-write snapshot read. pi truncates bash stdout at
// the tool layer (truncate.js:10) but the write old-content path does raw
// readFileSync with no ceiling; a 20MB kitex_gen .go = 20MB resident + parseDiff
// superlinear intermediates. Above this the diff degrades to "Wrote N lines".
const MAX_DIFF_FILE_BYTES = 1_048_576; // 1 MiB
// Bound the per-session snapshot maps so a long session with many writes does
// not accumulate one old-file copy per toolCallId forever (AUDIT §5:670).
const MAX_WRITE_SNAPSHOTS = 64;

const PREVIEW_LINES = 8;
const EXTRA_DETAIL_LINES = 12000;

// CC ShellProgressMessage.tsx:44,83 — the streaming preview is a fixed 5-row
// tail window (`lines.slice(-5)` inside `<Box height={5} overflow="hidden">`).
// Completed results flip to head-first (renderTruncatedContent); only the live
// view tails, because tailing is the point while output is still arriving.
const STREAM_PREVIEW_ROWS = 5;

// The expanded-group glance body is composed into one string by the leader, so
// no render width reaches it. 80 columns is the conventional fallback and only
// affects where a long row is chunked, not the row budget itself.
const GROUP_PREVIEW_NOMINAL_WIDTH = 80;

let extraDetail = false;
export function setExtraDetail(v: boolean): void {
	extraDetail = v;
}

function previewLimit(): number {
	return extraDetail ? EXTRA_DETAIL_LINES : PREVIEW_LINES;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function shortPath(cwd: string, filePath: string): string {
	if (!filePath) return "";
	let rel: string;
	try {
		rel = relative(cwd, filePath);
	} catch {
		rel = filePath;
	}
	if (!rel.startsWith("..") && !rel.startsWith("/")) return rel || ".";
	const home = process.env.HOME ?? "";
	return home ? filePath.replace(home, "~") : filePath;
}

/** CC BashTool/UI.tsx:104-127 — truncate to 2 lines, then 160 chars, append …
 *  CC slices by code unit; we slice by visible width instead (AUDIT §5:120) so
 *  a CJK command header can't reach 320 columns and a surrogate pair / grapheme
 *  is never split mid-character. `truncateToWidth` appends the ellipsis itself. */
function truncateCommand(command: string): string {
	const lines = command.split("\n");
	const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES;
	const needsCharTruncation = visibleWidth(command) > MAX_COMMAND_DISPLAY_CHARS;
	if (!needsLineTruncation && !needsCharTruncation) return command;
	let truncated = command;
	if (needsLineTruncation) {
		truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join("\n");
	}
	truncated = truncated.trim();
	if (visibleWidth(truncated) > MAX_COMMAND_DISPLAY_CHARS) {
		// width-aware, grapheme-safe; ellipsis counts toward the budget.
		return truncateToWidth(truncated, MAX_COMMAND_DISPLAY_CHARS, "…");
	}
	return `${truncated}…`;
}

function summarizeText(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function resultText(result: unknown): string {
	const r = result as { content?: Array<{ type: string; text?: string }> } | undefined;
	if (!r || !Array.isArray(r.content)) return "";
	return r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

function resultHasImage(result: unknown): boolean {
	const r = result as { content?: Array<{ type: string }> } | undefined;
	return !!r && Array.isArray(r.content) && r.content.some((b) => b.type === "image");
}

// pi's human-readable empty-result sentences (grep.js:239, find.js:130,
// ls.js:123) — non-empty lines that must count as zero, not one.
const EMPTY_SENTINELS = new Set(["No matches found", "No files found matching pattern", "(empty directory)"]);

function isEmptySentinel(text: string): boolean {
	return EMPTY_SENTINELS.has(text.trim());
}

/** Strip pi's trailing notices block. grep/find/ls append `\n\n[<notices>]`
 *  (e.g. "[500 results limit reached. Use limit=1000 for more]") to the result
 *  text (grep.js:280, find.js:152, ls.js:142); counting it as a result line
 *  inflates every at-limit stat by one (AUDIT §5:571, §5:611, §5:158). */
function stripNoticesTrailer(text: string): string {
	return text.replace(/\n\n\[[^\n]*\]\s*$/, "");
}

/**
 * The host builds its builtin tools from settings — read:{autoResizeImages},
 * bash:{commandPrefix, shellPath} (agent-session.js _buildRuntime). Re-creating
 * a definition inside execute without them dropped the user's shellPath /
 * commandPrefix / autoResizeImages (AUDIT §5:465). pi does not expose its
 * SettingsManager to extensions, so read the same merged settings it does:
 * global ~/.pi/agent/settings.json overridden by project <cwd>/.pi/settings.json.
 */
function hostToolSettings(cwd: string): { shellPath?: string; commandPrefix?: string; autoResizeImages: boolean } {
	const home = homedir();
	let shellPath: string | undefined;
	let commandPrefix: string | undefined;
	let autoResize: boolean | undefined;
	for (const path of [join(home, ".pi", "agent", "settings.json"), join(cwd, ".pi", "settings.json")]) {
		try {
			if (!existsSync(path)) continue;
			const raw = JSON.parse(readFileSync(path, "utf8")) as {
				shellPath?: string;
				shellCommandPrefix?: string;
				images?: { autoResize?: boolean };
			};
			if (typeof raw.shellPath === "string") shellPath = raw.shellPath;
			if (typeof raw.shellCommandPrefix === "string") commandPrefix = raw.shellCommandPrefix;
			if (typeof raw.images?.autoResize === "boolean") autoResize = raw.images.autoResize;
		} catch {
			/* unreadable settings file — fall through to defaults */
		}
	}
	// settings-manager normalizes ~ in shellPath before use; mirror that.
	if (shellPath?.startsWith("~")) shellPath = join(home, shellPath.slice(1));
	return { shellPath, commandPrefix, autoResizeImages: autoResize ?? true };
}

/**
 * Parse pi's real unified patch (edit result.details.patch, edit-diff.js
 * generateUnifiedPatch) into a ParsedDiff. The old edits[]-concatenation diff
 * numbered every change from line 1 and had no true file context; the patch
 * carries the real hunk positions (AUDIT §5:817). Returns null when the string
 * has no parseable hunk so callers can fall back.
 */
function parsePatchToDiff(patch: string): ParsedDiff | null {
	const rawLines = patch.split("\n");
	if (rawLines[rawLines.length - 1] === "") rawLines.pop();
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	let chars = 0;
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	let prevHunk: { oldStart: number; oldLines: number } | null = null;
	for (const rawWithCr of rawLines) {
		// pi generateUnifiedPatch splits on "\n" only, so CRLF files leave a
		// trailing \r on every patch line — carriage returns wipe the drawn
		// gutter at render time (same cleanse as diff.ts fromPatch, §5:523).
		const raw = rawWithCr.endsWith("\r") ? rawWithCr.slice(0, -1) : rawWithCr;
		const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
		if (h) {
			const oldStart = Number(h[1]);
			const oldCount = h[2] !== undefined ? Number(h[2]) : 1;
			if (prevHunk) {
				// Same sep semantics as fromPatch: gap = unchanged lines skipped.
				const gap = oldStart - (prevHunk.oldStart + prevHunk.oldLines);
				lines.push({ type: "sep", oldNum: null, newNum: gap > 0 ? gap : null, content: "" });
			}
			prevHunk = { oldStart, oldLines: oldCount };
			oldLine = oldStart;
			newLine = Number(h[3]);
			inHunk = true;
			continue;
		}
		if (!inHunk) continue; // ---/+++ file headers
		if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
		const marker = raw[0];
		const text = raw.slice(1);
		if (marker === "+") {
			lines.push({ type: "add", oldNum: null, newNum: newLine, content: text });
			newLine += 1;
			added += 1;
			chars += text.length;
		} else if (marker === "-") {
			lines.push({ type: "del", oldNum: oldLine, newNum: null, content: text });
			oldLine += 1;
			removed += 1;
			chars += text.length;
		} else {
			// " " context; some generators emit blank context lines with no marker.
			lines.push({ type: "ctx", oldNum: oldLine, newNum: newLine, content: text });
			oldLine += 1;
			newLine += 1;
			chars += text.length;
		}
	}
	return lines.length > 0 ? { lines, added, removed, chars } : null;
}

/** CC countLines (FileWriteTool/UI.tsx:35-38): a trailing EOL terminates the
 *  last line, it does not start a new one. */
function countLines(text: string): number {
	if (text === "") return 0;
	return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

/** CC GrepTool files_with_matches: N = unique files. pi emits one line per
 *  match as `path:lineno: text`; with context>0 it also emits context lines as
 *  `path-lineno- text` (grep.js:192-194). Count files from MATCH lines only —
 *  a context line's file always has a match line, and treating unparseable
 *  lines (context, notices) as whole-line "files" inflated the count by one
 *  per context line (AUDIT §5:158). */
function countGrepFiles(lines: string[]): number {
	const files = new Set<string>();
	for (const line of lines) {
		const m = /^(.+?):\d+: /.exec(line);
		if (m) files.add(m[1]!);
	}
	// Output with no parseable match line at all (defensive): fall back to
	// counting distinct raw lines so the stat is never a hard 0 for real output.
	if (files.size === 0 && lines.length > 0) return new Set(lines).size;
	return files.size;
}

// ---------------------------------------------------------------------------
// CC-faithful visual-row truncation (port of CC src/utils/terminal.ts:7-113)
//
// The bug this replaces: our preview budget counted LOGICAL lines while CC and
// pi both count VISUAL rows (post-wrap). `grep -rn` over a minified bundle is
// 2 logical lines / 50KB, so an 8-logical-line budget was no budget at all —
// measured 654 rendered rows at width 100 (pi's own bash renderer: 5) and a
// 27.9MB heap delta, because every one of the 50KB got wrapped. CC hit the
// same wall ("64MB binary dumps that cause 382K-row screens", terminal.ts:83)
// and fixed it with the two guards ported below:
//   1. budget in visual rows, chunking long lines by width (CC wrapText);
//   2. slice the input to `rows * wrapWidth * 4` BEFORE wrapping, and estimate
//      the remainder from raw length, so cost is bounded by the budget rather
//      than by output size (CC renderTruncatedContent).
// ---------------------------------------------------------------------------

/** CC terminal.ts:85 — only wrap enough input to fill the budget. The ×4 slack
 *  covers ANSI escapes and wide characters that make bytes ≠ columns. */
function preWrapCharCap(rows: number, wrapWidth: number): number {
	return Math.max(1, rows) * wrapWidth * 4;
}

/** CC terminal.ts:36 trims each chunk's trailing whitespace (trimEnd) but keeps
 *  a leading space: hard chunking at a column boundary can start a row mid-gap,
 *  and CC preserves that alignment rather than re-flowing the text. */
function trimTrailingSpace(text: string): string {
	return text.replace(/[ \t]+$/, "");
}

/**
 * CC terminal.ts:19-60 wrapText — split into visual rows by hard-chunking at
 * `wrapWidth` (NOT word wrapping: shell output is not prose, and CC slices
 * mid-word), then keep the first `rows`.
 *
 * CC's `remainingLines === 1` special case is preserved: showing one extra row
 * beats spending that row on a "… +1 lines" hint.
 */
function visualRowsHead(text: string, wrapWidth: number, rows: number): { shown: string[]; remaining: number } {
	const width = Math.max(1, Math.floor(wrapWidth));
	const wrapped: string[] = [];
	for (const line of text.split("\n")) {
		const lineWidth = visibleWidth(line);
		if (lineWidth <= width) {
			wrapped.push(trimTrailingSpace(line));
		} else {
			// ANSI-aware chunking; sliceByColumn re-opens active SGR state per chunk.
			// NB: its 3rd argument is a LENGTH, not an end column (pi-tui
			// utils.d.ts:78) — passing `col + width` there yields ever-widening
			// chunks that overflow the gutter and duplicate the tail.
			for (let col = 0; col < lineWidth; col += width) {
				wrapped.push(trimTrailingSpace(sliceByColumn(line, col, width)));
				// Stop early once past the budget — the caller only needs `rows` plus
				// enough to know that more exists.
				if (wrapped.length > rows + 1) break;
			}
		}
		if (wrapped.length > rows + 1) break;
	}
	const remaining = wrapped.length - rows;
	// CC terminal.ts:44-53 — exactly one row past the fold: show it instead.
	if (remaining === 1) return { shown: wrapped.slice(0, rows + 1), remaining: 0 };
	return { shown: wrapped.slice(0, rows), remaining: Math.max(0, remaining) };
}

/**
 * CC terminal.ts:71-113 renderTruncatedContent — head-first visual-row preview
 * with a `… +N lines (ctrl+o to expand)` footer.
 *
 * `rows` is the visual-row budget; `wrapWidth` is the content width (terminal
 * width minus the `⎿  ` gutter). Returns styled text ready for leadBody().
 */
function renderTruncatedContent(
	text: string,
	wrapWidth: number,
	rows: number,
	theme: Theme,
	styleLine: (line: string) => string,
	options: { expandHint?: boolean } = {},
): string {
	const trimmed = text.replace(/\s+$/, "");
	if (trimmed === "") return "";
	const width = Math.max(1, Math.floor(wrapWidth));

	// Guard 2: bound the work by the budget, not by the input size.
	const maxChars = preWrapCharCap(rows, width);
	const preTruncated = trimmed.length > maxChars;
	const forWrapping = preTruncated ? trimmed.slice(0, maxChars) : trimmed;

	const { shown, remaining } = visualRowsHead(forWrapping, width, rows);

	// CC terminal.ts:93-99 — when the input was pre-sliced the true remainder is
	// unknown, so estimate it from raw length rather than wrapping the rest.
	const estimated = preTruncated
		? Math.max(remaining, Math.ceil(trimmed.length / width) - rows)
		: remaining;

	let out = shown.map((l) => styleLine(l === "" ? " " : l)).join("\n");
	if (estimated > 0) {
		// CC terminal.ts:103-108 — `… +N lines` + `(ctrl+o to expand)`. CC always
		// pluralizes "lines" here; the hint is suppressed inside nested/virtual
		// lists (CtrlOToExpand.tsx:34), mirrored by expandHint:false.
		const hint = `… +${estimated} lines`;
		const suffix = options.expandHint === false ? "" : ` ${italic("(ctrl+o to expand)")}`;
		out += `\n${theme.fg("dim", hint)}${suffix}`;
	}
	return out;
}

/** Content width available to a result body: terminal width minus the `⎿  `
 *  gutter. Render-time width is unknown when renderResult() builds the string,
 *  so bodies that need it are built inside the component's render(width). */
function resultContentWidth(width: number): number {
	return Math.max(10, Math.floor(width) - RESULT_CONTENT_COL);
}

/**
 * The streaming counterpart: CC ShellProgressMessage.tsx:44,83 tails the last
 * `rows` and clips with `<Box height={rows} overflow="hidden">`. Same visual-row
 * budget as the completed path, opposite direction, no expand hint (the result
 * is not final yet).
 */
function tailVisualRows(lines: string[], wrapWidth: number, rows: number, styleLine: (line: string) => string): string {
	const width = Math.max(1, Math.floor(wrapWidth));
	// Only the last `rows` logical lines can contribute, and each contributes at
	// most `rows` visual rows — so cap the input the same way the head path does
	// instead of wrapping a 50KB minified line to find its tail.
	const candidates = lines.slice(-rows);
	const out: string[] = [];
	// Walk backwards, prepending, so `out` stays in display order throughout.
	for (let i = candidates.length - 1; i >= 0 && out.length < rows; i--) {
		const line = candidates[i]!;
		const lineWidth = visibleWidth(line);
		if (lineWidth <= width) {
			out.unshift(line);
			continue;
		}
		// Take this line's LAST chunks (its visual tail), on the same chunk
		// boundaries the head path uses, and prepend them in order.
		const chunkCount = Math.ceil(lineWidth / width);
		const need = rows - out.length;
		const firstChunk = Math.max(0, chunkCount - need);
		const chunks: string[] = [];
		for (let ci = firstChunk; ci < chunkCount; ci++) {
			// 3rd arg is a length, not an end column (pi-tui utils.d.ts:78).
			chunks.push(sliceByColumn(line, ci * width, width));
		}
		out.unshift(...chunks);
	}
	return out
		.slice(-rows)
		.map((l) => styleLine(l === "" ? " " : l))
		.join("\n");
}

function collectNonEmptyLines(text: string, tailLimit?: number): { lines: string[]; total: number } {
	const keepTail = typeof tailLimit === "number";
	const limit = keepTail ? Math.max(0, Math.floor(tailLimit)) : 0;
	const lines: string[] = [];
	let total = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length > 0) {
			total++;
			if (!keepTail) lines.push(line);
			else if (limit > 0) {
				if (lines.length === limit) lines.shift();
				lines.push(line);
			}
		}
	}
	return { lines, total };
}

// ---------------------------------------------------------------------------
// Theme / palette
// ---------------------------------------------------------------------------

function getPalette(theme: Theme): ResolvedPalette {
	return resolvePalette(theme.name, (token) => {
		try {
			return theme.fg(token as never, "x");
		} catch {
			return undefined;
		}
	});
}

// CC ToolUseLoader.tsx:19-33 — color = isUnresolved ? undefined(dim) :
// isError ? 'error' : 'success'. While running the dot blinks on/off.
function statusDot(ctx: RenderContext, theme: Theme): string {
	if (ctx.isError) return theme.fg("error", BLACK_CIRCLE);
	if (ctx.isPartial) {
		if (ctx.executionStarted) {
			// Register this component so blinkTick toggles it too — without this
			// the dot freezes (and phase=false renders an invisible space).
			armBlink(ctx.toolCallId, ctx.invalidate);
			return currentBlinkPhase(ctx.toolCallId) ? theme.fg("dim", BLACK_CIRCLE) : " ";
		}
		return theme.fg("dim", BLACK_CIRCLE);
	}
	return theme.fg("success", BLACK_CIRCLE);
}

// CC AssistantToolUseMessage.tsx:200-210 — bold default-color name + (summary).
function toolHeader(tool: string, summary: string, theme: Theme, dot: string): string {
	const label = theme.bold(tool);
	const body = summary ? `${label}(${summary})` : label;
	return `${dot} ${body}`;
}

// ---------------------------------------------------------------------------
// Result prefix: `  ⎿  ` first line, 5-space continuation
// ---------------------------------------------------------------------------

function withResultLead(theme: Theme, text: string): string {
	const lead = theme.fg("dim", RESULT_LEAD);
	return `${lead}${text}`;
}

/** Prefix a multi-line body with the `⎿  ` lead, continuation lines indented
 *  to column 5 (CC MessageResponse: the whole response shares one gutter). */
function leadBody(theme: Theme, body: string): string {
	return `${theme.fg("dim", RESULT_LEAD)}${indentResultBody(body)}`;
}

/** Indent continuation lines to align after the `⎿  ` lead. */
function indentResultBody(text: string): string {
	return text
		.split("\n")
		.map((line, i) => (i === 0 ? line : `${RESULT_INDENT}${line}`))
		.join("\n");
}

// ---------------------------------------------------------------------------
// Render cache — a result body renders as `  ⎿  ` on line 0 and 5-space indent
// on every explicit continuation line; the content column is 5. pi-tui Text
// word-wraps a long logical line back to column 0 (AUDIT §5:241), so we wrap
// here with a fixed 5-column hanging indent: the prefix (⎿ lead or 5 spaces)
// stays put and each wrap continuation re-indents to column 5, matching CC's
// MessageResponse where the whole response shares one gutter.
// ---------------------------------------------------------------------------

/** Visible width of the `⎿  ` lead / continuation indent = the content column. */
const RESULT_CONTENT_COL = RESULT_INDENT.length; // 5

/**
 * Wrap `text` (already prefixed: line 0 with the ⎿ lead, later lines with 5
 * spaces) to `width`, re-indenting word-wrap continuations to column `indent`.
 * The first `indent` visible columns of each logical line are treated as a
 * fixed gutter; only the content past them wraps, and continuation rows get a
 * plain `indent`-space gutter so they align under the content, not at column 0.
 */
function wrapResultBody(text: string, width: number, indent: number): string[] {
	const out: string[] = [];
	const maxWidth = Math.max(1, Math.floor(width));
	const pad = " ".repeat(indent);
	const contentWidth = Math.max(1, maxWidth - indent);
	for (const logical of text.split("\n")) {
		if (visibleWidth(logical) <= maxWidth) {
			out.push(logical);
			continue;
		}
		// Split the fixed gutter from the content (ANSI-aware). The lead and the
		// 5-space indent both occupy exactly `indent` visible columns.
		const gutter = sliceByColumn(logical, 0, indent);
		const content = sliceByColumn(logical, indent, Number.MAX_SAFE_INTEGER);
		const wrapped = wrapTextWithAnsi(content, contentWidth);
		out.push(`${gutter}${wrapped[0] ?? ""}`);
		for (let i = 1; i < wrapped.length; i++) out.push(`${pad}${wrapped[i]}`);
	}
	// Component.render() has a hard width contract. Keep a final ANSI-aware
	// guard even when an upstream line contains unusual whitespace or controls.
	return out.map((line) => (visibleWidth(line) <= maxWidth ? line : truncateToWidth(line, maxWidth, "")));
}

class CachedTextComponent implements Component {
	private text = "";
	private cachedWidth = -1;
	private cachedLines: string[] | undefined;
	setText(text: string): void {
		if (this.text === text) return;
		this.text = text;
		this.invalidate();
	}
	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const lines = this.text === "" ? [] : wrapResultBody(this.text, width, RESULT_CONTENT_COL);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = undefined;
	}
}

function cachedText(last: unknown, text: string): CachedTextComponent {
	// AUDIT §2 P0-4 — only reuse `last` when it is actually a CachedTextComponent.
	// Ctrl+O on a write-new-file result swaps the component to a DiffCardComponent
	// on expand; collapsing again lands back here with that DiffCardComponent as
	// `last`, and calling .setText on it throws TypeError (→ pi's raw fallback).
	const t = last instanceof CachedTextComponent ? last : new CachedTextComponent();
	t.setText(text);
	return t;
}

/**
 * A result body whose preview budget depends on the render width, so the text
 * can only be built inside render(width) (CC reads `useTerminalSize().columns`
 * for the same reason, OutputLine.tsx:56).
 *
 * `build(contentWidth)` returns the un-prefixed body; this component adds the
 * `⎿  ` lead + 5-column hanging indent and caches per width.
 */
class WidthBudgetedBodyComponent implements Component {
	private build: (contentWidth: number) => string = () => "";
	private lead = RESULT_LEAD;
	private key = "";
	private cachedWidth = -1;
	private cachedLines: string[] | undefined;
	/** `key` identifies the inputs (including the theme-resolved lead); when it
	 *  is unchanged the per-width cache survives the re-render. */
	setBuild(key: string, lead: string, build: (contentWidth: number) => string): void {
		this.build = build;
		this.lead = lead;
		if (this.key === key) return;
		this.key = key;
		this.invalidate();
	}
	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const body = this.build(resultContentWidth(width));
		// The body is already within budget; wrapResultBody only applies the gutter
		// and enforces Component.render()'s width contract.
		const lines = body === "" ? [] : wrapResultBody(`${this.lead}${indentResultBody(body)}`, width, RESULT_CONTENT_COL);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = undefined;
	}
}

function widthBudgetedBody(
	last: unknown,
	theme: Theme,
	key: string,
	build: (contentWidth: number) => string,
): WidthBudgetedBodyComponent {
	// Same instanceof guard as cachedText (AUDIT §2 P0-4): ctrl+o can swap the
	// component type between renders, and .setBuild on a foreign object throws.
	const c = last instanceof WidthBudgetedBodyComponent ? last : new WidthBudgetedBodyComponent();
	const lead = theme.fg("dim", RESULT_LEAD);
	// The theme name is part of the cache key so a live theme switch repaints
	// (palette-b6 live-theme contract) instead of serving stale colors.
	c.setBuild(`${theme.name}\u0000${key}`, lead, build);
	return c;
}

// ---------------------------------------------------------------------------
// Live preview state (bash streaming)
// ---------------------------------------------------------------------------

/** Live line count stored in renderer state, read by renderCall for the trailing. */
const LIVE_LINE_COUNT_KEY = "_liveLineCount";

function setLiveLineCount(ctx: RenderContext, count: number): void {
	(ctx.state as Record<string, unknown>)[LIVE_LINE_COUNT_KEY] = count;
}

function getLiveLineCount(ctx: RenderContext): number | undefined {
	const v = (ctx.state as Record<string, unknown>)[LIVE_LINE_COUNT_KEY];
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** CC-style `(N lines)` trailing on the call header while streaming. */
function liveLineCountTrailing(ctx: RenderContext, theme: Theme): string {
	if (!ctx.isPartial) return "";
	const count = getLiveLineCount(ctx);
	if (count === undefined) return "";
	return ` ${theme.fg("muted", `(${count} line${count === 1 ? "" : "s"})`)}`;
}

// ---------------------------------------------------------------------------
// Group-aware render slots
// ---------------------------------------------------------------------------

type RenderContext = {
	state: Record<string, unknown>;
	lastComponent: unknown;
	invalidate: () => void;
	toolCallId: string;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	isError: boolean;
	args: unknown;
};

function displayPathFor(ctx: RenderContext): (p: string) => string {
	return (p: string) => shortPath(ctx.cwd, p);
}

/**
 * The ctrl+o-expanded body shared by read/grep/find/ls: a stat line plus the
 * result rows, budgeted in VISUAL rows at render width.
 *
 * These are already the expanded view, so the row ceiling is MAX_RENDER_LINES
 * rather than previewLimit(), and the `(ctrl+o to expand)` hint is suppressed —
 * ctrl+o is what got us here. Without a ceiling a single minified row expanded
 * to ~212 rendered rows per line.
 */
function expandedStatBody(
	ctx: RenderContext,
	theme: Theme,
	key: string,
	stat: string,
	lines: string[],
): Component {
	const joined = lines.join("\n");
	return widthBudgetedBody(ctx.lastComponent, theme, `${key}\u0000${joined.length}\u0000${joined.slice(0, 4096)}`, (contentWidth) => {
		const body = renderTruncatedContent(joined, contentWidth, MAX_RENDER_LINES, theme, (l) => theme.fg("dim", l), {
			expandHint: false,
		});
		return body === "" ? stat : `${stat}\n${body}`;
	});
}

/** The per-member result line for an expanded group's glance preview. */
function groupMemberPreview(m: { status: string; result: unknown }, theme: Theme): string {
	if (m.status === "pending") return theme.fg("dim", "…");
	const out = resultText(m.result);
	if (!out) return "";
	// Head-first, same direction as the standalone completed result (CC routes
	// both through OutputLine → renderTruncatedContent). The group body is a
	// nested list, so the ctrl+o hint is suppressed — CC CtrlOToExpand.tsx:34
	// returns null inside a sub-agent / virtual list.
	//
	// This path renders to a plain string (the group leader composes one block),
	// so the render width is unavailable. Budget against a nominal width, which
	// bounds a minified line to a few wrapped rows instead of hundreds.
	const collected = collectNonEmptyLines(out, previewLimit());
	return renderTruncatedContent(
		collected.lines.join("\n"),
		GROUP_PREVIEW_NOMINAL_WIDTH,
		previewLimit(),
		theme,
		(l) => theme.fg("dim", l),
		{ expandHint: false },
	);
}

function renderGroupCall(toolCallId: string, theme: Theme, ctx: RenderContext): string | undefined {
	// Capture this tool's invalidate on EVERY render, before the group-existence
	// checks (AUDIT §5:493). A tool that currently renders standalone may become a
	// group leader when a later member joins; invalidateGroups() then needs its
	// invalidate to promote it. Recording only inside the "is a leader" branch
	// missed exactly this case — the leader had already settled standalone.
	registerGroupInvalidator(toolCallId, ctx.invalidate);
	if (isHiddenGroupMember(toolCallId)) return "";
	const info = getGroupRenderInfo(toolCallId, ctx.expanded);
	if (!info) return undefined;
	const palette = getPalette(theme);
	if (info.phase === "collapsed") {
		return renderCollapsedSummary(info, theme, palette, displayPathFor(ctx));
	}
	// Expanded (preview) phase: the leader's renderCall draws the WHOLE group —
	// glance lines plus each member's result preview. renderResult returns "" so
	// the group is not drawn a second time (pi runs renderCall AND renderResult
	// unconditionally, tool-execution.js:228-263; the old `() => ""` here plus a
	// real callback in renderResult drew every glance line twice — AUDIT §5:368).
	return renderGroupPreview(info, theme, palette, displayPathFor(ctx), (m) => groupMemberPreview(m, theme));
}

function renderGroupResult(toolCallId: string, theme: Theme, ctx: RenderContext): string | undefined {
	registerGroupInvalidator(toolCallId, ctx.invalidate);
	if (isHiddenGroupMember(toolCallId)) return "";
	if (!getGroupRenderInfo(toolCallId, ctx.expanded)) return undefined;
	// The whole group (collapsed summary or expanded preview) is rendered by
	// renderGroupCall; renderResult must add nothing or the group is doubled.
	return "";
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

export function registerBuiltins(pi: ExtensionAPI): void {
	const cwd = process.cwd();

	// --- read ---------------------------------------------------------------

	const readTool = createReadToolDefinition(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: readTool.description,
		// AUDIT §5:403 — forward the builtin's system-prompt contributions.
		// Without these the "Available tools" snippet and the read Guidelines
		// bullets vanish from the default system prompt when we override read.
		promptSnippet: readTool.promptSnippet,
		promptGuidelines: readTool.promptGuidelines,
		parameters: readTool.parameters,
		renderShell: "self",
		// 5th param ctx carries the session env + runtime cwd (bash.js:126
		// exposeSessionEnvironment); create with ctx.cwd so resume/foreign-cwd
		// sessions execute in the right directory. Forward the host's
		// settings-derived options too (AUDIT §5:465).
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { autoResizeImages } = hostToolSettings(ctx.cwd);
			return createReadToolDefinition(ctx.cwd, { autoResizeImages }).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupCall(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			const summary = shortPath(c.cwd, String(args?.path ?? ""));
			return makeText(c.lastComponent, toolHeader("Read", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Reading…")));
			// CC FileReadTool/UI.tsx:152-160 — red error text on failure.
			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error reading file")));
			}
			// Image results carry no text (CC: "[Image data detected and sent to Claude]").
			if (resultHasImage(result) && !resultText(result)) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "[Image data detected and sent to Claude]")));
			}
			const content = resultText(result);
			// pi appends a continuation notice when a user-supplied `limit` stopped
			// early with more file left (read.js:243):
			//   "\n\n[N more lines in file. Use offset=N to continue.]"
			// Strip it before counting/previewing — otherwise the blank line + notice
			// inflate "Read N lines" by 2 (AUDIT §5:440). details is unset on this
			// path, so the count falls through to countLines and picks up the trailer.
			const MORE_LINES_TRAILER = /\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/;
			const visibleContent = content.replace(MORE_LINES_TRAILER, "");
			const details = (result as { details?: { truncation?: { truncated?: boolean; totalLines?: number } } }).details;
			// CC FileReadTool/UI.tsx:131 — "Read N lines" (N bold). When pi
			// truncates it appends a "[N more lines…]" trailer to the text; the
			// real total lives in details.truncation.totalLines.
			const total =
				details?.truncation?.truncated && typeof details.truncation.totalLines === "number"
					? details.truncation.totalLines
					: countLines(visibleContent);
			const stat = `Read ${theme.bold(String(total))} ${total === 1 ? "line" : "lines"}`;
			let text = stat;
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (!expanded) return cachedText(c.lastComponent, withResultLead(theme, text));
			const lines = visibleContent.split("\n");
			return expandedStatBody(c, theme, `read\u0000${text}`, text, lines);
		},
	});

	// --- bash ---------------------------------------------------------------

	const bashTool = createBashToolDefinition(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: bashTool.description,
		promptSnippet: bashTool.promptSnippet, // AUDIT §5:403 — forward system-prompt contributions.
		promptGuidelines: bashTool.promptGuidelines,
		parameters: bashTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// AUDIT §5:465 — the host creates bash with {commandPrefix, shellPath};
			// rebuilding bare here silently dropped both.
			const { commandPrefix, shellPath } = hostToolSettings(ctx.cwd);
			return createBashToolDefinition(ctx.cwd, { commandPrefix, shellPath }).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupCall(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			const summary = truncateCommand(String(args?.command ?? ""));
			const header = toolHeader("Bash", summary, theme, statusDot(c, theme));
			return makeText(c.lastComponent, header + liveLineCountTrailing(c, theme));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			const output = resultText(result);

			// Live preview while streaming: CC ShellProgressMessage.tsx:44,83 keeps a
			// fixed 5-row TAIL window (`lines.slice(-5)` in a height-5 clipped Box) —
			// tailing is the point while output is still arriving. Only the completed
			// view flips to head-first.
			if (isPartial) {
				const collected = collectNonEmptyLines(output, STREAM_PREVIEW_ROWS);
				setLiveLineCount(c, collected.total);
				if (collected.total === 0) {
					return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Running…")));
				}
				// Budget the tail in VISUAL rows too: 5 logical lines of minified output
				// is still hundreds of rows. Built at render time — the row budget needs
				// the width.
				const key = `stream\u0000${collected.total}\u0000${collected.lines.join("\n")}`;
				return widthBudgetedBody(c.lastComponent, theme, key, (contentWidth) => {
					const tail = tailVisualRows(collected.lines, contentWidth, STREAM_PREVIEW_ROWS, (l) => theme.fg("dim", l));
					return `${theme.fg("dim", "Running…")}\n${tail}`;
				});
			}

			// Completed.
			const collected = collectNonEmptyLines(output);
			// AUDIT §5:499 — failure is signalled structurally: pi's bash tool
			// throws on exit≠0 (bash.js:348) so the harness sets isError. Only THEN
			// parse the code out of the appended "Command exited with code N" status
			// (last occurrence — the command's own output may contain the same
			// string). A successful command that merely prints "exit code: 5" must
			// not be painted as failed.
			const failed = c.isError;
			let exitCode: number | null = null;
			if (failed) {
				const exitMatches = [...output.matchAll(/Command exited with code (\d+)/g)];
				exitCode = exitMatches.length > 0 ? Number.parseInt(exitMatches[exitMatches.length - 1]![1]!, 10) : null;
			}

			// CC BashToolResultMessage.tsx:156 — status line only when stdout AND
			// stderr are both empty (or on failure); with output, just the output.
			// No output → dim "(No output)".
			if (collected.total === 0) {
				const status = failed
					? theme.fg("error", exitCode !== null ? `Exit ${exitCode}` : "Error")
					: theme.fg("dim", "(No output)");
				return cachedText(c.lastComponent, withResultLead(theme, status));
			}

			// Completed with output — CC OutputLine.tsx:73 → renderTruncatedContent:
			// head-first visual rows + `… +N lines (ctrl+o to expand)`. Expanded skips
			// truncation entirely (CC `shouldShowFull`, OutputLine.tsx:70).
			const status = failed ? theme.fg("error", exitCode !== null ? `Exit ${exitCode}` : "Error") : "";
			if (expanded) {
				// pi already caps bash stdout at 2000 lines / 50KB (truncate.js), but a
				// minified line still wraps to hundreds of rows, so the expanded view
				// keeps a generous ceiling instead of no ceiling at all.
				const key = `expanded\u0000${failed}\u0000${exitCode}\u0000${output}`;
				return widthBudgetedBody(c.lastComponent, theme, key, (contentWidth) => {
					const body = renderTruncatedContent(collected.lines.join("\n"), contentWidth, MAX_RENDER_LINES, theme, (l) => l, {
						expandHint: false,
					});
					return status ? `${status}\n${body}` : body;
				});
			}
			const key = `collapsed\u0000${failed}\u0000${exitCode}\u0000${previewLimit()}\u0000${output}`;
			return widthBudgetedBody(c.lastComponent, theme, key, (contentWidth) => {
				const body = renderTruncatedContent(collected.lines.join("\n"), contentWidth, previewLimit(), theme, (l) =>
					theme.fg("dim", l),
				);
				return status ? `${status}\n${body}` : body;
			});
		},
	});

	// --- grep (CC userFacingName: "Search") ----------------------------------

	const grepTool = createGrepToolDefinition(cwd);
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: grepTool.description,
		promptSnippet: grepTool.promptSnippet, // AUDIT §5:403 — forward system-prompt contributions.
		promptGuidelines: grepTool.promptGuidelines,
		parameters: grepTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createGrepToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupCall(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			// CC GrepTool/UI.tsx:135-138 — `pattern: "foo", path: "src"`, pattern untruncated.
			let summary = `pattern: "${String(args?.pattern ?? "")}"`;
			if (args?.path) summary += `, path: "${args.path}"`;
			return makeText(c.lastComponent, toolHeader("Search", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Searching…")));
			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error searching files")));
			}
			// AUDIT §5:571 — drop the `[N matches limit reached…]` trailer before
			// counting, or every at-limit stat is one file too high.
			const raw = stripNoticesTrailer(resultText(result));
			if (!raw || isEmptySentinel(raw)) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("muted", "no matches")));
			}
			const matches = raw.split("\n").filter((l) => l.trim().length > 0);
			// CC GrepTool/UI.tsx:186 — "Found N files" (N = unique files, bold).
			const files = countGrepFiles(matches);
			const stat = `Found ${theme.bold(String(files))} ${files === 1 ? "file" : "files"}`;
			if (!expanded) return cachedText(c.lastComponent, withResultLead(theme, stat));
			return expandedStatBody(c, theme, `grep\u0000${stat}`, stat, matches);
		},
	});

	// --- find ---------------------------------------------------------------

	const findTool = createFindToolDefinition(cwd);
	pi.registerTool({
		name: "find",
		label: "find",
		description: findTool.description,
		promptSnippet: findTool.promptSnippet, // AUDIT §5:403 — forward system-prompt contributions.
		promptGuidelines: findTool.promptGuidelines,
		parameters: findTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createFindToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupCall(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			let summary = `"${summarizeText(String(args?.pattern ?? ""), 40)}"`;
			if (args?.path) summary += ` in ${args.path}`;
			return makeText(c.lastComponent, toolHeader("Find", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Finding…")));
			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error finding files")));
			}
			// AUDIT §5:571/:611 — the `[N results limit reached…]` trailer is not a file.
			const raw = stripNoticesTrailer(resultText(result));
			if (!raw || isEmptySentinel(raw)) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("muted", "no files found")));
			}
			const items = raw.split("\n").filter((l) => l.trim().length > 0);
			const stat = `${theme.bold(String(items.length))} ${items.length === 1 ? "file" : "files"}`;
			if (!expanded) return cachedText(c.lastComponent, withResultLead(theme, stat));
			return expandedStatBody(c, theme, `find\u0000${stat}`, stat, items);
		},
	});

	// --- ls -----------------------------------------------------------------

	const lsTool = createLsToolDefinition(cwd);
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: lsTool.description,
		promptSnippet: lsTool.promptSnippet, // AUDIT §5:403 — forward system-prompt contributions.
		promptGuidelines: lsTool.promptGuidelines,
		parameters: lsTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createLsToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupCall(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			const summary = shortPath(c.cwd, String(args?.path ?? "."));
			return makeText(c.lastComponent, toolHeader("List", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Listing…")));
			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error listing directory")));
			}
			// AUDIT §5:571/:611 — the `[N entries limit reached…]` trailer is not an entry.
			const raw = stripNoticesTrailer(resultText(result));
			if (!raw || isEmptySentinel(raw)) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("muted", "empty directory")));
			}
			const items = raw.split("\n").filter((l) => l.trim().length > 0);
			const stat = `${theme.bold(String(items.length))} ${items.length === 1 ? "entry" : "entries"}`;
			if (!expanded) return cachedText(c.lastComponent, withResultLead(theme, stat));
			return expandedStatBody(c, theme, `ls\u0000${stat}`, stat, items);
		},
	});

	// --- edit / write: diff rendering ---------------------------------------

	/**
	 * Capture the old file content for write before execution so renderResult
	 * can diff even if renderCall was never called (resume, compaction).
	 *
	 * Lifetime: populated in execute, read across any number of re-renders
	 * (expand toggles re-run renderCall/renderResult AFTER tool_execution_end —
	 * verified against pi interactive-mode.js:2671-2678 + setExpanded →
	 * updateDisplay → renderResult — so we must NOT clear on tool_execution_end,
	 * or an existing file flips to "Create" + whole-file-added on the second
	 * render). Cleared per session; additionally bounded to MAX_WRITE_SNAPSHOTS
	 * entries (FIFO evict oldest) so a long session cannot grow unbounded.
	 * toolCallIds are unique per session, so no cross-session staleness.
	 */
	const writeOldContent = new Map<string, string>();
	const writeExistedBefore = new Map<string, boolean>();
	// toolCallIds whose old file exceeded MAX_DIFF_FILE_BYTES: skip the diff and
	// render "Wrote N lines" instead of reading the whole file into memory.
	const writeOversize = new Set<string>();
	/** Insert into a snapshot map, evicting the oldest key past the cap. */
	const boundSnapshots = (): void => {
		while (writeOldContent.size > MAX_WRITE_SNAPSHOTS) {
			const oldest = writeOldContent.keys().next().value;
			if (oldest === undefined) break;
			writeOldContent.delete(oldest);
			writeExistedBefore.delete(oldest);
			writeOversize.delete(oldest);
		}
	};
	pi.on("session_start", async () => {
		writeOldContent.clear();
		writeExistedBefore.clear();
		writeOversize.clear();
	});

	const writeTool = createWriteToolDefinition(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: writeTool.description,
		promptSnippet: writeTool.promptSnippet, // AUDIT §5:403 — forward system-prompt contributions.
		promptGuidelines: writeTool.promptGuidelines,
		parameters: writeTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const fp = String(params.path ?? "");
			const fullPath = fp ? resolve(ctx.cwd, fp) : "";
			const existedBefore = !!fullPath && existsSync(fullPath);
			writeExistedBefore.set(toolCallId, existedBefore);
			writeOversize.delete(toolCallId);
			if (existedBefore && fullPath) {
				try {
					// Probe size before reading: a huge old file would otherwise
					// sit resident three ways (map + build closure + del lines) and
					// feed parseDiff's superlinear intermediates (AUDIT §2 P0-3).
					if (statSync(fullPath).size > MAX_DIFF_FILE_BYTES) {
						writeOversize.add(toolCallId);
						writeOldContent.set(toolCallId, "");
					} else {
						writeOldContent.set(toolCallId, readFileSync(fullPath, "utf-8"));
					}
				} catch {
					writeOldContent.set(toolCallId, "");
				}
			} else {
				writeOldContent.set(toolCallId, "");
			}
			boundSnapshots();
			return createWriteToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupCall(c.toolCallId, theme, c);
			if (grouped !== undefined) return cachedText(c.lastComponent, grouped);
			// AUDIT §6 P1 — CC's transcript header verb is Create for a new file and
			// Update for an overwrite (not the tool's userFacingName "Write").
			// Signal source: the execute-time snapshot when we have it; before
			// execute (pending) probe existsSync once per path — the file has not
			// been written yet so the probe is the true pre-write state. After a
			// /resume the snapshot is gone and the file now exists either way, so
			// fall back to the neutral "Write" instead of guessing (AUDIT §5:712).
			const fp = String(args?.path ?? "");
			const known = writeExistedBefore.get(c.toolCallId);
			let verb: string;
			if (known !== undefined) {
				verb = known ? "Update" : "Create";
			} else if (c.isPartial) {
				if (c.state._wverbPath !== fp) {
					c.state._wverbPath = fp;
					try {
						c.state._wverb = fp && existsSync(resolve(c.cwd, fp)) ? "Update" : "Create";
					} catch {
						c.state._wverb = "Write";
					}
				}
				verb = String(c.state._wverb ?? "Write");
			} else {
				verb = "Write";
			}
			const summary = shortPath(c.cwd, fp);
			return makeText(c.lastComponent, toolHeader(verb, summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Writing…")));

			// Three states: true = overwrite (diff), false = new file (preview),
			// undefined = snapshot lost (resume/compaction) — degrade to the stat
			// line instead of mis-rendering history as a new file (AUDIT §5:712).
			const existedEntry = writeExistedBefore.get(c.toolCallId);
			const existed = existedEntry === true;
			const old = existed ? (writeOldContent.get(c.toolCallId) ?? "") : "";

			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error")));
			}

			const wargs = c.args as { path?: string; content?: string } | undefined;
			const fp = String(wargs?.path ?? "");
			const content = String(wargs?.content ?? "");

			if (existedEntry === undefined) {
				const lineCount = countLines(content);
				const head = `Wrote ${theme.bold(String(lineCount))} ${lineCount === 1 ? "line" : "lines"} to ${theme.bold(shortPath(c.cwd, fp))}`;
				return cachedText(c.lastComponent, withResultLead(theme, head));
			}

			// AUDIT §2 P0-3 — the old file was too big to snapshot; skip the diff
			// (parseDiff on a multi-MB file is the OOM path) and just report the
			// line count, matching CC's "Wrote N lines to <path>".
			if (writeOversize.has(c.toolCallId)) {
				const lineCount = countLines(content);
				const head = `Wrote ${theme.bold(String(lineCount))} ${lineCount === 1 ? "line" : "lines"} to ${theme.bold(shortPath(c.cwd, fp))}`;
				return cachedText(c.lastComponent, withResultLead(theme, head));
			}

			const palette = getPalette(theme);
			setDiffPalette(palette);
			const diff = parseDiff(old, content);
			const lang = diffLanguage(fp);
			const stat = renderDiffStatLine(diff.added, diff.removed);
			const key = `write:${c.toolCallId}:${old.length}:${content.length}:${expanded ? 1 : 0}`;

			// New file: CC FileWriteTool/UI.tsx:79-108 — `Wrote N lines to <path>`,
			// first 10 lines HighlightedCode, `… +N lines`, ctrl+o hint.
			if (!existed && !expanded) {
				const lineCount = countLines(content);
				const shown = (content.endsWith("\n") ? content.slice(0, -1) : content)
					.split("\n")
					.slice(0, WRITE_PREVIEW_LINES);
				const plusLines = lineCount - WRITE_PREVIEW_LINES;
				const hl = shikiHighlighter(shikiThemeForPalette(palette));
				let body = hl(shown.join("\n"), lang)?.join("\n") ?? shown.map((l) => theme.fg("dim", l || " ")).join("\n");
				if (plusLines > 0) {
					body += `\n${theme.fg("muted", `… +${plusLines} line${plusLines === 1 ? "" : "s"}`)}`;
				}
				body += `\n${italic(theme.fg("dim", "(ctrl+o to expand)"))}`;
				const head = `Wrote ${theme.bold(String(lineCount))} ${lineCount === 1 ? "line" : "lines"} to ${theme.bold(shortPath(c.cwd, fp))}`;
				// Warm shiki asynchronously; re-render with highlight when ready.
				// Only attach the .then(invalidate) if this component has not warmed
				// this key yet — otherwise c.invalidate() re-runs renderResult, which
				// re-attaches another .then, forming a microtask self-loop that freezes
				// the TUI (AUDIT §2 P0-2). `key` is not enough on its own because pi
				// re-runs renderResult on the same key (every frame); track "warmed"
				// in state so the guard survives re-renders.
				if (c.state._wwkDone !== key) {
					c.state._wwkDone = key;
					void warmHighlightCache(shown.join("\n"), lang, shikiThemeForPalette(palette)).then(() => {
						if (c.state._wwkDone !== key) return;
						c.invalidate();
					});
				}
				return cachedText(c.lastComponent, leadBody(theme, `${head}\n${body}`));
			}

			// Existing file (or expanded new file): diff card. CC puts stat and
			// diff body in one MessageResponse — body indents to column 5.
			// §5:942 — render with the palette the card passes in (the ACTIVE one),
			// not the closure capture: on theme change pi invalidates without
			// re-running renderResult, so a captured palette would go stale.
			const build = (width: number, pal: ResolvedPalette): string[] => {
				const lead = withResultLead(theme, stat || "Written");
				if (old === content) return [lead];
				const options = {
					maxLines: expanded ? MAX_RENDER_LINES : MAX_PREVIEW_LINES,
					language: lang,
					highlight: shikiHighlighter(),
				};
				const bodyWidth = Math.max(1, width - RESULT_INDENT.length);
				const body = shouldUseSplit(diff, bodyWidth)
					? renderSplit(pal, diff, bodyWidth, options)
					: renderUnified(pal, diff, bodyWidth, options);
				return [lead, ...body.map((l) => `${RESULT_INDENT}${l}`)];
			};
			const last = c.lastComponent as DiffCardComponent | undefined;
			if (last instanceof DiffCardComponent && last.diffKey === key) {
				last.setBuild(build);
				return last;
			}
			const card = new DiffCardComponent(build);
			card.diffKey = key;
			if (old !== content) {
				c.state._wdk = key;
				// Warm the exact per-side strings the diff renderer will query (both
				// layouts), not the whole-file content — the old
				// warmHighlightCache(content, …) warmed a string no renderer looks up,
				// so the cache always missed and the old side never warmed (AUDIT §5 diff.ts:646).
				void warmDiffHighlight(diff, { maxLines: expanded ? MAX_RENDER_LINES : MAX_PREVIEW_LINES, language: lang, theme: shikiThemeForPalette(palette) }).then(() => {
					if (c.state._wdk !== key) return;
					card.invalidate();
					c.invalidate();
				});
			}
			return card;
		},
	});

	const editTool = createEditToolDefinition(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: editTool.description,
		promptSnippet: editTool.promptSnippet, // AUDIT §5:403 — forward system-prompt contributions.
		promptGuidelines: editTool.promptGuidelines,
		parameters: editTool.parameters,
		// AUDIT §5:778 — forward pi's prepareArguments (edit.js prepareEditArguments).
		// It coerces edits sent as a JSON string (Opus 4.6 / GLM-5.1) into an array
		// and lifts legacy top-level oldText/newText into edits[]; without it those
		// shapes fail schema validation before execute ever runs.
		prepareArguments: editTool.prepareArguments,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createEditToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const fp = String(args?.path ?? "");
			// AUDIT §6 P1 — CC's edit header verb is Update (FileEditTool
			// userFacingName), never "Edit". Just the path, no edits-count suffix.
			const summary = shortPath(c.cwd, fp);
			return makeText(c.lastComponent, toolHeader("Update", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Editing…")));
			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error")));
			}

			const eargs = c.args as { path?: string; edits?: Array<{ oldText: string; newText: string }> } | undefined;
			const fp = String(eargs?.path ?? "");
			const edits = eargs?.edits ?? [];
			const palette = getPalette(theme);
			setDiffPalette(palette);
			// AUDIT §5:817 — prefer pi's real unified patch (result.details.patch,
			// generateUnifiedPatch against the actual file): true line numbers and
			// real context. The edits[]-concatenation is only the fallback for
			// history entries that predate details.
			const details = (result as { details?: { patch?: string } }).details;
			const patchDiff = typeof details?.patch === "string" ? parsePatchToDiff(details.patch) : null;
			const oldCombined = edits.map((e) => e.oldText).join("\n");
			const newCombined = edits.map((e) => e.newText).join("\n");
			const diff = patchDiff ?? parseDiff(oldCombined, newCombined);
			const lang = diffLanguage(fp);
			const stat = renderDiffStatLine(diff.added, diff.removed);
			const key = `edit:${c.toolCallId}:${fp}:${patchDiff ? `p${details!.patch!.length}` : `e${edits.length}:${oldCombined.length}:${newCombined.length}`}:${expanded ? 1 : 0}`;

			// CC FileEditToolUpdatedMessage: stat + StructuredDiffList in one
			// MessageResponse — body indents to column 5.
			// §5:942 — use the card-supplied active palette, not the closure capture
			// (same rationale as the write card above).
			const build = (width: number, pal: ResolvedPalette): string[] => {
				const lead = withResultLead(theme, stat || "Applied");
				if (diff.lines.length === 0) return [lead];
				const options = {
					maxLines: expanded ? MAX_RENDER_LINES : MAX_PREVIEW_LINES,
					language: lang,
					highlight: shikiHighlighter(),
				};
				const bodyWidth = Math.max(1, width - RESULT_INDENT.length);
				const body = shouldUseSplit(diff, bodyWidth)
					? renderSplit(pal, diff, bodyWidth, options)
					: renderUnified(pal, diff, bodyWidth, options);
				return [lead, ...body.map((l) => `${RESULT_INDENT}${l}`)];
			};
			const last = c.lastComponent as DiffCardComponent | undefined;
			if (last instanceof DiffCardComponent && last.diffKey === key) {
				last.setBuild(build);
				return last;
			}
			const card = new DiffCardComponent(build);
			card.diffKey = key;
			if (diff.lines.length > 0) {
				c.state._edk = key;
				// Warm the per-side strings the renderer queries (AUDIT §5 diff.ts:646);
				// the old warmHighlightCache(newCombined, …) warmed only the joined new
				// side under a string no renderer ever looks up.
				void warmDiffHighlight(diff, { maxLines: expanded ? MAX_RENDER_LINES : MAX_PREVIEW_LINES, language: lang, theme: shikiThemeForPalette(palette) }).then(() => {
					if (c.state._edk !== key) return;
					card.invalidate();
					c.invalidate();
				});
			}
			return card;
		},
	});
}
