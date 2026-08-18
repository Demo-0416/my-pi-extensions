/**
 * CC inline diff renderer — ported from dsh-tui/src/render/diff.ts, which itself
 * was ported from pi-claude-code-ui. structuredPatch-based parse, word-level
 * intra-line highlighting, unified + side-by-side layouts.
 *
 * Departure from the dsh-tui source: colors come from the active CC palette
 * (palette.ts) instead of fixed BRAND_COLORS, so the diff follows the active
 * theme (dark/light/daltonized/ansi).
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { diffWordsWithSpace, structuredPatch } from "diff";
import {
	bgAnsi,
	bold,
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
/**
 * CC StructuredDiff/Fallback.tsx:80 — word-level highlighting only when the
 * changed fraction of the paired lines is at most 0.4; otherwise the whole
 * line keeps the plain add/remove background.
 */
const CHANGE_RATIO_THRESHOLD = 0.4;
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

function tabs(text: string): string {
	return text.replaceAll("\t", "  ");
}

/** Shared grapheme segmenter — an ECMAScript built-in, no dependency. */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Cell {
	str: string;
	w: number;
}

/**
 * Split an ANSI-bearing string into cells: each SGR escape becomes a
 * zero-width cell copied verbatim; each grapheme cluster becomes a cell with
 * its true terminal column width (visibleWidth). Iterating these cells instead
 * of UTF-16 code units keeps surrogate pairs (emoji) intact and counts CJK as
 * 2 columns — the UTF-16 `.length`/`text[index]` advance used to both fail to
 * wrap wide CJK lines and split emoji surrogate pairs (AUDIT §5 diff.ts:197,248).
 */
function toCells(text: string): Cell[] {
	const cells: Cell[] = [];
	let i = 0;
	let runStart = 0;
	const flushPlain = (end: number): void => {
		if (end <= runStart) return;
		for (const { segment } of graphemeSegmenter.segment(text.slice(runStart, end))) {
			cells.push({ str: segment, w: visibleWidth(segment) });
		}
	};
	while (i < text.length) {
		if (text[i] === "\x1b") {
			const end = text.indexOf("m", i);
			if (end !== -1) {
				flushPlain(i);
				cells.push({ str: text.slice(i, end + 1), w: 0 });
				i = end + 1;
				runStart = i;
				continue;
			}
		}
		i += 1;
	}
	flushPlain(text.length);
	return cells;
}

function adaptiveWrapRows(width: number): number {
	if (width >= 180) return MAX_WRAP_ROWS_WIDE;
	if (width >= 120) return MAX_WRAP_ROWS_MED;
	return MAX_WRAP_ROWS_NARROW;
}

