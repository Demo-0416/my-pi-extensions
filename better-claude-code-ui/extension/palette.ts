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

/** A palette value: a 24-bit hex string, or a basic ANSI index (0-15). */
export type ColorValue = string | number;

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
		permission: 12, planMode: 14, promptBorder: 15, inactive: 15,
		subtle: 15, success: 10, error: 9, warning: 11,
		diffAddedBg: 2, diffRemovedBg: 1, diffAddedWord: 10, diffRemovedWord: 9,
		userMsgBg: 8, selectionBg: 4, bashMsgBg: 0,
	},
	"light-ansi": {
		claude: 9, claudeShimmer: 11, autoAccept: 13, bashBorder: 13,
		permission: 4, planMode: 6, promptBorder: 15, inactive: 8,
		subtle: 8, success: 2, error: 1, warning: 3,
		diffAddedBg: 2, diffRemovedBg: 1, diffAddedWord: 10, diffRemovedWord: 9,
		userMsgBg: 15, selectionBg: 6, bashMsgBg: 15,
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
	const stripped = themeName.replace(/^claude-code-/, "");
	if (stripped in PALETTES) return stripped as ThemeKey;
	return undefined;
}

export function isLightThemeName(themeName: string | undefined): boolean {
	return !!themeName && themeName.includes("light");
}

export interface ResolvedPalette {
	cc: CcPalette;
	chrome: DiffChrome;
	scheme: "dark" | "light";
	/** True when the palette came from a CC theme (vs. pi-token fallback). */
	isCcTheme: boolean;
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
 * The active palette: CC six-color board by theme name; for an unknown theme,
 * derive from pi theme tokens (accent/success/error/…) so the extension still
 * reads correctly under any pi theme.
 */
export function resolvePalette(
	themeName: string | undefined,
	tokenFg: (token: string) => string | undefined,
): ResolvedPalette {
	const cacheKey = themeName ?? "";
	const cached = paletteCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const resolved = buildPalette(themeName, tokenFg);
	paletteCache.set(cacheKey, resolved);
	return resolved;
}

function buildPalette(
	themeName: string | undefined,
	tokenFg: (token: string) => string | undefined,
): ResolvedPalette {
	const key = paletteKeyForThemeName(themeName);
	const scheme = isLightThemeName(themeName) ? "light" : "dark";
	if (key !== undefined) {
		return { cc: PALETTES[key], chrome: scheme === "light" ? DIFF_CHROME_LIGHT : DIFF_CHROME_DARK, scheme, isCcTheme: true };
	}
	// Fallback: synthesize a palette from the active pi theme's tokens.
	const tok = (token: string, fallback: ColorValue): ColorValue => {
		const ansi = tokenFg(token);
		if (!ansi) return fallback;
		const parsed = parseAnsiRgb(ansi);
		return parsed ? rgbToHex(parsed) : fallback;
	};
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
		diffAddedBg: tok("toolDiffAdded", "#225C2B"),
		diffRemovedBg: tok("toolDiffRemoved", "#7A2936"),
		diffAddedWord: tok("toolDiffAdded", "#38A660"),
		diffRemovedWord: tok("toolDiffRemoved", "#B3596B"),
		userMsgBg: tok("userMessageBg", "#373737"),
		selectionBg: tok("selectedBg", "#264F78"),
		bashMsgBg: tok("toolSuccessBg", "#413C41"),
	};
	return { cc: fallback, chrome: scheme === "light" ? DIFF_CHROME_LIGHT : DIFF_CHROME_DARK, scheme, isCcTheme: false };
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

/** The truecolor (or basic-ANSI) foreground escape for a palette value. */
export function fgAnsi(value: ColorValue): string {
	if (typeof value === "number") return `\x1b[${ansiIndexToFg(value)}m`;
	const { r, g, b } = hexToRgb(value);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** The truecolor (or basic-ANSI) background escape for a palette value. */
export function bgAnsi(value: ColorValue): string {
	if (typeof value === "number") return `\x1b[${ansiIndexToBg(value)}m`;
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
