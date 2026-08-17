/**
 * CC inline diff renderer — ported from dsh-tui/src/render/diff.ts, which itself
 * was ported from pi-claude-code-ui. structuredPatch-based parse, word-level
 * intra-line highlighting, unified + side-by-side layouts.
 *
 * Departure from the dsh-tui source: colors come from the active CC palette
 * (palette.ts) instead of fixed BRAND_COLORS, so the diff follows the active
 * theme (dark/light/daltonized/ansi).
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { diffWords, structuredPatch } from "diff";
import {
	bgAnsi,
	fgAnsi,
	rgbToHex,
	resolvePalette,
	BG_DEFAULT,
	RESET,
	type ColorValue,
	type ResolvedPalette,
} from "../palette.js";

export const SPLIT_MIN_WIDTH = 150;
const SPLIT_MIN_CODE_WIDTH = 60;
const SPLIT_MAX_WRAP_RATIO = 0.2;
const SPLIT_MAX_WRAP_LINES = 8;
export const MAX_PREVIEW_LINES = 60;
export const MAX_RENDER_LINES = 150;
const MAX_HL_CHARS = 32_000;
const CACHE_LIMIT = 48;
const WORD_DIFF_MIN_SIM = 0.15;
const MAX_WRAP_ROWS_WIDE = 3;
const MAX_WRAP_ROWS_MED = 2;
const MAX_WRAP_ROWS_NARROW = 1;

const D_RST = RESET;
const D_BOLD = "\x1b[1m";
const D_DIM = "\x1b[2m";

/** SGR bundle for one palette, built per render. */
interface DiffSgr {
	BG_ADD: string;
	BG_DEL: string;
	BG_ADD_W: string;
	BG_DEL_W: string;
	BG_BASE: string;
	FG_ADD: string;
	FG_DEL: string;
	FG_DIM: string;
	FG_LNUM: string;
	FG_RULE: string;
	FG_STRIPE: string;
	FG_SAFE_MUTED: string;
	DIVIDER: string;
}

function diffSgr(p: ResolvedPalette): DiffSgr {
	const BG_ADD = bgAnsi(p.cc.diffAddedBg);
	const BG_DEL = bgAnsi(p.cc.diffRemovedBg);
	const FG_ADD = fgAnsi(rgbToHex(p.chrome.diffAddedFg));
	const FG_DEL = fgAnsi(rgbToHex(p.chrome.diffRemovedFg));
	const FG_DIM = fgAnsi(rgbToHex(p.chrome.diffDim));
	const FG_RULE = fgAnsi(rgbToHex(p.chrome.diffRule));
	return {
		BG_ADD,
		BG_DEL,
		BG_ADD_W: bgAnsi(p.cc.diffAddedWord),
		BG_DEL_W: bgAnsi(p.cc.diffRemovedWord),
		BG_BASE: BG_DEFAULT,
		FG_ADD,
		FG_DEL,
		FG_DIM,
		FG_LNUM: fgAnsi(rgbToHex(p.chrome.diffLineNumber)),
		FG_RULE,
		FG_STRIPE: fgAnsi(rgbToHex(p.chrome.diffStripe)),
		FG_SAFE_MUTED: fgAnsi(rgbToHex(p.chrome.diffSafeMuted)),
		DIVIDER: `${FG_RULE}│${D_RST}`,
	};
}

export interface DiffLine {
	type: "add" | "del" | "ctx" | "sep";
	oldNum: number | null;
	newNum: number | null;
	content: string;
}

export interface ParsedDiff {
	lines: DiffLine[];
	added: number;
	removed: number;
	chars: number;
}

export type DiffHighlighter = (code: string, language: string | undefined) => readonly string[] | undefined;

export interface DiffRenderOptions {
	maxLines?: number;
	language?: string;
	highlight?: DiffHighlighter;
	toggleHint?: string;
}

