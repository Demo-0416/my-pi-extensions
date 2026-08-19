/**
 * CC six-color palette + SGR discipline.
 *
 * Palette values: DESIGN.md 2.2 six-theme table, sourced from
 * claude-code-main/src/utils/theme.ts (darkTheme/lightTheme/darkDaltonizedTheme/
 * lightDaltonizedTheme/darkAnsiTheme/lightAnsiTheme).
 *
 * SGR discipline ported from dsh-tui/src/render/palette.ts: every span closes
 * only the group it opens — foreground with `39`, background with `49` — so a
 * span nested in a caller's bold/dim never clears it the way a bare ESC[0m would.
 */

export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

function rgb(r: number, g: number, b: number): Rgb {
	return { r, g, b };
}

function hexToRgb(hex: string): Rgb {
	const h = hex.replace("#", "");
	return rgb(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
}

/** Linear blend of two colors; t=0 → a, t=1 → b. */
function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
	const c = (x: number, y: number) => Math.round(x + (y - x) * t);
	return rgb(c(a.r, b.r), c(a.g, b.g), c(a.b, b.b));
}

/** Approx terminal canvas per scheme, for muting fills toward the background. */
const CANVAS_DARK: Rgb = rgb(30, 30, 30); // ≈ claude-code-dark export.pageBg #1E1E1E
const CANVAS_LIGHT: Rgb = rgb(255, 255, 255);

/** A palette value: a 24-bit hex string, or a basic ANSI index (0-15). */
export type ColorValue = string | number;

/** Terminal color depth, mirroring pi Theme's getColorMode() (theme.d.ts:8). */
export type ColorMode = "truecolor" | "256color";

// ---------------------------------------------------------------------------
// hex → xterm-256 downconversion — ported verbatim from pi theme.js:108-173 so
// our downconverted diff chrome lands on exactly the same 256-cube index pi's
// own renderer would pick for the same hex under a 256color terminal.
// ---------------------------------------------------------------------------

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function findClosestCubeIndex(value: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i += 1) {
		const dist = Math.abs(value - (CUBE_VALUES[i] as number));
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i += 1) {
		const dist = Math.abs(gray - (GRAY_VALUES[i] as number));
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbTo256(r: number, g: number, b: number): number {
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx] as number;
	const cubeG = CUBE_VALUES[gIdx] as number;
	const cubeB = CUBE_VALUES[bIdx] as number;
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx] as number;
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;
	if (spread < 10 && grayDist < cubeDist) return grayIndex;
	return cubeIndex;
}

function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}


/** The CC role palette (DESIGN 2.2 table). */
export interface CcPalette {
	claude: ColorValue;
	claudeShimmer: ColorValue;
	autoAccept: ColorValue;
	bashBorder: ColorValue;
	permission: ColorValue;
	planMode: ColorValue;
	promptBorder: ColorValue;
	inactive: ColorValue;
	subtle: ColorValue;
	success: ColorValue;
	error: ColorValue;
	warning: ColorValue;
	diffAddedBg: ColorValue;
	diffRemovedBg: ColorValue;
	diffAddedWord: ColorValue;
	diffRemovedWord: ColorValue;
	userMsgBg: ColorValue;
	selectionBg: ColorValue;
	bashMsgBg: ColorValue;
}

type ThemeKey = "dark" | "light" | "dark-daltonized" | "light-daltonized" | "dark-ansi" | "light-ansi";

