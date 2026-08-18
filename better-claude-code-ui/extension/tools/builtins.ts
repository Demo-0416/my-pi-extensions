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
import { sliceByColumn, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
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

/** CC BashTool/UI.tsx:104-127 — truncate to 2 lines, then 160 chars, append … */
function truncateCommand(command: string): string {
	const lines = command.split("\n");
	const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES;
	const needsCharTruncation = command.length > MAX_COMMAND_DISPLAY_CHARS;
	if (!needsLineTruncation && !needsCharTruncation) return command;
	let truncated = command;
	if (needsLineTruncation) {
		truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join("\n");
	}
	if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) {
		truncated = truncated.slice(0, MAX_COMMAND_DISPLAY_CHARS);
	}
	return `${truncated.trim()}…`;
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

/** CC countLines (FileWriteTool/UI.tsx:35-38): a trailing EOL terminates the
 *  last line, it does not start a new one. */
function countLines(text: string): number {
	if (text === "") return 0;
	return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

/** CC GrepTool files_with_matches: N = unique files. pi emits one line per
 *  match as `path:lineno: text`, so dedupe by the path prefix. */
function countGrepFiles(lines: string[]): number {
	const files = new Set<string>();
	for (const line of lines) {
		const colon = line.indexOf(":");
		files.add(colon > 0 ? line.slice(0, colon) : line);
	}
	return files.size;
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
	const pad = " ".repeat(indent);
	const contentWidth = Math.max(1, width - indent);
	for (const logical of text.split("\n")) {
		if (visibleWidth(logical) <= width) {
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
	return out;
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
// Preview text builder
// ---------------------------------------------------------------------------

function buildPreviewText(
	lines: string[],
	theme: Theme,
	limit: number,
	total: number,
	styleLine: (line: string) => string,
): string {
	const shown = lines.slice(0, limit);
	const remaining = total - shown.length;
	let text = shown.map((l) => styleLine(l || " ")).join("\n");
	if (remaining > 0) {
		text += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
	}
	return text;
}

/** Tail preview with `... (N earlier lines)` prefix (old ext live preview). */
function buildTailPreview(
	lines: string[],
	total: number,
	theme: Theme,
	limit: number,
	styleLine: (line: string) => string,
): string {
	const tail = lines.length > limit ? lines.slice(-limit) : lines;
	const earlier = total - tail.length;
	let text = tail.map((l) => styleLine(l || " ")).join("\n");
	if (earlier > 0) {
		text = `${theme.fg("muted", `... (${earlier} earlier lines)`)}\n${text}`;
	}
	return text;
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

/** The per-member result line for an expanded group's glance preview. */
function groupMemberPreview(m: { status: string; result: unknown }, theme: Theme): string {
	if (m.status === "pending") return theme.fg("dim", "…");
	const out = resultText(m.result);
	if (!out) return "";
	const collected = collectNonEmptyLines(out, previewLimit());
	return buildPreviewText(collected.lines, theme, previewLimit(), collected.total, (l) => theme.fg("dim", l));
}

function renderGroupCall(toolCallId: string, theme: Theme, ctx: RenderContext): string | undefined {
	if (isHiddenGroupMember(toolCallId)) return "";
	const info = getGroupRenderInfo(toolCallId, ctx.expanded);
	if (!info) return undefined;
	registerGroupInvalidator(toolCallId, ctx.invalidate);
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
	if (isHiddenGroupMember(toolCallId)) return "";
	const info = getGroupRenderInfo(toolCallId, ctx.expanded);
	if (!info) return undefined;
	registerGroupInvalidator(toolCallId, ctx.invalidate);
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
		// sessions execute in the right directory.
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createReadToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupCall(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			const summary = shortPath(c.cwd, String(args?.path ?? ""));
			return makeText(c.lastComponent, toolHeader("Read", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Reading...")));
			// CC FileReadTool/UI.tsx:152-160 — red error text on failure.
			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error reading file")));
			}
			// Image results carry no text (CC: "[Image data detected and sent to Claude]").
			if (resultHasImage(result) && !resultText(result)) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "[Image data detected and sent to Claude]")));
			}
			const content = resultText(result);
			const details = (result as { details?: { truncation?: { truncated?: boolean; totalLines?: number } } }).details;
			// CC FileReadTool/UI.tsx:131 — "Read N lines" (N bold). When pi
			// truncates it appends a "[N more lines…]" trailer to the text; the
			// real total lives in details.truncation.totalLines.
			const total =
				details?.truncation?.truncated && typeof details.truncation.totalLines === "number"
					? details.truncation.totalLines
					: countLines(content);
			const stat = `Read ${theme.bold(String(total))} ${total === 1 ? "line" : "lines"}`;
			let text = stat;
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (!expanded) return cachedText(c.lastComponent, withResultLead(theme, text));
			const body = content.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/, "");
			const lines = body.split("\n");
			const preview = buildPreviewText(lines, theme, previewLimit(), lines.length, (l) => theme.fg("dim", l));
			return cachedText(c.lastComponent, `${withResultLead(theme, text)}\n${indentResultBody(preview)}`);
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
			return createBashToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupCall(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			const summary = truncateCommand(String(args?.command ?? ""));
			const header = toolHeader("Bash", summary, theme, statusDot(c, theme));
			return makeText(c.lastComponent, header + liveLineCountTrailing(c, theme));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			const output = resultText(result);

			// Live preview while streaming: tail N lines + earlier-lines prefix.
			if (isPartial) {
				const collected = collectNonEmptyLines(output, previewLimit());
				setLiveLineCount(c, collected.total);
				if (collected.total === 0) {
					return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Running...")));
				}
				const body = buildTailPreview(collected.lines, collected.total, theme, previewLimit(), (l) =>
					theme.fg("dim", l),
				);
				return cachedText(c.lastComponent, `${withResultLead(theme, theme.fg("dim", "Running..."))}\n${indentResultBody(body)}`);
			}

			// Completed.
			const collected = collectNonEmptyLines(output);
			// pi's bash tool throws on exit≠0 with "Command exited with code N";
			// the error message becomes the result text. Match the LAST occurrence
			// — command output may contain the same string (bash.js:321,348).
			const exitMatches = [...output.matchAll(/(?:Command exited with code |exit code: )(\d+)/g)];
			const exitCode = exitMatches.length > 0 ? Number.parseInt(exitMatches[exitMatches.length - 1]![1]!, 10) : null;
			const failed = c.isError || (exitCode !== null && exitCode !== 0);

			// CC BashToolResultMessage.tsx:156 — status line only when stdout AND
			// stderr are both empty (or on failure); with output, just the output.
			// No output → dim "(No output)".
			if (collected.total === 0) {
				const status = failed
					? theme.fg("error", exitCode !== null ? `Exit ${exitCode}` : "Error")
					: theme.fg("dim", "(No output)");
				return cachedText(c.lastComponent, withResultLead(theme, status));
			}
			if (failed) {
				const status = theme.fg("error", exitCode !== null ? `Exit ${exitCode}` : "Error");
				const body = buildTailPreview(collected.lines, collected.total, theme, previewLimit(), (l) =>
					theme.fg("dim", l),
				);
				return cachedText(c.lastComponent, `${withResultLead(theme, status)}\n${indentResultBody(body)}`);
			}

			// Success with output: no status line, output only.
			if (!expanded) {
				const body = buildTailPreview(collected.lines, collected.total, theme, previewLimit(), (l) =>
					theme.fg("dim", l),
				);
				return cachedText(c.lastComponent, leadBody(theme, body));
			}

			// Expanded: full output. pi merges stdout+stderr into one stream, so
			// we render in default color (CC's red-stderr separation is not
			// achievable with the merged pi output).
			const body = buildPreviewText(collected.lines, theme, previewLimit(), collected.total, (l) => l);
			return cachedText(c.lastComponent, leadBody(theme, body));
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
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			// CC GrepTool/UI.tsx:135-138 — `pattern: "foo", path: "src"`, pattern untruncated.
			let summary = `pattern: "${String(args?.pattern ?? "")}"`;
			if (args?.path) summary += `, path: "${args.path}"`;
			return makeText(c.lastComponent, toolHeader("Search", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Searching...")));
			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error searching files")));
			}
			const raw = resultText(result);
			if (!raw || isEmptySentinel(raw)) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("muted", "no matches")));
			}
			const matches = raw.split("\n").filter((l) => l.trim().length > 0);
			// CC GrepTool/UI.tsx:186 — "Found N files" (N = unique files, bold).
			const files = countGrepFiles(matches);
			const stat = `Found ${theme.bold(String(files))} ${files === 1 ? "file" : "files"}`;
			if (!expanded) return cachedText(c.lastComponent, withResultLead(theme, stat));
			const body = buildPreviewText(matches, theme, previewLimit(), matches.length, (l) => theme.fg("dim", l));
			return cachedText(c.lastComponent, `${withResultLead(theme, stat)}\n${indentResultBody(body)}`);
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
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			let summary = `"${summarizeText(String(args?.pattern ?? ""), 40)}"`;
			if (args?.path) summary += ` in ${args.path}`;
			return makeText(c.lastComponent, toolHeader("Find", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Finding...")));
			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error finding files")));
			}
			const raw = resultText(result);
			if (!raw || isEmptySentinel(raw)) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("muted", "no files found")));
			}
			const items = raw.split("\n").filter((l) => l.trim().length > 0);
			const stat = `${theme.bold(String(items.length))} ${items.length === 1 ? "file" : "files"}`;
			if (!expanded) return cachedText(c.lastComponent, withResultLead(theme, stat));
			const body = buildPreviewText(items, theme, previewLimit(), items.length, (l) => theme.fg("dim", l));
			return cachedText(c.lastComponent, `${withResultLead(theme, stat)}\n${indentResultBody(body)}`);
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
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			const summary = shortPath(c.cwd, String(args?.path ?? "."));
			return makeText(c.lastComponent, toolHeader("List", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Listing...")));
			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error listing directory")));
			}
			const raw = resultText(result);
			if (!raw || isEmptySentinel(raw)) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("muted", "empty directory")));
			}
			const items = raw.split("\n").filter((l) => l.trim().length > 0);
			const stat = `${theme.bold(String(items.length))} ${items.length === 1 ? "entry" : "entries"}`;
			if (!expanded) return cachedText(c.lastComponent, withResultLead(theme, stat));
			const body = buildPreviewText(items, theme, previewLimit(), items.length, (l) => theme.fg("dim", l));
			return cachedText(c.lastComponent, `${withResultLead(theme, stat)}\n${indentResultBody(body)}`);
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
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			// CC FileWriteTool/UI.tsx:128-136 — userFacingName is always "Write".
			const summary = shortPath(c.cwd, String(args?.path ?? ""));
			return makeText(c.lastComponent, toolHeader("Write", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Writing...")));

			const existed = writeExistedBefore.get(c.toolCallId) ?? false;
			const old = existed ? (writeOldContent.get(c.toolCallId) ?? "") : "";

			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error")));
			}

			const wargs = c.args as { path?: string; content?: string } | undefined;
			const fp = String(wargs?.path ?? "");
			const content = String(wargs?.content ?? "");

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
				return cachedText(c.lastComponent, `${withResultLead(theme, head)}\n${indentResultBody(body)}`);
			}

			// Existing file (or expanded new file): diff card. CC puts stat and
			// diff body in one MessageResponse — body indents to column 5.
			const build = (width: number): string[] => {
				const lead = withResultLead(theme, stat || "Written");
				if (old === content) return [lead];
				const options = {
					maxLines: expanded ? MAX_RENDER_LINES : MAX_PREVIEW_LINES,
					language: lang,
					highlight: shikiHighlighter(),
				};
				const bodyWidth = Math.max(1, width - RESULT_INDENT.length);
				const body = shouldUseSplit(diff, bodyWidth)
					? renderSplit(palette, diff, bodyWidth, options)
					: renderUnified(palette, diff, bodyWidth, options);
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
			// CC FileEditTool/UI.tsx:57-74 — just the path, no edits-count suffix.
			const summary = shortPath(c.cwd, fp);
			return makeText(c.lastComponent, toolHeader("Edit", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			if (isPartial) return cachedText(c.lastComponent, withResultLead(theme, theme.fg("dim", "Editing...")));
			if (c.isError) {
				return cachedText(c.lastComponent, withResultLead(theme, theme.fg("error", resultText(result) || "Error")));
			}

			const eargs = c.args as { path?: string; edits?: Array<{ oldText: string; newText: string }> } | undefined;
			const fp = String(eargs?.path ?? "");
			const edits = eargs?.edits ?? [];
			const palette = getPalette(theme);
			setDiffPalette(palette);
			const oldCombined = edits.map((e) => e.oldText).join("\n");
			const newCombined = edits.map((e) => e.newText).join("\n");
			const diff = parseDiff(oldCombined, newCombined);
			const lang = diffLanguage(fp);
			const stat = renderDiffStatLine(diff.added, diff.removed);
			const key = `edit:${c.toolCallId}:${fp}:${edits.length}:${oldCombined.length}:${newCombined.length}:${expanded ? 1 : 0}`;

			// CC FileEditToolUpdatedMessage: stat + StructuredDiffList in one
			// MessageResponse — body indents to column 5.
			const build = (width: number): string[] => {
				const lead = withResultLead(theme, stat || "Applied");
				if (edits.length === 0) return [lead];
				const options = {
					maxLines: expanded ? MAX_RENDER_LINES : MAX_PREVIEW_LINES,
					language: lang,
					highlight: shikiHighlighter(),
				};
				const bodyWidth = Math.max(1, width - RESULT_INDENT.length);
				const body = shouldUseSplit(diff, bodyWidth)
					? renderSplit(palette, diff, bodyWidth, options)
					: renderUnified(palette, diff, bodyWidth, options);
				return [lead, ...body.map((l) => `${RESULT_INDENT}${l}`)];
			};
			const last = c.lastComponent as DiffCardComponent | undefined;
			if (last instanceof DiffCardComponent && last.diffKey === key) {
				last.setBuild(build);
				return last;
			}
			const card = new DiffCardComponent(build);
			card.diffKey = key;
			if (edits.length > 0) {
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
