/**
 * Builtin tool rendering (read/bash/grep/find/ls/edit/write) — ported from
 * pi-claude-code-ui/extensions/index.ts, rewritten clean: execute delegates to
 * pi's builtin tool factories; renderCall/renderResult produce CC-style rows,
 * group-aware (non-leader group members render zero lines via self-shell).
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import {
	diffSummaryWithMeta,
	parseDiff,
	renderUnified,
	shouldUseSplit,
	renderSplit,
	MAX_RENDER_LINES,
	MAX_PREVIEW_LINES,
	diffLanguage,
	shikiHighlighter,
	warmHighlightCache,
	setDiffPalette,
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
import { fg, resolvePalette, rgbToHex, type ResolvedPalette } from "../palette.js";

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

const PREVIEW_LINES = 8;
const EXTRA_DETAIL_LINES = 4000;

let extraDetail = false;
export function setExtraDetail(v: boolean): void {
	extraDetail = v;
}

function previewLimit(): number {
	return extraDetail ? EXTRA_DETAIL_LINES : PREVIEW_LINES;
}

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

function summarizeText(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function statusDot(ctx: RenderContext, theme: Theme): string {
	if (ctx.isError) return theme.fg("error", "●");
	if (ctx.isPartial) {
		if (ctx.executionStarted) {
			armBlink();
			return currentBlinkPhase() ? theme.fg("warning", "●") : " ";
		}
		return theme.fg("dim", "●");
	}
	return theme.fg("success", "●");
}

function toolHeader(tool: string, summary: string, theme: Theme, dot: string): string {
	const label = theme.fg("toolTitle", theme.bold(tool));
	const body = summary ? `${label} ${theme.fg("accent", summary)}` : label;
	return `${dot} ${body}`;
}

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

function getPalette(theme: Theme): ResolvedPalette {
	return resolvePalette(theme.name, (token) => {
		try {
			return theme.fg(token as never, "x");
		} catch {
			return undefined;
		}
	});
}

function displayPathFor(ctx: RenderContext): (p: string) => string {
	return (p: string) => shortPath(ctx.cwd, p);
}

/** Render the group-aware call slot. Returns undefined for standalone tools. */
function renderGroupCall(
	toolCallId: string,
	theme: Theme,
	ctx: RenderContext,
): string | undefined {
	if (isHiddenGroupMember(toolCallId)) return "";
	const info = getGroupRenderInfo(toolCallId, ctx.expanded);
	if (!info) return undefined;
	registerGroupInvalidator(toolCallId, ctx.invalidate);
	const palette = getPalette(theme);
	if (info.phase === "collapsed") {
		return renderCollapsedSummary(info, theme, palette, displayPathFor(ctx));
	}
	return renderGroupPreview(info, theme, palette, displayPathFor(ctx), () => "");
}

function renderGroupResult(
	toolCallId: string,
	theme: Theme,
	ctx: RenderContext,
): string | undefined {
	if (isHiddenGroupMember(toolCallId)) return "";
	const info = getGroupRenderInfo(toolCallId, ctx.expanded);
	if (!info) return undefined;
	registerGroupInvalidator(toolCallId, ctx.invalidate);
	if (info.phase === "collapsed") return "";
	const palette = getPalette(theme);
	return renderGroupPreview(
		info,
		theme,
		palette,
		displayPathFor(ctx),
		(m) => {
			if (m.status === "pending") return theme.fg("dim", "…");
			const out = resultText(m.result);
			if (!out) return "";
			const collected = collectNonEmptyLines(out, previewLimit());
			return buildPreviewText(collected.lines, theme, previewLimit(), collected.total, (l) => theme.fg("dim", l));
		},
	);
}