const PALETTES: Record<ThemeKey, CcPalette> = {
	dark: {
		claude: "#D77757", claudeShimmer: "#EB9F7F", autoAccept: "#AF87FF", bashBorder: "#FD5DB1",
		permission: "#B1B9F9", planMode: "#48968C", promptBorder: "#888888", inactive: "#999999",
		subtle: "#505050", success: "#4EBA65", error: "#FF6B80", warning: "#FFC107",
		diffAddedBg: "#225C2B", diffRemovedBg: "#7A2936", diffAddedWord: "#38A660", diffRemovedWord: "#B3596B",
		userMsgBg: "#373737", selectionBg: "#264F78", bashMsgBg: "#413C41",
	},
	light: {
		claude: "#D77757", claudeShimmer: "#F59575", autoAccept: "#8700FF", bashBorder: "#FF0087",
		permission: "#5769F7", planMode: "#006666", promptBorder: "#999999", inactive: "#666666",
		subtle: "#AFAFAF", success: "#2C7A39", error: "#AB2B3F", warning: "#966C1E",
		diffAddedBg: "#69DB7C", diffRemovedBg: "#FFA8B4", diffAddedWord: "#2F9D44", diffRemovedWord: "#D1454B",
		userMsgBg: "#F0F0F0", selectionBg: "#B4D5FF", bashMsgBg: "#FAF5FA",
	},
	"dark-daltonized": {
		claude: "#FF9933", claudeShimmer: "#FFB765", autoAccept: "#AF87FF", bashBorder: "#3399FF",
		permission: "#99CCFF", planMode: "#669999", promptBorder: "#888888", inactive: "#999999",
		subtle: "#505050", success: "#3399FF", error: "#FF6666", warning: "#FFCC00",
		diffAddedBg: "#004466", diffRemovedBg: "#660000", diffAddedWord: "#0077B3", diffRemovedWord: "#B30000",
		userMsgBg: "#373737", selectionBg: "#264F78", bashMsgBg: "#413C41",
	},
	"light-daltonized": {
		claude: "#FF9933", claudeShimmer: "#FFB765", autoAccept: "#8700FF", bashBorder: "#0066CC",
		permission: "#3366FF", planMode: "#336666", promptBorder: "#999999", inactive: "#666666",
		subtle: "#AFAFAF", success: "#006699", error: "#CC0000", warning: "#FF9900",
		diffAddedBg: "#99CCFF", diffRemovedBg: "#FFCCCC", diffAddedWord: "#3366CC", diffRemovedWord: "#993333",
		userMsgBg: "#DCDCDC", selectionBg: "#B4D5FF", bashMsgBg: "#FAF5FA",
	},
	"dark-ansi": {
		claude: 9, claudeShimmer: 11, autoAccept: 13, bashBorder: 13,
		permission: 12, planMode: 14, promptBorder: 7, inactive: 7,
		subtle: 7, success: 10, error: 9, warning: 11,
		diffAddedBg: 2, diffRemovedBg: 1, diffAddedWord: 10, diffRemovedWord: 9,
		userMsgBg: 8, selectionBg: 4, bashMsgBg: 0,
	},
	"light-ansi": {
		claude: 9, claudeShimmer: 11, autoAccept: 5, bashBorder: 5,
		permission: 4, planMode: 6, promptBorder: 7, inactive: 8,
		subtle: 8, success: 2, error: 1, warning: 3,
		diffAddedBg: 2, diffRemovedBg: 1, diffAddedWord: 10, diffRemovedWord: 9,
		userMsgBg: 7, selectionBg: 6, bashMsgBg: 15,
	},
};

/** Diff chrome colors (fixed, like dsh-tui BRAND_COLORS), per scheme. */
export interface DiffChrome {
	diffDim: Rgb;
	diffLineNumber: Rgb;
	diffRule: Rgb;
	diffStripe: Rgb;
	diffSafeMuted: Rgb;
	diffAddedFg: Rgb;
	diffRemovedFg: Rgb;
	branch: Rgb;
}

const DIFF_CHROME_DARK: DiffChrome = {
	diffDim: rgb(80, 80, 80),
	diffLineNumber: rgb(100, 100, 100),
	diffRule: rgb(50, 50, 50),
	diffStripe: rgb(40, 40, 40),
	diffSafeMuted: rgb(139, 148, 158),
	diffAddedFg: rgb(100, 180, 120),
	diffRemovedFg: rgb(200, 100, 100),
	branch: rgb(72, 72, 72),
};

const DIFF_CHROME_LIGHT: DiffChrome = {
	diffDim: rgb(175, 175, 175),
	diffLineNumber: rgb(153, 153, 153),
	diffRule: rgb(208, 208, 208),
	diffStripe: rgb(224, 224, 224),
	diffSafeMuted: rgb(139, 148, 158),
	diffAddedFg: rgb(47, 157, 68),
	diffRemovedFg: rgb(209, 69, 75),
	branch: rgb(204, 204, 204),
};