function diffStrip(value: string): string {
	return value.replaceAll(/\x1b\[[0-9;]*m/gu, "");
}

function tabs(text: string): string {
	return text.replaceAll("\t", "  ");
}

function adaptiveWrapRows(width: number): number {
	if (width >= 180) return MAX_WRAP_ROWS_WIDE;
	if (width >= 120) return MAX_WRAP_ROWS_MED;
	return MAX_WRAP_ROWS_NARROW;
}

function fit(s: DiffSgr, value: string, width: number): string {
	if (width <= 0) return "";
	const plain = diffStrip(value);
	if (plain.length <= width) return value + " ".repeat(width - plain.length);
	const showWidth = width > 2 ? width - 1 : width;
	let visible = 0;
	let index = 0;
	while (index < value.length && visible < showWidth) {
		if (value[index] === "\x1b") {
			const end = value.indexOf("m", index);
			if (end !== -1) {
				index = end + 1;
				continue;
			}
		}
		visible += 1;
		index += 1;
	}
	return width > 2 ? `${value.slice(0, index)}${D_RST}${s.FG_DIM}›${D_RST}` : `${value.slice(0, index)}${D_RST}`;
}

function ansiState(text: string): string {
	const matches = text.match(/\x1b\[[0-9;]*m/gu) ?? [];
	let foreground = "";
	let background = "";
	for (const sequence of matches) {
		const params = sequence.slice(2, -1);
		if (params === "0") {
			foreground = "";
			background = "";
		} else if (params === "39") {
			foreground = "";
		} else if (params.startsWith("38;")) {
			foreground = sequence;
		} else if (params.startsWith("48;")) {
			background = sequence;
		}
	}
	return background + foreground;
}

function normalizeShikiContrast(s: DiffSgr, ansi: string): string {
	const darkFgThreshold = 72;
	return ansi.replaceAll(/\x1b\[([0-9;]*)m/gu, (sequence: string, params: string) => {
		if (params === "30" || params === "90" || params === "38;5;0" || params === "38;5;8") return s.FG_SAFE_MUTED;
		if (!params.startsWith("38;2;")) return sequence;
		const parts = params.split(";").map(Number);
		if (parts.length !== 5 || parts.some((value) => !Number.isFinite(value))) return sequence;
		const [, , r = 0, g = 0, b = 0] = parts;
		const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		return luminance < darkFgThreshold ? s.FG_SAFE_MUTED : sequence;
	});
}

function wrapAnsi(s: DiffSgr, text: string, width: number, maxRows: number, fillBg = ""): string[] {
	if (width <= 0) return [""];
	const plain = diffStrip(text);
	if (plain.length <= width) {
		const pad = width - plain.length;
		return pad > 0 ? [text + fillBg + " ".repeat(pad) + (fillBg === "" ? "" : D_RST)] : [text];
	}
	const rows: string[] = [];
	let row = "";
	let visible = 0;
	let index = 0;
	let onLastRow = false;
	let effectiveWidth = width;
	while (index < text.length) {
		if (!onLastRow && rows.length >= maxRows - 1) {
			onLastRow = true;
			effectiveWidth = width > 2 ? width - 1 : width;
		}
		if (text[index] === "\x1b") {
			const end = text.indexOf("m", index);
			if (end !== -1) {
				row += text.slice(index, end + 1);
				index = end + 1;
				continue;
			}
		}
		if (visible >= effectiveWidth) {
			if (onLastRow) {
				let hasMore = false;
				for (let scan = index; scan < text.length; scan += 1) {
					if (text[scan] === "\x1b") {
						const end = text.indexOf("m", scan);
						if (end !== -1) {
							scan = end;
							continue;
						}
					}
					hasMore = true;
					break;
				}
				if (hasMore && width > 2) row += `${D_RST}${s.FG_DIM}›${D_RST}`;
				else row += fillBg + " ".repeat(Math.max(0, width - visible)) + D_RST;
				rows.push(row);
				return rows;
			}
			const state = ansiState(row);
			rows.push(row + D_RST);
			row = state + fillBg;
			visible = 0;
			if (rows.length >= maxRows - 1) {
				onLastRow = true;
				effectiveWidth = width > 2 ? width - 1 : width;
			}
		}
		row += text[index] ?? "";
		visible += 1;
		index += 1;
	}
	if (row.length > 0 || rows.length === 0) {
		rows.push(row + fillBg + " ".repeat(Math.max(0, width - visible)) + D_RST);
	}
	return rows;
}

function lnum(s: DiffSgr, value: number | null, width: number, foreground = s.FG_LNUM): string {
	if (value === null) return " ".repeat(width);
	const text = String(value);
	return `${foreground}${" ".repeat(Math.max(0, width - text.length))}${text}`;
}

function stripes(s: DiffSgr, width: number): string {
	return `${s.BG_BASE}${s.FG_STRIPE}${"╱".repeat(width)}${D_RST}`;
}

function diffRule(s: DiffSgr, width: number): string {
	return `${s.BG_BASE}${s.FG_RULE}${"─".repeat(width)}${D_RST}`;
}

function maxLineNumber(lines: readonly DiffLine[]): number {
	let max = 0;
	for (const line of lines) {
		const value = line.oldNum ?? line.newNum ?? 0;
		if (value > max) max = value;
	}
	return max;
}

export function renderDiffStatBar(p: ResolvedPalette, added: number, removed: number, width = 80): string {
	const s = diffSgr(p);
	const total = added + removed;
	if (total === 0 || width < 20) return "";
	const slots = Math.max(8, Math.min(20, Math.floor(width / 14)));
	let addSlots = Math.max(0, Math.min(slots, Math.round((added / total) * slots)));
	if (added > 0 && addSlots === 0) addSlots = 1;
	if (removed > 0 && addSlots >= slots) addSlots = slots - 1;
	const removeSlots = Math.max(0, slots - addSlots);
	const addBar = addSlots > 0 ? `${s.FG_ADD}${"━".repeat(addSlots)}${D_RST}` : "";
	const removeBar = removeSlots > 0 ? `${s.FG_DEL}${"━".repeat(removeSlots)}${D_RST}` : "";
	return `${s.FG_DIM}[${D_RST}${addBar}${removeBar}${s.FG_DIM}]${D_RST}`;
}

export function summarizeDiff(p: ResolvedPalette, added: number, removed: number, width = 80): string {
	const s = diffSgr(p);
	const parts: string[] = [];
	if (added > 0) parts.push(`${s.FG_ADD}+${added}${D_RST}`);
	if (removed > 0) parts.push(`${s.FG_DEL}-${removed}${D_RST}`);
	if (parts.length === 0) return `${s.FG_DIM}no changes${D_RST}`;
	const bar = renderDiffStatBar(p, added, removed, width);
	return bar === "" ? parts.join(" ") : `${parts.join(" ")} ${bar}`;
}

export function diffSummaryWithMeta(
	p: ResolvedPalette,
	added: number,
	removed: number,
	hunks: number,
	mode: string,
	width = 80,
): string {
	const s = diffSgr(p);
	const base = summarizeDiff(p, added, removed, width);
	const extras: string[] = [];
	if (hunks > 0) extras.push(`${s.FG_DIM}${hunks} hunk${hunks === 1 ? "" : "s"}${D_RST}`);
	if (mode !== "") extras.push(`${s.FG_DIM}${mode}${D_RST}`);
	return extras.length > 0 ? `${base} ${s.FG_DIM}•${D_RST} ${extras.join(` ${s.FG_DIM}•${D_RST} `)}` : base;
}

export function collapsedDiffHint(
	remainingLines: number,
	hiddenHunks: number,
	width = 80,
	toggleHint = "ctrl+o to toggle",
): string {
	const candidates = [
		`… (${remainingLines} more diff lines${hiddenHunks > 0 ? ` • ${hiddenHunks} more hunks` : ""} • ${toggleHint})`,
		`… (${remainingLines} more lines${hiddenHunks > 0 ? ` • ${hiddenHunks} hunks` : ""})`,
		`… (+${remainingLines}${hiddenHunks > 0 ? ` • +${hiddenHunks}h` : ""})`,
		"…",
	];
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return truncateToWidth("…", width, "");
}

export function shouldUseSplit(diff: ParsedDiff, width: number, maxRows = MAX_PREVIEW_LINES): boolean {
	if (diff.lines.length === 0) return false;
	if (width < SPLIT_MIN_WIDTH) return false;
	const numberWidth = Math.max(2, String(maxLineNumber(diff.lines)).length);
	const half = Math.floor((width - 1) / 2);
	const codeWidth = Math.max(12, half - (numberWidth + 5));
	if (codeWidth < SPLIT_MIN_CODE_WIDTH) return false;
	let contentLines = 0;
	let wrapCandidates = 0;
	for (const line of diff.lines.slice(0, maxRows)) {
		if (line.type === "sep") continue;
		contentLines += 1;
		if (tabs(line.content).length > codeWidth) wrapCandidates += 1;
	}
	if (contentLines === 0) return true;
	if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false;
	return wrapCandidates / contentLines < SPLIT_MAX_WRAP_RATIO;
}

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
	ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
	js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
	py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
	c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", swift: "swift",
	kt: "kotlin", html: "html", css: "css", scss: "scss", json: "json",
	yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown",
	sh: "bash", bash: "bash", zsh: "bash", sql: "sql", xml: "xml",
	lua: "lua", php: "php", vue: "vue", svelte: "svelte", graphql: "graphql",
};

export function diffLanguage(path: string): string | undefined {
	const base = path.split("/").pop()?.toLowerCase() ?? "";
	if (base === "dockerfile") return "docker";
	if (base === "makefile") return "make";
	const extension = base.includes(".") ? base.split(".").pop() ?? "" : "";
	return EXTENSION_LANGUAGES[extension];
}

export const DEFAULT_SHIKI_THEME = "github-dark";

const highlightCache = new Map<string, readonly string[]>();

function touchCache(key: string, value: readonly string[]): readonly string[] {
	highlightCache.delete(key);
	highlightCache.set(key, value);
	while (highlightCache.size > CACHE_LIMIT) {
		const oldest = highlightCache.keys().next().value;
		if (oldest === undefined) break;
		highlightCache.delete(oldest);
	}
	return value;
}

function highlightKey(theme: string, language: string, code: string): string {
	return `${theme}\u0000${language}\u0000${code}`;
}

export function clearHighlightCache(): void {
	highlightCache.clear();
}

export async function warmHighlightCache(
	code: string,
	language: string | undefined,
	theme = DEFAULT_SHIKI_THEME,
): Promise<readonly string[]> {
	if (code === "") return [""];
	if (language === undefined || code.length > MAX_HL_CHARS) return code.split("\n");
	const key = highlightKey(theme, language, code);
	const hit = highlightCache.get(key);
	if (hit !== undefined) return touchCache(key, hit);
	try {
		const specifier = "@shikijs/cli";
		const loaded = (await import(specifier)) as unknown;
		const codeToAnsi = (loaded as { codeToAnsi?: unknown }).codeToAnsi;
		if (typeof codeToAnsi !== "function") return touchCache(key, code.split("\n"));
		const render = codeToAnsi as (source: string, lang: string, themeName: string) => Promise<string>;
		const s = diffSgr(activeSgrPalette);
		const ansi = normalizeShikiContrast(s, await render(code, language, theme));
		const body = ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi;
		return touchCache(key, body.split("\n"));
	} catch {
		return touchCache(key, code.split("\n"));
	}
}

// The highlighter needs a palette for contrast normalization; the tools layer
// sets the active palette on session/theme changes.
let activeSgrPalette: ResolvedPalette = resolvePalette("claude-code-dark", () => undefined);
export function setDiffPalette(p: ResolvedPalette): void {
	activeSgrPalette = p;
}

export function shikiHighlighter(theme = DEFAULT_SHIKI_THEME): DiffHighlighter {
	return (code, language) => {
		if (language === undefined) return undefined;
		return highlightCache.get(highlightKey(theme, language, code));
	};
}

export function parseDiff(oldContent: string, newContent: string, contextLines = 3): ParsedDiff {
	const patch = structuredPatch("", "", oldContent, newContent, "", "", { context: contextLines });
	return fromPatch(patch.hunks, oldContent.length + newContent.length);
}

export function parseDiffBounded(
	oldContent: string,
	newContent: string,
	maxEditLength: number,
	contextLines = 3,
): ParsedDiff | undefined {
	const patch = structuredPatch("", "", oldContent, newContent, "", "", {
		context: contextLines,
		maxEditLength,
	});
	if (patch === undefined) return undefined;
	return fromPatch(patch.hunks, oldContent.length + newContent.length);
}

function fromPatch(
	hunks: ReadonlyArray<{ oldStart: number; oldLines: number; newStart: number; lines: string[] }>,
	chars: number,
): ParsedDiff {
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	for (const [hunkIndex, hunk] of hunks.entries()) {
		const previous = hunkIndex > 0 ? hunks[hunkIndex - 1] : undefined;
		if (previous !== undefined) {
			const gap = hunk.oldStart - (previous.oldStart + previous.oldLines);
			lines.push({ type: "sep", oldNum: null, newNum: gap > 0 ? gap : null, content: "" });
		}
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const raw of hunk.lines) {
			if (raw === "\\ No newline at end of file") continue;
			const marker = raw[0];
			const text = raw.slice(1);
			if (marker === "+") {
				lines.push({ type: "add", oldNum: null, newNum: newLine, content: text });
				newLine += 1;
				added += 1;
			} else if (marker === "-") {
				lines.push({ type: "del", oldNum: oldLine, newNum: null, content: text });
				oldLine += 1;
				removed += 1;
			} else {
				lines.push({ type: "ctx", oldNum: oldLine, newNum: newLine, content: text });
				oldLine += 1;
				newLine += 1;
			}
		}
	}
	return { lines, added, removed, chars };
}

export function wordDiffAnalysis(
	oldText: string,
	newText: string,
): { similarity: number; oldRanges: Array<[number, number]>; newRanges: Array<[number, number]> } {
	if (oldText === "" && newText === "") return { similarity: 1, oldRanges: [], newRanges: [] };
	const parts = diffWords(oldText, newText);
	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oldPos = 0;
	let newPos = 0;
	let same = 0;
	for (const part of parts) {
		const length = part.value.length;
		if (part.removed === true) {
			oldRanges.push([oldPos, oldPos + length]);
			oldPos += length;
		} else if (part.added === true) {
			newRanges.push([newPos, newPos + length]);
			newPos += length;
		} else {
			same += length;
			oldPos += length;
			newPos += length;
		}
	}
	const maxLength = Math.max(oldText.length, newText.length);
	return { similarity: maxLength > 0 ? same / maxLength : 1, oldRanges, newRanges };
}

function injectBg(
	s: DiffSgr,
	ansiLine: string,
	ranges: ReadonlyArray<readonly [number, number]>,
	baseBg: string,
	highlightBg: string,
): string {
	if (ranges.length === 0) return baseBg + ansiLine + D_RST;
	let out = baseBg;
	let visible = 0;
	let inHighlight = false;
	let rangeIndex = 0;
	let index = 0;
	while (index < ansiLine.length) {
		if (ansiLine[index] === "\x1b") {
			const end = ansiLine.indexOf("m", index);
			if (end !== -1) {
				const sequence = ansiLine.slice(index, end + 1);
				out += sequence;
				if (sequence === "\x1b[0m") out += inHighlight ? highlightBg : baseBg;
				index = end + 1;
				continue;
			}
		}
		let range = ranges[rangeIndex];
		while (range !== undefined && visible >= range[1]) {
			rangeIndex += 1;
			range = ranges[rangeIndex];
		}
		const want = range !== undefined && visible >= range[0] && visible < range[1];
		if (want !== inHighlight) {
			inHighlight = want;
			out += inHighlight ? highlightBg : baseBg;
		}
		out += ansiLine[index] ?? "";
		visible += 1;
		index += 1;
	}
	return out + D_RST;
}

function plainWordDiff(s: DiffSgr, oldText: string, newText: string): { old: string; new: string } {
	const parts = diffWords(oldText, newText);
	let oldOut = "";
	let newOut = "";
	for (const part of parts) {
		if (part.removed === true) oldOut += `${s.BG_DEL_W}${part.value}${D_RST}${s.BG_DEL}`;
		else if (part.added === true) newOut += `${s.BG_ADD_W}${part.value}${D_RST}${s.BG_ADD}`;
		else {
			oldOut += part.value;
			newOut += part.value;
		}
	}
	return { old: oldOut, new: newOut };
}

function highlightSide(
	source: readonly string[],
	options: DiffRenderOptions,
	enabled: boolean,
): readonly string[] {
	if (!enabled || options.highlight === undefined) return source;
	return options.highlight(source.join("\n"), options.language) ?? source;
}

export function renderUnified(p: ResolvedPalette, diff: ParsedDiff, width: number, options: DiffRenderOptions = {}): string[] {
	const s = diffSgr(p);
	if (diff.lines.length === 0) return [];
	const max = options.maxLines ?? MAX_RENDER_LINES;
	const visible = diff.lines.slice(0, max);
	const numberWidth = Math.max(2, String(maxLineNumber(visible)).length);
	const codeWidth = Math.max(20, width - (numberWidth + 5));
	const wrapRows = adaptiveWrapRows(width);
	const canHighlight = diff.chars <= MAX_HL_CHARS && visible.length <= MAX_RENDER_LINES;

	const oldSource: string[] = [];
	const newSource: string[] = [];
	for (const line of visible) {
		if (line.type === "ctx" || line.type === "del") oldSource.push(line.content);
		if (line.type === "ctx" || line.type === "add") newSource.push(line.content);
	}
	const oldHighlighted = highlightSide(oldSource, options, canHighlight);
	const newHighlighted = highlightSide(newSource, options, canHighlight);

	let oldIndex = 0;
	let newIndex = 0;
	let index = 0;
	const out: string[] = [diffRule(s, width)];

	const emitRow = (
		num: number | null,
		sign: string,
		gutterBg: string,
		signFg: string,
		body: string,
		bodyBg = "",
	): void => {
		const borderFg = sign === "-" ? s.FG_DEL : sign === "+" ? s.FG_ADD : "";
		const border = borderFg === "" ? `${s.BG_BASE} ` : `${borderFg}▌${D_RST}`;
		const numberFg = borderFg === "" ? s.FG_LNUM : borderFg;
		const gutter = `${border}${gutterBg}${lnum(s, num, numberWidth, numberFg)}${signFg}${sign} ${D_RST}${s.DIVIDER} `;
		const continuation = `${border}${gutterBg}${" ".repeat(numberWidth + 2)}${D_RST}${s.DIVIDER} `;
		const rows = wrapAnsi(s, tabs(body), codeWidth, wrapRows, bodyBg);
		out.push(`${gutter}${rows[0] ?? ""}${D_RST}`);
		for (const row of rows.slice(1)) out.push(`${continuation}${row}${D_RST}`);
	};

	while (index < visible.length) {
		const line = visible[index];
		if (line === undefined) break;
		if (line.type === "sep") {
			const gap = line.newNum;
			const label = gap !== null && gap > 0 ? ` ${gap} unmodified lines ` : "···";
			const totalWidth = Math.min(width, 72);
			const pad = Math.max(0, totalWidth - label.length - 2);
			const half = Math.floor(pad / 2);
			out.push(`${s.BG_BASE}${s.FG_DIM}${"─".repeat(half)}${label}${"─".repeat(pad - half)}${D_RST}`);
			index += 1;
			continue;
		}
		if (line.type === "ctx") {
			const highlighted = oldHighlighted[oldIndex] ?? line.content;
			emitRow(line.newNum, " ", s.BG_BASE, s.FG_DIM, `${s.BG_BASE}${D_DIM}${highlighted}`, s.BG_BASE);
			oldIndex += 1;
			newIndex += 1;
			index += 1;
			continue;
		}

		const removals: Array<{ line: DiffLine; highlighted: string }> = [];
		while (index < visible.length) {
			const candidate = visible[index];
			if (candidate === undefined || candidate.type !== "del") break;
			removals.push({ line: candidate, highlighted: oldHighlighted[oldIndex] ?? candidate.content });
			oldIndex += 1;
			index += 1;
		}
		const additions: Array<{ line: DiffLine; highlighted: string }> = [];
		while (index < visible.length) {
			const candidate = visible[index];
			if (candidate === undefined || candidate.type !== "add") break;
			additions.push({ line: candidate, highlighted: newHighlighted[newIndex] ?? candidate.content });
			newIndex += 1;
			index += 1;
		}

		const removal = removals.length === 1 ? removals[0] : undefined;
		const addition = additions.length === 1 ? additions[0] : undefined;
		const paired = removal !== undefined && addition !== undefined
			? wordDiffAnalysis(removal.line.content, addition.line.content)
			: undefined;
		if (removal !== undefined && addition !== undefined && paired !== undefined && paired.similarity >= WORD_DIFF_MIN_SIM) {
			if (canHighlight) {
				emitRow(removal.line.oldNum, "-", s.BG_DEL, `${s.FG_DEL}${D_BOLD}`, injectBg(s, removal.highlighted, paired.oldRanges, s.BG_DEL, s.BG_DEL_W), s.BG_DEL);
				emitRow(addition.line.newNum, "+", s.BG_ADD, `${s.FG_ADD}${D_BOLD}`, injectBg(s, addition.highlighted, paired.newRanges, s.BG_ADD, s.BG_ADD_W), s.BG_ADD);
			} else {
				const words = plainWordDiff(s, removal.line.content, addition.line.content);
				emitRow(removal.line.oldNum, "-", s.BG_DEL, `${s.FG_DEL}${D_BOLD}`, `${s.BG_DEL}${words.old}`, s.BG_DEL);
				emitRow(addition.line.newNum, "+", s.BG_ADD, `${s.FG_ADD}${D_BOLD}`, `${s.BG_ADD}${words.new}`, s.BG_ADD);
			}
			continue;
		}
		for (const entry of removals) {
			const body = canHighlight ? entry.highlighted : entry.line.content;
			emitRow(entry.line.oldNum, "-", s.BG_DEL, `${s.FG_DEL}${D_BOLD}`, `${s.BG_DEL}${body}`, s.BG_DEL);
		}
		for (const entry of additions) {
			const body = canHighlight ? entry.highlighted : entry.line.content;
			emitRow(entry.line.newNum, "+", s.BG_ADD, `${s.FG_ADD}${D_BOLD}`, `${s.BG_ADD}${body}`, s.BG_ADD);
		}
	}

	out.push(diffRule(s, width));
	if (diff.lines.length > visible.length) {
		const hint = collapsedDiffHint(diff.lines.length - visible.length, 0, width, options.toggleHint);
		out.push(`${s.BG_BASE}${s.FG_DIM}  ${hint}${D_RST}`);
	}
	return out;
}

export function renderSplit(p: ResolvedPalette, diff: ParsedDiff, width: number, options: DiffRenderOptions = {}): string[] {
	const s = diffSgr(p);
	const max = options.maxLines ?? MAX_PREVIEW_LINES;
	if (!shouldUseSplit(diff, width, max)) return renderUnified(p, diff, width, options);
	if (diff.lines.length === 0) return [];

	interface Row {
		left: DiffLine | null;
		right: DiffLine | null;
	}
	const rows: Row[] = [];
	let cursor = 0;
	while (cursor < diff.lines.length) {
		const line = diff.lines[cursor];
		if (line === undefined) break;
		if (line.type === "sep" || line.type === "ctx") {
			rows.push({ left: line, right: line });
			cursor += 1;
			continue;
		}
		const removals: DiffLine[] = [];
		const additions: DiffLine[] = [];
		while (cursor < diff.lines.length) {
			const candidate = diff.lines[cursor];
			if (candidate === undefined || candidate.type !== "del") break;
			removals.push(candidate);
			cursor += 1;
		}
		while (cursor < diff.lines.length) {
			const candidate = diff.lines[cursor];
			if (candidate === undefined || candidate.type !== "add") break;
			additions.push(candidate);
			cursor += 1;
		}
		for (let pair = 0; pair < Math.max(removals.length, additions.length); pair += 1) {
			rows.push({ left: removals[pair] ?? null, right: additions[pair] ?? null });
		}
	}

	const visible = rows.slice(0, max);
	const half = Math.floor((width - 1) / 2);
	const numberWidth = Math.max(2, String(maxLineNumber(diff.lines)).length);
	const codeWidth = Math.max(12, half - (numberWidth + 5));
	const wrapRows = adaptiveWrapRows(width);
	const canHighlight = diff.chars <= MAX_HL_CHARS;

	const leftSource: string[] = [];
	const rightSource: string[] = [];
	for (const row of visible) {
		if (row.left !== null && row.left.type !== "sep") leftSource.push(row.left.content);
		if (row.right !== null && row.right.type !== "sep") rightSource.push(row.right.content);
	}
	const leftHighlighted = highlightSide(leftSource, options, canHighlight);
	const rightHighlighted = highlightSide(rightSource, options, canHighlight);

	let leftIndex = 0;
	let rightIndex = 0;

	interface HalfResult {
		gutter: string;
		contGutter: string;
		bodyRows: string[];
	}
	const halfBuild = (
		line: DiffLine | null,
		highlighted: string,
		ranges: ReadonlyArray<readonly [number, number]> | null,
		side: "left" | "right",
	): HalfResult => {
		if (line === null) {
			const gutter = ` ${s.FG_STRIPE}${"╱".repeat(numberWidth + 2)}${D_RST}${s.FG_RULE}│${D_RST} `;
			return { gutter, contGutter: gutter, bodyRows: [stripes(s, codeWidth)] };
		}
		if (line.type === "sep") {
			const gap = line.newNum;
			const label = gap !== null && gap > 0 ? `··· ${gap} lines ···` : "···";
			const gutter = `${s.BG_BASE} ${s.FG_DIM}${fit(s, "", numberWidth + 2)}${D_RST}${s.FG_RULE}│${D_RST} `;
			return { gutter, contGutter: gutter, bodyRows: [`${s.BG_BASE}${s.FG_DIM}${fit(s, label, codeWidth)}${D_RST}`] };
		}
		const isDel = line.type === "del";
		const isAdd = line.type === "add";
		const gutterBg = isDel ? s.BG_DEL : isAdd ? s.BG_ADD : s.BG_BASE;
		const bodyBg = isDel ? s.BG_DEL : isAdd ? s.BG_ADD : s.BG_BASE;
		const signFg = isDel ? s.FG_DEL : isAdd ? s.FG_ADD : s.FG_DIM;
		const sign = isDel ? "-" : isAdd ? "+" : " ";
		const num = isDel ? line.oldNum : isAdd ? line.newNum : side === "left" ? line.oldNum : line.newNum;
		const borderFg = isDel ? s.FG_DEL : isAdd ? s.FG_ADD : "";
		const border = borderFg === "" ? ` ${s.BG_BASE}` : `${borderFg}▌${D_RST}`;
		const numberFg = borderFg === "" ? s.FG_LNUM : borderFg;
		const body = ranges !== null && ranges.length > 0
			? injectBg(s, highlighted, ranges, bodyBg, isDel ? s.BG_DEL_W : s.BG_ADD_W)
			: isDel || isAdd ? `${bodyBg}${highlighted}` : `${s.BG_BASE}${D_DIM}${highlighted}`;
		const gutter = `${border}${gutterBg}${lnum(s, num, numberWidth, numberFg)}${signFg}${D_BOLD}${sign} ${D_RST}${s.FG_RULE}│${D_RST} `;
		const contGutter = `${border}${gutterBg}${" ".repeat(numberWidth + 2)}${D_RST}${s.FG_RULE}│${D_RST} `;
		return { gutter, contGutter, bodyRows: wrapAnsi(s, tabs(body), codeWidth, wrapRows, bodyBg) };
	};

	const out: string[] = [];
	const headerOld = `${s.BG_BASE}${" ".repeat(Math.max(0, numberWidth - 2))}${s.FG_DEL}${D_DIM}old${D_RST}`;
	const headerNew = `${s.BG_BASE}${" ".repeat(Math.max(0, numberWidth - 2))}${s.FG_ADD}${D_DIM}new${D_RST}`;
	out.push(`${s.BG_BASE}${headerOld}${" ".repeat(Math.max(0, half - numberWidth - 1))}${s.FG_RULE}┊${D_RST}${headerNew}`);
	out.push(`${diffRule(s, half)}${s.FG_RULE}┊${D_RST}${diffRule(s, half)}`);

	for (const row of visible) {
		const { left, right } = row;
		const paired = left !== null && right !== null && left.type === "del" && right.type === "add"
			? wordDiffAnalysis(left.content, right.content)
			: undefined;
		let leftResult: HalfResult;
		let rightResult: HalfResult;
		if (left !== null && right !== null && paired !== undefined && paired.similarity >= WORD_DIFF_MIN_SIM) {
			if (canHighlight) {
				leftResult = halfBuild(left, leftHighlighted[leftIndex] ?? left.content, paired.oldRanges, "left");
				rightResult = halfBuild(right, rightHighlighted[rightIndex] ?? right.content, paired.newRanges, "right");
			} else {
				const words = plainWordDiff(s, left.content, right.content);
				leftResult = halfBuild(left, words.old, null, "left");
				rightResult = halfBuild(right, words.new, null, "right");
			}
			leftIndex += 1;
			rightIndex += 1;
		} else {
			const leftBody = left !== null && left.type !== "sep" ? leftHighlighted[leftIndex++] ?? left.content : "";
			const rightBody = right !== null && right.type !== "sep" ? rightHighlighted[rightIndex++] ?? right.content : "";
			leftResult = halfBuild(left, leftBody, null, "left");
			rightResult = halfBuild(right, rightBody, null, "right");
		}
		const rowCount = Math.max(leftResult.bodyRows.length, rightResult.bodyRows.length);
		for (let bodyRow = 0; bodyRow < rowCount; bodyRow += 1) {
			const leftGutter = bodyRow === 0 ? leftResult.gutter : leftResult.contGutter;
			const rightGutter = bodyRow === 0 ? rightResult.gutter : rightResult.contGutter;
			const leftBody = leftResult.bodyRows[bodyRow] ?? (left === null ? stripes(s, codeWidth) : `${BG_DEFAULT}${" ".repeat(codeWidth)}${D_RST}`);
			const rightBody = rightResult.bodyRows[bodyRow] ?? (right === null ? stripes(s, codeWidth) : `${BG_DEFAULT}${" ".repeat(codeWidth)}${D_RST}`);
			out.push(`${leftGutter}${leftBody}${s.DIVIDER}${rightGutter}${rightBody}`);
		}
	}

	out.push(`${diffRule(s, half)}${s.FG_RULE}┊${D_RST}${diffRule(s, half)}`);
	if (rows.length > visible.length) {
		const hint = collapsedDiffHint(rows.length - visible.length, 0, width, options.toggleHint);
		out.push(`${s.BG_BASE}${s.FG_DIM}  ${hint}${D_RST}`);
	}
	return out;
}

export function renderDiff(p: ResolvedPalette, diff: ParsedDiff, width: number, options: DiffRenderOptions = {}): string[] {
	return width >= SPLIT_MIN_WIDTH ? renderSplit(p, diff, width, options) : renderUnified(p, diff, width, options);
}

export type { ColorValue };