function resultText(result: unknown): string {
	const r = result as { content?: Array<{ type: string; text?: string }> } | undefined;
	if (!r || !Array.isArray(r.content)) return "";
	return r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

export function registerBuiltins(pi: ExtensionAPI): void {
	const cwd = process.cwd();

	const readTool = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: readTool.description,
		parameters: readTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return readTool.execute(toolCallId, params, signal, onUpdate);
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
			if (isPartial) return makeText(c.lastComponent, theme.fg("dim", "Reading..."));
			const content = resultText(result);
			const lines = content.split("\n");
			let text = theme.fg("muted", `${lines.length} lines loaded`);
			const details = (result as { details?: { truncation?: { truncated?: boolean } } }).details;
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (!expanded) return makeText(c.lastComponent, text);
			text += `\n${buildPreviewText(lines, theme, previewLimit(), lines.length, (l) => theme.fg("dim", l))}`;
			return makeText(c.lastComponent, text);
		},
	});

	const bashTool = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: bashTool.description,
		parameters: bashTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupCall(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			const summary = summarizeText(String(args?.command ?? ""), 72);
			return makeText(c.lastComponent, toolHeader("Bash", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			const output = resultText(result);
			if (isPartial) {
				const collected = collectNonEmptyLines(output, previewLimit());
				if (collected.total === 0) return makeText(c.lastComponent, theme.fg("dim", "Running..."));
				return makeText(
					c.lastComponent,
					buildPreviewText(collected.lines, theme, previewLimit(), collected.total, (l) => theme.fg("dim", l)),
				);
			}
			const collected = collectNonEmptyLines(output);
			const exitMatch = output.match(/exit code: (\d+)/);
			const exitCode = exitMatch ? Number.parseInt(exitMatch[1]!, 10) : null;
			let text =
				exitCode === null || exitCode === 0 ? theme.fg("success", "Done") : theme.fg("error", `Exit ${exitCode}`);
			text += theme.fg("muted", ` (${collected.total} lines)`);
			if (!expanded || collected.total === 0) return makeText(c.lastComponent, text);
			text += `\n${buildPreviewText(collected.lines, theme, previewLimit(), collected.total, (l) => theme.fg("dim", l))}`;
			return makeText(c.lastComponent, text);
		},
	});

	const grepTool = createGrepTool(cwd);
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: grepTool.description,
		parameters: grepTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return grepTool.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupCall(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			let summary = `"${summarizeText(String(args?.pattern ?? ""), 40)}"`;
			if (args?.path) summary += ` in ${args.path}`;
			return makeText(c.lastComponent, toolHeader("Grep", summary, theme, statusDot(c, theme)));
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const grouped = renderGroupResult(c.toolCallId, theme, c);
			if (grouped !== undefined) return makeText(c.lastComponent, grouped);
			if (isPartial) return makeText(c.lastComponent, theme.fg("dim", "Searching..."));
			const matches = resultText(result).split("\n").filter((l) => l.trim().length > 0);
			if (matches.length === 0) return makeText(c.lastComponent, theme.fg("muted", "no matches"));
			let text = theme.fg("muted", `${matches.length} matches`);
			if (!expanded) return makeText(c.lastComponent, text);
			text += `\n${buildPreviewText(matches, theme, previewLimit(), matches.length, (l) => theme.fg("dim", l))}`;
			return makeText(c.lastComponent, text);
		},
	});

	const findTool = createFindTool(cwd);
	pi.registerTool({
		name: "find",
		label: "find",
		description: findTool.description,
		parameters: findTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return findTool.execute(toolCallId, params, signal, onUpdate);
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
			if (isPartial) return makeText(c.lastComponent, theme.fg("dim", "Finding..."));
			const items = resultText(result).split("\n").filter((l) => l.trim().length > 0);
			if (items.length === 0) return makeText(c.lastComponent, theme.fg("muted", "no files found"));
			let text = theme.fg("muted", `${items.length} files`);
			if (!expanded) return makeText(c.lastComponent, text);
			text += `\n${buildPreviewText(items, theme, previewLimit(), items.length, (l) => theme.fg("dim", l))}`;
			return makeText(c.lastComponent, text);
		},
	});

	const lsTool = createLsTool(cwd);
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: lsTool.description,
		parameters: lsTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return lsTool.execute(toolCallId, params, signal, onUpdate);
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
			if (isPartial) return makeText(c.lastComponent, theme.fg("dim", "Listing..."));
			const items = resultText(result).split("\n").filter((l) => l.trim().length > 0);
			if (items.length === 0) return makeText(c.lastComponent, theme.fg("muted", "empty directory"));
			let text = theme.fg("muted", `${items.length} entries`);
			if (!expanded) return makeText(c.lastComponent, text);
			text += `\n${buildPreviewText(items, theme, previewLimit(), items.length, (l) => theme.fg("dim", l))}`;
			return makeText(c.lastComponent, text);
		},
	});

	// --- edit / write: diff rendering ---------------------------------------

	const writeExistedBefore = new Map<string, boolean>();

	const writeTool = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: writeTool.description,
		parameters: writeTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			const fp = String(params.path ?? "");
			const fullPath = fp ? resolve(cwd, fp) : "";
			const existedBefore = !!fullPath && existsSync(fullPath);
			writeExistedBefore.set(toolCallId, existedBefore);
			return writeTool.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const fp = String(args?.path ?? "");
			const wasNew = c.toolCallId ? !writeExistedBefore.get(c.toolCallId) : true;
			const label = wasNew ? "Create" : "Write";
			const summary = shortPath(c.cwd, fp);
			const hdr = toolHeader(label, summary, theme, statusDot(c, theme));
			// Diff preview (before execution): old vs new content.
			const content = String(args?.content ?? "");
			let old = "";
			try {
				const fullPath = resolve(c.cwd, fp);
				if (existsSync(fullPath)) old = readFileSync(fullPath, "utf-8");
			} catch {
				old = "";
			}
			if (old === content) return makeText(c.lastComponent, hdr);
			const palette = getPalette(theme);
			setDiffPalette(palette);
			const diff = parseDiff(old, content);
			const width = 100;
			const richSummary = diffSummaryWithMeta(palette, diff.added, diff.removed, 0, "");
			const lang = diffLanguage(fp);
			const key = `write:${fp}:${c.expanded ? 1 : 0}`;
			if (c.state._wdk !== key) {
				c.state._wdk = key;
				c.state._wdt = `${richSummary}\n${theme.fg("muted", "rendering diff…")}`;
				void warmHighlightCache(content, lang).then(() => {
					if (c.state._wdk !== key) return;
					const rendered = shouldUseSplit(diff, width)
						? renderSplit(palette, diff, width, { maxLines: MAX_PREVIEW_LINES, language: lang, highlight: shikiHighlighter() })
						: renderUnified(palette, diff, width, { maxLines: c.expanded ? MAX_RENDER_LINES : MAX_PREVIEW_LINES, language: lang, highlight: shikiHighlighter() });
					c.state._wdt = `${richSummary}\n${rendered.join("\n")}`;
					c.invalidate();
				});
			}
			return makeText(c.lastComponent, `${hdr}\n${(c.state._wdt as string) ?? richSummary}`);
		},
		renderResult(result, { isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			if (isPartial) return makeText(c.lastComponent, theme.fg("dim", "Writing..."));
			if (c.isError) return makeText(c.lastComponent, theme.fg("error", resultText(result) || "Error"));
			writeExistedBefore.delete(c.toolCallId);
			return makeText(c.lastComponent, theme.fg("success", "Written"));
		},
	});

	const editTool = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: editTool.description,
		parameters: editTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return editTool.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			const fp = String(args?.path ?? "");
			const edits = (args?.edits ?? []) as Array<{ oldText: string; newText: string }>;
			const summary =
				edits.length > 1 ? `${shortPath(c.cwd, fp)} ${theme.fg("muted", `(${edits.length} edits)`)}` : shortPath(c.cwd, fp);
			const hdr = toolHeader("Edit", summary, theme, statusDot(c, theme));
			if (edits.length === 0) return makeText(c.lastComponent, hdr);
			// Combined diff from all edits.
			const palette = getPalette(theme);
			setDiffPalette(palette);
			const oldCombined = edits.map((e) => e.oldText).join("\n");
			const newCombined = edits.map((e) => e.newText).join("\n");
			const diff = parseDiff(oldCombined, newCombined);
			const width = 100;
			const richSummary = diffSummaryWithMeta(palette, diff.added, diff.removed, 0, "");
			const lang = diffLanguage(fp);
			const key = `edit:${fp}:${edits.length}:${c.expanded ? 1 : 0}`;
			if (c.state._edk !== key) {
				c.state._edk = key;
				c.state._edt = `${richSummary}\n${theme.fg("muted", "rendering diff…")}`;
				void warmHighlightCache(newCombined, lang).then(() => {
					if (c.state._edk !== key) return;
					const rendered = shouldUseSplit(diff, width)
						? renderSplit(palette, diff, width, { maxLines: MAX_PREVIEW_LINES, language: lang, highlight: shikiHighlighter() })
						: renderUnified(palette, diff, width, { maxLines: c.expanded ? MAX_RENDER_LINES : MAX_PREVIEW_LINES, language: lang, highlight: shikiHighlighter() });
					c.state._edt = `${richSummary}\n${rendered.join("\n")}`;
					c.invalidate();
				});
			}
			return makeText(c.lastComponent, `${hdr}\n${(c.state._edt as string) ?? richSummary}`);
		},
		renderResult(result, { isPartial }, theme, ctx) {
			const c = ctx as unknown as RenderContext;
			if (isPartial) return makeText(c.lastComponent, theme.fg("dim", "Editing..."));
			if (c.isError) return makeText(c.lastComponent, theme.fg("error", resultText(result) || "Error"));
			return makeText(c.lastComponent, theme.fg("success", "Applied"));
		},
	});
}

export { getPalette, setDiffPalette };