/** Resolve a pi theme name to a CC palette key, or undefined when not a CC theme. */
export function paletteKeyForThemeName(themeName: string | undefined): ThemeKey | undefined {
	if (!themeName) return undefined;
	// Only the shipped CC themes are `claude-code-*`. Requiring the prefix keeps
	// pi's built-in "dark"/"light" (theme.js getBuiltinThemes) — and any bare pi
	// theme named "dark"/"light-…" — out of the CC board: without the prefix
	// gate, "dark".replace(/^claude-code-/,"") is a no-op → "dark" in PALETTES →
	// pi's neutral built-in gets painted with CC's orange palette.
	const prefix = "claude-code-";
	if (!themeName.startsWith(prefix)) return undefined;
	const stripped = themeName.slice(prefix.length);
	// hasOwnProperty, not `in`: `in` walks the prototype chain, so a theme named
	// "claude-code-toString"/"claude-code-constructor" would falsely match.
	if (Object.prototype.hasOwnProperty.call(PALETTES, stripped)) return stripped as ThemeKey;
	return undefined;
}

export function isLightThemeName(themeName: string | undefined): boolean {
	if (!themeName) return false;
	// A CC theme's scheme is authoritative from its key (light*/dark* families).
	const key = paletteKeyForThemeName(themeName);
	if (key !== undefined) return key.startsWith("light");
	// Otherwise match a whole "light" segment (word boundary), not a bare
	// substring — so "moonlight"/"highlight"/"delightful" don't read as light.
	return /(?:^|[-_ ])light(?:[-_ ]|$)/u.test(themeName);
}

export interface ResolvedPalette {
	cc: CcPalette;
	chrome: DiffChrome;
	scheme: "dark" | "light";
	/** True when the palette came from a CC theme (vs. pi-token fallback). */
	isCcTheme: boolean;
	/** Terminal color depth; drives whether fgAnsi/bgAnsi emit 24-bit or 256. */
	colorMode: ColorMode;
}

/**
 * Memo so the same theme name always yields the same ResolvedPalette instance.
 * diff.ts:460 guards its shiki re-warm with `p === activeSgrPalette`; without a
 * stable instance that guard is always false, so every write/edit render would
 * re-run setDiffPalette's full cache re-warm (and, combined with the Map-mutation
 * bug it used to trip, freeze the TUI). A theme switch changes the name, so the
 * guard still fires correctly across real theme changes.
 */
const paletteCache = new Map<string, ResolvedPalette>();

/**
 * Detect the terminal color depth by probing the pi theme's own output.
 *
 * pi's Theme.fg downconverts hex→256 when the terminal is 256color (theme.js
 * fgAnsi:175-191): a downconverted hex is always emitted as `38;5;N` with N≥16
 * (the 6×6×6 cube starts at index 16, grays at 232), whereas an ANSI-index color
 * (0-15) emits `38;5;N` with N<16 and a truecolor hex emits `38;2;…`. So any
 * probe token that comes back as `38;5;≥16` proves 256color mode; a `38;2` proves
 * truecolor. All-ANSI themes give no evidence → default truecolor (harmless: an
 * ANSI index renders identically in both, and *-ansi themes target that case).
 */