function ansiState(text: string): string {
	const matches = text.match(/\x1b\[[0-9;]*m/gu) ?? [];
	let foreground = "";
	let background = "";
	let bold = false;
	let dim = false;
	let italic = false;
	for (const sequence of matches) {
		const params = sequence.slice(2, -1);
		if (params === "0") {
			foreground = "";
			background = "";
			bold = false;
			dim = false;
			italic = false;
		} else if (params === "39") {
			foreground = "";
		} else if (params === "49") {
			background = "";
		} else if (params === "1") {
			bold = true;
		} else if (params === "2") {
			dim = true;
		} else if (params === "22") {
			// SGR 22 = normal intensity: clears BOTH bold (1) and dim (2).
			bold = false;
			dim = false;
		} else if (params === "3") {
			italic = true;
		} else if (params === "23") {
			italic = false;
		} else if (params.startsWith("38;")) {
			foreground = sequence;
		} else if (params.startsWith("48;")) {
			background = sequence;
		}
	}
	// Replay bold/dim/italic too — shiki emits them (code-to-ansi:52-55) and diff
	// ctx rows are wrapped inside a `\x1b[2m` (D_DIM) span; without replaying dim,
	// a ctx line's second wrapped row would lose the dimming (AUDIT §5 diff.ts:182).
	return background + foreground + (bold ? "\x1b[1m" : "") + (dim ? "\x1b[2m" : "") + (italic ? "\x1b[3m" : "");
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
	const cells = toCells(text);
	const plainWidth = cells.reduce((sum, c) => sum + c.w, 0);
	if (plainWidth <= width) {
		const pad = width - plainWidth;
		return pad > 0 ? [text + fillBg + " ".repeat(pad) + (fillBg === "" ? "" : D_RST)] : [text];
	}
	// Advance by cells (grapheme clusters + zero-width ANSI escapes), tracking
	// display columns. UTF-16 code-unit advance used to split emoji surrogate
	// pairs at wrap points and mis-measure CJK width (AUDIT §5 diff.ts:197,248).
	const rows: string[] = [];
	let row = "";
	let visible = 0;
	let onLastRow = false;
	let effectiveWidth = width;
	let ci = 0;
	while (ci < cells.length) {
		if (!onLastRow && rows.length >= maxRows - 1) {
			onLastRow = true;
			effectiveWidth = width > 2 ? width - 1 : width;
		}
		const cell = cells[ci]!;
		if (cell.w === 0) {
			// Zero-width (ANSI escape): copy verbatim, no wrap decision.
			row += cell.str;
			ci += 1;
			continue;
		}
		if (visible + cell.w > effectiveWidth) {
			if (onLastRow) {
				// Anything visible still to come → truncation marker; else pad out.
				let hasMore = false;
				for (let scan = ci; scan < cells.length; scan += 1) {
					if (cells[scan]!.w > 0) {
						hasMore = true;
						break;
					}
				}
				if (hasMore && width > 2) row += `${D_RST}${s.FG_DIM}›${D_RST}`;
				else row += fillBg + " ".repeat(Math.max(0, width - visible)) + D_RST;
				rows.push(row);
				return rows;
			}
			const state = ansiState(row);
			rows.push(row + fillBg + " ".repeat(Math.max(0, width - visible)) + D_RST);
			row = state + fillBg;
			visible = 0;
			if (rows.length >= maxRows - 1) {
				onLastRow = true;
				effectiveWidth = width > 2 ? width - 1 : width;
			}
		}
		row += cell.str;
		visible += cell.w;
		ci += 1;
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

/**
 * CC FileEditToolDiff.tsx:98 — the diff card frame is a dashed top/bottom
 * border only (borderLeft/borderRight=false), drawn in the subtle/dim color.
 * Terminal ink has no dashed border style, so a light double-dash glyph (╌)
 * in the dim color stands in for it.
 */
function diffDashedRule(s: DiffSgr, width: number): string {
	return `${s.BG_BASE}${s.FG_DIM}${"╌".repeat(Math.max(0, width))}${D_RST}`;
}

function maxLineNumber(lines: readonly DiffLine[]): number {
	let max = 0;
	for (const line of lines) {
		// The gutter is sized once and reused for every rendered number: unified
		// renders newNum for ctx/add and oldNum for del; split additionally
		// renders oldNum for ctx on the left. Sizing off `oldNum ?? newNum` would
		// ignore a ctx line's (rendered) newNum, so a net-add trailing hunk whose
		// widest new-side number sits on a ctx line (no add line reaches it)
		// overflows the gutter by a column (AUDIT §5 diff.ts:281). Cover both.
		const value = Math.max(line.oldNum ?? 0, line.newNum ?? 0);
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

/**
 * CC FileEditToolUpdatedMessage.tsx:32-110 — the edit/write stat line:
 * `Added N lines, Removed M lines`, numbers bold, default color, singular when
 * the count is 1. When only one side changed, the other fragment is omitted
 * (and "Removed" keeps its capital R as the first fragment).
 */
export function renderDiffStatLine(added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0) parts.push(`Added ${bold(String(added))} ${added === 1 ? "line" : "lines"}`);
	if (removed > 0) {
		parts.push(`${added > 0 ? ", " : ""}${added === 0 ? "R" : "r"}emoved ${bold(String(removed))} ${removed === 1 ? "line" : "lines"}`);
	}
	return parts.join("");
}

export function collapsedDiffHint(
	remainingLines: number,
	hiddenHunks: number,
	width = 80,
	toggleHint = "ctrl+o to toggle",
): string {
	// Singular when the count is 1 (AUDIT §5 diff.ts:349).
	const lineWord = remainingLines === 1 ? "line" : "lines";
	const hunkWord = hiddenHunks === 1 ? "hunk" : "hunks";
	const candidates = [
		`… (${remainingLines} more diff ${lineWord}${hiddenHunks > 0 ? ` • ${hiddenHunks} more ${hunkWord}` : ""} • ${toggleHint})`,
		`… (${remainingLines} more ${lineWord}${hiddenHunks > 0 ? ` • ${hiddenHunks} ${hunkWord}` : ""})`,
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
		// Measure display columns, not UTF-16 code units: a CJK line has half the
		// .length of its rendered width, so `.length > codeWidth` under-counts wrap
		// candidates and misclassifies a wide CJK diff as "narrow" → wrongly picks
		// the split layout (AUDIT §5 diff.ts:372). content is raw (no ANSI) and
		// already tab-expanded, so visibleWidth is the true column count.
		if (visibleWidth(tabs(line.content)) > codeWidth) wrapCandidates += 1;
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

/**
 * @deprecated Default kept for signature compatibility; new code should derive
 * the theme from the active palette with {@link shikiThemeForPalette} so the
 * highlight follows the dark/light scheme instead of being pinned to dark.
 */
export const DEFAULT_SHIKI_THEME = "github-dark";

/** CC shiki themes track the palette scheme (github-light on light palettes). */
export function shikiThemeForPalette(p: ResolvedPalette): string {
	return p.scheme === "light" ? "github-light" : "github-dark";
}

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
	theme: string = shikiThemeForPalette(activeSgrPalette),
): Promise<readonly string[]> {
	if (code === "") return [""];
	if (language === undefined || code.length > MAX_HL_CHARS) return code.split("\n");
	const key = highlightKey(theme, language, code);
	const hit = highlightCache.get(key);
	if (hit !== undefined) return touchCache(key, hit);
	try {
		const specifier = "@shikijs/cli";
		const loaded = (await import(specifier)) as unknown;
		// @shikijs/cli exports `codeToANSI` (all-caps ANSI), not `codeToAnsi` —
		// the misspelling made this branch always fall through to the plain-text
		// split, so syntax highlighting never ran (AUDIT §4 diff.ts:444).
		const codeToANSI = (loaded as { codeToANSI?: unknown }).codeToANSI;
		if (typeof codeToANSI !== "function") return touchCache(key, code.split("\n"));
		const render = codeToANSI as (source: string, lang: string, themeName: string) => Promise<string>;
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
	if (p === activeSgrPalette) return;
	activeSgrPalette = p;
	// Theme switch: re-warm every cached (language, code) pair under the new
	// shiki theme, so the next render highlights instead of falling back to
	// plain text (CC HighlightedCode re-highlights on theme change).
	const theme = shikiThemeForPalette(p);
	// Snapshot the keys before iterating: warmHighlightCache hits touchCache on a
	// cache hit (diff.ts touchCache: delete + re-set), which per the JS Map spec
	// moves the key to the end of the iteration order, so a live `for..of
	// highlightCache.keys()` would revisit it forever — a synchronous infinite
	// loop that freezes the TUI (AUDIT §2 P0-1).
	const keys = [...highlightCache.keys()];
	for (const key of keys) {
		const sep1 = key.indexOf("\u0000");
		const sep2 = key.indexOf("\u0000", sep1 + 1);
		if (sep1 < 0 || sep2 < 0) continue;
		const language = key.slice(sep1 + 1, sep2);
		const code = key.slice(sep2 + 1);
		void warmHighlightCache(code, language === "" ? undefined : language, theme).catch(() => {
			/* best-effort re-warm */
		});
	}
}

export function shikiHighlighter(theme?: string): DiffHighlighter {
	const resolved = theme ?? shikiThemeForPalette(activeSgrPalette);
	return (code, language) => {
		if (language === undefined) return undefined;
		return highlightCache.get(highlightKey(resolved, language, code));
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
		for (const rawWithCr of hunk.lines) {
			// CRLF sources leave a trailing \r on every patch line; a raw \r in a
			// rendered row snaps the cursor to column 0 and overwrites the gutter
			// already drawn there (AUDIT §5 diff.ts:523). Strip at the parse
			// boundary so every consumer sees clean text.
			const raw = rawWithCr.endsWith("\r") ? rawWithCr.slice(0, -1) : rawWithCr;
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
): { similarity: number; changeRatio: number; oldRanges: Array<[number, number]>; newRanges: Array<[number, number]> } {
	if (oldText === "" && newText === "") return { similarity: 1, changeRatio: 0, oldRanges: [], newRanges: [] };
	// CC Fallback.tsx:228-233 — diffWordsWithSpace preserves spaces between
	// tokens (e.g. `>` and `{`); diffWords would count pure-whitespace edits
	// as changed and inflate changeRatio.
	const parts = diffWordsWithSpace(oldText, newText);
	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oldPos = 0;
	let newPos = 0;
	let same = 0;
	let changed = 0;
	for (const part of parts) {
		const length = part.value.length;
		if (part.removed === true) {
			oldRanges.push([oldPos, oldPos + length]);
			oldPos += length;
			changed += length;
		} else if (part.added === true) {
			newRanges.push([newPos, newPos + length]);
			newPos += length;
			changed += length;
		} else {
			same += length;
			oldPos += length;
			newPos += length;
		}
	}
	const maxLength = Math.max(oldText.length, newText.length);
	// CC Fallback.tsx:253-255: changeRatio = changedLength / (oldLen + newLen).
	const totalLength = oldText.length + newText.length;
	return {
		similarity: maxLength > 0 ? same / maxLength : 1,
		changeRatio: totalLength > 0 ? changed / totalLength : 0,
		oldRanges,
		newRanges,
	};
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
	const parts = diffWordsWithSpace(oldText, newText);
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

/** One paired row of the side-by-side layout (module-scoped so warm + render share it). */
interface SplitRow {
	left: DiffLine | null;
	right: DiffLine | null;
}

/**
 * The old/new code the unified renderer feeds to the highlighter: ctx+del on
 * the old side, ctx+add on the new side, in file order. Shared by renderUnified
 * and warmDiffHighlight so the warmed string is byte-identical to the queried
 * one — the two used to build the string independently and never matched, so
 * the cache always missed and the old side was never warmed (AUDIT §5 diff.ts:646).
 */
function unifiedSources(visible: readonly DiffLine[]): { old: string[]; new: string[] } {
	const old: string[] = [];
	const next: string[] = [];
	for (const line of visible) {
		if (line.type === "ctx" || line.type === "del") old.push(line.content);
		if (line.type === "ctx" || line.type === "add") next.push(line.content);
	}
	return { old, new: next };
}

/** Pair del/add blocks into side-by-side rows (independent of width). */
function buildSplitRows(lines: readonly DiffLine[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let cursor = 0;
	while (cursor < lines.length) {
		const line = lines[cursor];
		if (line === undefined) break;
		if (line.type === "sep" || line.type === "ctx") {
			rows.push({ left: line, right: line });
			cursor += 1;
			continue;
		}
		const removals: DiffLine[] = [];
		const additions: DiffLine[] = [];
		while (cursor < lines.length) {
			const candidate = lines[cursor];
			if (candidate === undefined || candidate.type !== "del") break;
			removals.push(candidate);
			cursor += 1;
		}
		while (cursor < lines.length) {
			const candidate = lines[cursor];
			if (candidate === undefined || candidate.type !== "add") break;
			additions.push(candidate);
			cursor += 1;
		}
		for (let pair = 0; pair < Math.max(removals.length, additions.length); pair += 1) {
			rows.push({ left: removals[pair] ?? null, right: additions[pair] ?? null });
		}
	}
	return rows;
}

/** The left/right code the split renderer feeds to the highlighter. */
function splitSources(visible: readonly SplitRow[]): { left: string[]; right: string[] } {
	const left: string[] = [];
	const right: string[] = [];
	for (const row of visible) {
		if (row.left !== null && row.left.type !== "sep") left.push(row.left.content);
		if (row.right !== null && row.right.type !== "sep") right.push(row.right.content);
	}
	return { left, right };
}

/**
 * Warm the highlight cache with the exact per-side join strings both layouts
 * will later query. renderResult has no terminal width, so it cannot know
 * whether renderSplit or renderUnified runs; warming both layouts' sources (up
 * to 4 strings, deduped by the cache key) guarantees a hit either way. This is
 * the correct replacement for the old `warmHighlightCache(content, …)` call,
 * which warmed the whole-file string that no renderer ever looks up.
 */
export async function warmDiffHighlight(
	diff: ParsedDiff,
	options: { maxLines?: number; language: string | undefined; theme?: string },
): Promise<void> {
	if (options.language === undefined || diff.chars > MAX_HL_CHARS) return;
	const theme = options.theme ?? shikiThemeForPalette(activeSgrPalette);
	const uniMax = options.maxLines ?? MAX_RENDER_LINES;
	const uni = unifiedSources(diff.lines.slice(0, uniMax));
	const splitMax = options.maxLines ?? MAX_PREVIEW_LINES;
	const sp = splitSources(buildSplitRows(diff.lines).slice(0, splitMax));
	const seen = new Set<string>();
	const warm: Array<Promise<unknown>> = [];
	for (const code of [uni.old.join("\n"), uni.new.join("\n"), sp.left.join("\n"), sp.right.join("\n")]) {
		if (code === "" || seen.has(code)) continue;
		seen.add(code);
		warm.push(warmHighlightCache(code, options.language, theme).catch(() => undefined));
	}
	await Promise.all(warm);
}

export function renderUnified(p: ResolvedPalette, diff: ParsedDiff, width: number, options: DiffRenderOptions = {}): string[] {
	const s = diffSgr(p);
	if (diff.lines.length === 0) return [];
	const max = options.maxLines ?? MAX_RENDER_LINES;
	const visible = diff.lines.slice(0, max);
	const numberWidth = Math.max(2, String(maxLineNumber(visible)).length);
	// CC Fallback.tsx:351 — content width only floors at 1; a 20-col floor
	// would overflow the card on narrow terminals (gutter 7 + code 20 > w=20).
	const codeWidth = Math.max(1, width - (numberWidth + 5));
	const wrapRows = adaptiveWrapRows(width);
	const canHighlight = diff.chars <= MAX_HL_CHARS && visible.length <= MAX_RENDER_LINES;

	const oldSource: string[] = [];
	const newSource: string[] = [];
	{
		const sources = unifiedSources(visible);
		oldSource.push(...sources.old);
		newSource.push(...sources.new);
	}
	const oldHighlighted = highlightSide(oldSource, options, canHighlight);
	const newHighlighted = highlightSide(newSource, options, canHighlight);

	let oldIndex = 0;
	let newIndex = 0;
	let index = 0;
	const out: string[] = [diffDashedRule(s, width)];

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
			// CC StructuredDiffList.tsx:27 — hunks are separated by a dim "..." row.
			out.push(`${s.BG_BASE}${s.FG_DIM}...${D_RST}`);
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

		// CC Fallback.tsx:190-204 — pair the k-th removal with the k-th addition
		// for word-level highlighting only (a pair whose changeRatio exceeds the
		// threshold falls back to whole-line). Render order stays the patch's
		// block order: all removals, then all additions. Interleaving the pairs
		// put an unpaired removal tail *after* the additions, so old-side line
		// numbers jumped backwards within one hunk (AUDIT §5 diff.ts:733).
		const pairCount = Math.min(removals.length, additions.length);
		const analyses = Array.from({ length: pairCount }, (_, k) =>
			wordDiffAnalysis(removals[k]!.line.content, additions[k]!.line.content));
		const plainWords = analyses.map((analysis, k) =>
			!canHighlight && analysis.changeRatio <= CHANGE_RATIO_THRESHOLD
				? plainWordDiff(s, removals[k]!.line.content, additions[k]!.line.content)
				: undefined);
		for (let k = 0; k < removals.length; k += 1) {
			const entry = removals[k]!;
			const analysis = k < pairCount ? analyses[k] : undefined;
			if (analysis !== undefined && analysis.changeRatio <= CHANGE_RATIO_THRESHOLD) {
				const body = canHighlight
					? injectBg(s, entry.highlighted, analysis.oldRanges, s.BG_DEL, s.BG_DEL_W)
					: `${s.BG_DEL}${plainWords[k]!.old}`;
				emitRow(entry.line.oldNum, "-", s.BG_DEL, `${s.FG_DEL}${D_BOLD}`, body, s.BG_DEL);
			} else {
				emitRow(entry.line.oldNum, "-", s.BG_DEL, `${s.FG_DEL}${D_BOLD}`, `${s.BG_DEL}${canHighlight ? entry.highlighted : entry.line.content}`, s.BG_DEL);
			}
		}
		for (let k = 0; k < additions.length; k += 1) {
			const entry = additions[k]!;
			const analysis = k < pairCount ? analyses[k] : undefined;
			if (analysis !== undefined && analysis.changeRatio <= CHANGE_RATIO_THRESHOLD) {
				const body = canHighlight
					? injectBg(s, entry.highlighted, analysis.newRanges, s.BG_ADD, s.BG_ADD_W)
					: `${s.BG_ADD}${plainWords[k]!.new}`;
				emitRow(entry.line.newNum, "+", s.BG_ADD, `${s.FG_ADD}${D_BOLD}`, body, s.BG_ADD);
			} else {
				emitRow(entry.line.newNum, "+", s.BG_ADD, `${s.FG_ADD}${D_BOLD}`, `${s.BG_ADD}${canHighlight ? entry.highlighted : entry.line.content}`, s.BG_ADD);
			}
		}
	}

	out.push(diffDashedRule(s, width));
	if (diff.lines.length > visible.length) {
		// The 2-space indent is part of the width budget (callers prefix it).
		const hint = collapsedDiffHint(diff.lines.length - visible.length, 0, width - 2, options.toggleHint);
		out.push(`${s.BG_BASE}${s.FG_DIM}  ${hint}${D_RST}`);
	}
	return out;
}

export function renderSplit(p: ResolvedPalette, diff: ParsedDiff, width: number, options: DiffRenderOptions = {}): string[] {
	const s = diffSgr(p);
	const max = options.maxLines ?? MAX_PREVIEW_LINES;
	if (!shouldUseSplit(diff, width, max)) return renderUnified(p, diff, width, options);
	if (diff.lines.length === 0) return [];

	// Shared with warmDiffHighlight so the warmed source is byte-identical to
	// what highlightSide queries below (AUDIT §5 diff.ts:646).
	const rows: SplitRow[] = buildSplitRows(diff.lines);

	const visible = rows.slice(0, max);
	const half = Math.floor((width - 1) / 2);
	const numberWidth = Math.max(2, String(maxLineNumber(diff.lines)).length);
	const codeWidth = Math.max(12, half - (numberWidth + 5));
	const wrapRows = adaptiveWrapRows(width);
	const canHighlight = diff.chars <= MAX_HL_CHARS;

	const { left: leftSource, right: rightSource } = splitSources(visible);
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
		// No sep branch: buildSplitRows only ever emits sep as a {left: sep,
		// right: sep} pair, and the row loop below renders that pair as one
		// full-width dim "..." row (same as unified) before halfBuild runs —
		// a per-side sep here was unreachable (AUDIT §5 diff.ts:843).
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
	out.push(`${diffDashedRule(s, half)}${s.FG_RULE}┊${D_RST}${diffDashedRule(s, half)}`);

	for (const row of visible) {
		const { left, right } = row;
		if (left !== null && right !== null && left.type === "sep" && right.type === "sep") {
			// CC StructuredDiffList.tsx:27 — one dim "..." row between hunks.
			out.push(`${s.BG_BASE}${s.FG_DIM}...${D_RST}`);
			continue;
		}
		const paired = left !== null && right !== null && left.type === "del" && right.type === "add"
			? wordDiffAnalysis(left.content, right.content)
			: undefined;
		let leftResult: HalfResult;
		let rightResult: HalfResult;
		if (left !== null && right !== null && paired !== undefined && paired.changeRatio <= CHANGE_RATIO_THRESHOLD) {
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
		// Filler rows for the shorter side keep that side's add/del background —
		// BG_DEFAULT here visibly broke the color block mid-row (AUDIT §5 diff.ts:904).
		const fillBgOf = (line: DiffLine | null): string =>
			line !== null && line.type === "del" ? s.BG_DEL : line !== null && line.type === "add" ? s.BG_ADD : s.BG_BASE;
		const rowCount = Math.max(leftResult.bodyRows.length, rightResult.bodyRows.length);
		for (let bodyRow = 0; bodyRow < rowCount; bodyRow += 1) {
			const leftGutter = bodyRow === 0 ? leftResult.gutter : leftResult.contGutter;
			const rightGutter = bodyRow === 0 ? rightResult.gutter : rightResult.contGutter;
			const leftBody = leftResult.bodyRows[bodyRow] ?? (left === null ? stripes(s, codeWidth) : `${fillBgOf(left)}${" ".repeat(codeWidth)}${D_RST}`);
			const rightBody = rightResult.bodyRows[bodyRow] ?? (right === null ? stripes(s, codeWidth) : `${fillBgOf(right)}${" ".repeat(codeWidth)}${D_RST}`);
			out.push(`${leftGutter}${leftBody}${s.DIVIDER}${rightGutter}${rightBody}`);
		}
	}

	out.push(`${diffDashedRule(s, half)}${s.FG_RULE}┊${D_RST}${diffDashedRule(s, half)}`);
	if (rows.length > visible.length) {
		// The 2-space indent is part of the width budget (callers prefix it).
		const hint = collapsedDiffHint(rows.length - visible.length, 0, width - 2, options.toggleHint);
		out.push(`${s.BG_BASE}${s.FG_DIM}  ${hint}${D_RST}`);
	}
	return out;
}

export function renderDiff(p: ResolvedPalette, diff: ParsedDiff, width: number, options: DiffRenderOptions = {}): string[] {
	return width >= SPLIT_MIN_WIDTH ? renderSplit(p, diff, width, options) : renderUnified(p, diff, width, options);
}

/**
 * A pi-tui Component that renders a diff card at the viewport width pi passes
 * to Component.render() — the width the renderCall/renderResult context does
 * not carry. The build closure runs once per distinct width and the result is
 * cached, so terminal resize re-renders the card at the new width for free;
 * invalidate() (called by pi on theme change, or by the caller after shiki
 * warmup / args change) drops the cache.
 */
export class DiffCardComponent implements Component {
	/** Stable key the caller uses to decide whether to reuse the card. */
	diffKey: string | undefined;
	private readonly cache = new Map<number, string[]>();
	/** Palette the cached rows were built with — a theme switch must not reuse them. */
	private cachePalette: ResolvedPalette | undefined;
	constructor(private buildFn: (width: number, palette: ResolvedPalette) => string[]) {}
	/** Replace the render closure (args/header changed) and drop cached lines. */
	setBuild(build: (width: number, palette: ResolvedPalette) => string[]): void {
		this.buildFn = build;
		this.cache.clear();
	}
	render(width: number): string[] {
		const w = Math.max(20, Math.floor(width));
		// A theme switch swaps the active palette without necessarily re-running
		// renderResult (which would setBuild a fresh closure) — invalidate() alone
		// only cleared the width cache, so the card kept re-serving rows in the
		// old theme's colors (AUDIT §5 diff.ts:942). Key the cache on the palette
		// identity and hand the live palette to the build closure.
		if (this.cachePalette !== activeSgrPalette) {
			this.cache.clear();
			this.cachePalette = activeSgrPalette;
		}
		const hit = this.cache.get(w);
		if (hit !== undefined) return hit;
		const lines = this.buildFn(w, activeSgrPalette);
		this.cache.set(w, lines);
		// Width is part of the key, so a resize while the card is visible
		// accumulates one render copy per distinct width; cap the variants.
		if (this.cache.size > 6) this.cache.clear();
		return lines;
	}
	invalidate(): void {
		this.cache.clear();
	}
}

export type { ColorValue };