function detectColorMode(tokenFg: (token: string) => string | undefined): ColorMode {
	for (const token of ["accent", "error", "success", "warning", "muted", "borderMuted"]) {
		const ansi = tokenFg(token);
		if (!ansi) continue;
		const idx = /\x1b\[[34]8;5;(\d{1,3})m/u.exec(ansi);
		if (idx) {
			if (Number(idx[1]) >= 16) return "256color";
			continue; // ANSI index (<16): ambiguous, keep looking.
		}
		if (/\x1b\[[34]8;2;/u.test(ansi)) return "truecolor";
	}
	return "truecolor";
}

/**
 * The active palette: CC six-color board by theme name; for an unknown theme,
 * derive from pi theme tokens (accent/success/error/…) so the extension still
 * reads correctly under any pi theme.
 */
export function resolvePalette(
	themeName: string | undefined,
	tokenFg: (token: string) => string | undefined,
): ResolvedPalette {
	const colorMode = detectColorMode(tokenFg);
	// Fold the color mode into the cache key: diff.ts seeds the cache at module
	// load with resolvePalette("claude-code-dark", () => undefined) (→ truecolor,
	// no probe evidence); without the mode in the key that entry would poison the
	// real getPalette(theme) call on a 256color terminal (same name → cache hit →
	// stale truecolor palette). Mode is session-constant, so real renders still
	// hit one stable instance — the reference guard in diff.ts:460 keeps holding.
	const cacheKey = `${themeName ?? ""} ${colorMode}`;
	const cached = paletteCache.get(cacheKey);
	if (cached !== undefined) {
		activeColorMode = cached.colorMode;
		return cached;
	}
	const resolved = buildPalette(themeName, tokenFg, colorMode);
	paletteCache.set(cacheKey, resolved);
	activeColorMode = resolved.colorMode;
	return resolved;
}

function buildPalette(
	themeName: string | undefined,
	tokenFg: (token: string) => string | undefined,
	colorMode: ColorMode,
): ResolvedPalette {
	const key = paletteKeyForThemeName(themeName);
	const scheme = isLightThemeName(themeName) ? "light" : "dark";
	if (key !== undefined) {
		return { cc: PALETTES[key], chrome: scheme === "light" ? DIFF_CHROME_LIGHT : DIFF_CHROME_DARK, scheme, isCcTheme: true, colorMode };
	}
	// Fallback: synthesize a palette from the active pi theme's tokens.
	const tok = (token: string, fallback: ColorValue): ColorValue => {
		const ansi = tokenFg(token);
		if (!ansi) return fallback;
		const parsed = parseAnsiRgb(ansi);
		return parsed ? rgbToHex(parsed) : fallback;
	};
	// pi exposes a single foreground color per diff side (toolDiffAdded /
	// toolDiffRemoved). If we map both the full-line bg and the word-level bg to
	// that one token, the word highlight (BG_*_W painted over BG_* in
	// diff.ts:645-646) becomes invisible on any non-CC truecolor theme. CC's
	// model is a muted line wash + a vivid word fill, so derive the pair: the
	// token is the vivid word color, the line bg is that color muted toward the
	// scheme's canvas. Only when the token is unset do we fall back to CC's own
	// already-distinct hardcoded pair.
	const canvas = scheme === "light" ? CANVAS_LIGHT : CANVAS_DARK;
	// Light schemes read better with a lighter wash; dark schemes with a darker one.
	const washT = scheme === "light" ? 0.7 : 0.72;
	const diffPair = (token: string, lineFallback: string, wordFallback: string): { lineBg: ColorValue; word: ColorValue } => {
		const ansi = tokenFg(token);
		const parsed = ansi ? parseAnsiRgb(ansi) : undefined;
		if (!parsed) return { lineBg: lineFallback, word: wordFallback };
		return { lineBg: rgbToHex(mixRgb(parsed, canvas, washT)), word: rgbToHex(parsed) };
	};
	const added = diffPair("toolDiffAdded", "#225C2B", "#38A660");
	const removed = diffPair("toolDiffRemoved", "#7A2936", "#B3596B");
	const fallback: CcPalette = {
		claude: tok("accent", "#D77757"),
		claudeShimmer: tok("customMessageLabel", "#EB9F7F"),
		autoAccept: tok("thinkingHigh", "#AF87FF"),
		bashBorder: tok("bashMode", "#FD5DB1"),
		permission: tok("mdLink", "#B1B9F9"),
		planMode: tok("thinkingLow", "#48968C"),
		promptBorder: tok("borderMuted", "#888888"),
		inactive: tok("muted", "#999999"),
		subtle: tok("dim", "#505050"),
		success: tok("success", "#4EBA65"),
		error: tok("error", "#FF6B80"),
		warning: tok("warning", "#FFC107"),
		diffAddedBg: added.lineBg,
		diffRemovedBg: removed.lineBg,
		diffAddedWord: added.word,
		diffRemovedWord: removed.word,
		userMsgBg: tok("userMessageBg", "#373737"),
		selectionBg: tok("selectedBg", "#264F78"),
		bashMsgBg: tok("toolSuccessBg", "#413C41"),
	};
	return { cc: fallback, chrome: scheme === "light" ? DIFF_CHROME_LIGHT : DIFF_CHROME_DARK, scheme, isCcTheme: false, colorMode };
}

// ---------------------------------------------------------------------------
// SGR helpers (ported from dsh-tui/src/render/palette.ts)
// ---------------------------------------------------------------------------

/** Close a foreground span without touching background or attributes. */
export const FG_DEFAULT = "\x1b[39m";
/** Close a background span without touching foreground or attributes. */
export const BG_DEFAULT = "\x1b[49m";
/** Reset every SGR group. Only for a span that owns the whole line. */
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";

function ansiIndexToFg(code: number): string {
	return code < 8 ? `3${code}` : `9${code - 8}`;
}
function ansiIndexToBg(code: number): string {
	return code < 8 ? `4${code}` : `10${code - 8}`;
}

/**
 * The color depth fgAnsi/bgAnsi encode. resolvePalette keeps this in sync with
 * the active pi theme's getColorMode(); until then it defaults to truecolor.
 * A module-level flag (not a fgAnsi arg) so diff.ts's existing zero-arg call
 * sites don't need to thread the mode through every helper. Session-constant in
 * practice, so no per-render churn. Exposed via setActiveColorMode for tests.
 */
let activeColorMode: ColorMode = "truecolor";

/** Override the color mode used by fgAnsi/bgAnsi. Test/host hook. */
export function setActiveColorMode(mode: ColorMode): void {
	activeColorMode = mode;
}

/** The current color mode fgAnsi/bgAnsi encode hex values in. */
export function getActiveColorMode(): ColorMode {
	return activeColorMode;
}

/** The truecolor / 256-color / basic-ANSI foreground escape for a palette value. */
export function fgAnsi(value: ColorValue): string {
	if (typeof value === "number") return `\x1b[${ansiIndexToFg(value)}m`;
	if (activeColorMode === "256color") return `\x1b[38;5;${hexTo256(value)}m`;
	const { r, g, b } = hexToRgb(value);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** The truecolor / 256-color / basic-ANSI background escape for a palette value. */
export function bgAnsi(value: ColorValue): string {
	if (typeof value === "number") return `\x1b[${ansiIndexToBg(value)}m`;
	if (activeColorMode === "256color") return `\x1b[48;5;${hexTo256(value)}m`;
	const { r, g, b } = hexToRgb(value);
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** Paint text in a foreground, closing only the foreground group. */
export function fg(value: ColorValue, text: string): string {
	return `${fgAnsi(value)}${text}${FG_DEFAULT}`;
}

/** Fill text with a background, closing only the background group. */
export function bg(value: ColorValue, text: string): string {
	return `${bgAnsi(value)}${text}${BG_DEFAULT}`;
}

function attribute(open: string, text: string, close: string): string {
	return `${open}${text}${close}`;
}

/** Bold text, preserving any color the caller applied. */
export function bold(text: string): string {
	return attribute(BOLD, text, "\x1b[22m");
}

/** Dim text, preserving any color the caller applied. */
export function dim(text: string): string {
	return attribute(DIM, text, "\x1b[22m");
}

const ITALIC = "\x1b[3m";

/** Italic text, preserving any color the caller applied. */
export function italic(text: string): string {
	return attribute(ITALIC, text, "\x1b[23m");
}

/** Parse a truecolor foreground/background escape back into channels. */
export function parseAnsiRgb(ansi: string): Rgb | undefined {
	const match = /\x1b\[[34]8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/u.exec(ansi);
	if (match === null) return undefined;
	const [, r = "0", g = "0", b = "0"] = match;
	return rgb(Number(r), Number(g), Number(b));
}

function rgbToHex(c: Rgb): string {
	const h = (n: number) => n.toString(16).padStart(2, "0");
	return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export { rgbToHex };
