/**
 * Welcome banner — CC's welcome box shapes with pi branding, three width tiers
 * (ported from dsh-tui transcript.ts renderFull/renderBoxed/renderPlain):
 *
 * Wide (>=76): two-column box, wordmark in the top border
 *   ╭─── pi agent vX.Y.Z ─────────────────────────────╮
 *   │   Welcome back!      │ Extensions                │
 *   │      pi logo         │ ext-a, ext-b              │
 *   │   model · cwd        │ Skills                    │
 *   ╰──────────────────────────────────────────────────╯
 * Boxed (40..75): single rounded box hugging its content — logo left,
 * identity stack right, feeds as a borderless trailer under the box
 *   ╭──────────────────────────────╮
 *   │ ██████████     pi agent vX.Y.Z│
 *   │ ████  ████     model          │
 *   │ ████  ████     ~/cwd          │
 *   │ ████████  ████ resumed 85d19568│
 *   ╰──────────────────────────────╯
 *    [Extensions]
 *    ext-a, ext-b
 * Compact (<40): centered single-column box.
 * On resume/fork the session id (first 8 chars) + session name render as a
 * dim `resumed <id> · <title>` identity line (CC shows the session on resume).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { tildeHome } from "./status-line.js";
import { fg as paletteFg, resolvePalette } from "./palette.js";

const SKILLS_MAX_ROWS = 6;
/** Below this render width the banner degrades to the centered compact box. */
const MIN_BOXED_WIDTH = 40;
/** From this width up the two-column wide box renders. */
const FULL_MIN_WIDTH = 76;
const MAX_LEFT_WIDTH = 50;
const MIN_LEFT_WIDTH = 20;
const RIGHT_MIN_WIDTH = 20;

/** CC brand orange for the banner chrome — the theme's `accent` maps to CC's
 *  suggestion blue (menus/selectors), so the banner resolves the CC palette
 *  directly (memoized per theme name). */
function ccAccent(theme: Theme): (s: string) => string {
	const pal = resolvePalette(theme.name, (token) => {
		try {
			return theme.fg(token as never, "x");
		} catch {
			return undefined;
		}
	});
	return (s) => paletteFg(pal.cc.claude, s);
}

// pi brand mark — the geometric P+i logo (pi.dev/logo-auto.svg), 6-row grid.
const PI_LOGO: readonly string[] = [
	"██████████    ",
	"████  ████    ",
	"████  ████    ",
	"████████  ████",
	"████      ████",
	"████      ████",
];

export interface BannerInfo {
	model: () => string | undefined;
	cwd: string;
	resumed: string | undefined;
	title: () => string | undefined;
	welcome?: string;
	skills?: readonly string[];
	extensions?: readonly string[];
	/**
	 * Whether to show the full boxed banner. CC only shows the boxed two-column
	 * LogoV2 when there are new release notes or it's the first time in this
	 * project (`hasReleaseNotes || showOnboarding`, LogoV2.tsx:178); otherwise
	 * the default startup is the borderless 3-line CondensedLogo. Default false.
	 */
	full?: boolean;
}

function center(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "");
	const left = Math.floor((width - w) / 2);
	return " ".repeat(left) + text + " ".repeat(width - w - left);
}

function padRight(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "");
	return text + " ".repeat(width - w);
}

/** Middle-truncate a path: keep first/…/last so the useful tail survives.
 * Mirrors CC logoV2Utils.ts:175 `<first>/…/<last>` — an absolute path keeps a
 * single leading `/` (first === "", not `//`), and a trailing slash is dropped
 * so `last` stays the real tail segment instead of "" (AUDIT §5 banner.ts:79). */
export function truncatePath(path: string, maxLen: number): string {
	if (visibleWidth(path) <= maxLen) return path;
	const sep = "/";
	const ellipsis = "…";
	// Drop trailing separators so `last` is the real tail, not "" → `…/`.
	const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
	const parts = trimmed.split(sep);
	if (parts.length <= 1) return truncateToWidth(trimmed, maxLen, ellipsis);
	const first = parts[0]; // "" when the path is absolute (leading slash)
	const last = parts[parts.length - 1] || "";
	// `<first>/…/<last>`; for an absolute path first is "" so this is `/…/last`
	// (one leading slash), and for `~/a/b` it is `~/…/b`.
	const candidate = `${first}${sep}${ellipsis}${sep}${last}`;
	if (visibleWidth(candidate) <= maxLen) return candidate;
	// Not enough room even for that: keep the head + a truncated tail.
	const head = `${first}${sep}${ellipsis}${sep}`;
	const lastMax = maxLen - visibleWidth(head);
	if (lastMax > 0) return `${head}${truncateToWidth(last, lastMax, ellipsis)}`;
	return truncateToWidth(trimmed, maxLen, ellipsis);
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Discover skill names from user, agent, project, and package skill directories. */
function discoverSkills(cwd: string): string[] {
	const home = homedir();
	const names = new Set<string>();
	const collect = (dir: string): void => {
		if (!existsSync(dir)) return;
		for (const entry of safeReaddir(dir)) {
			if (existsSync(join(dir, entry, "SKILL.md"))) names.add(entry);
		}
	};
	// User + agent + project skills (pi resource-loader scans agentDir/skills
	// and <cwd>/.pi/skills).
	collect(join(home, ".pi", "agent", "skills"));
	collect(join(home, ".agents", "skills"));
	collect(join(cwd, ".pi", "skills"));
	// Package skills: node_modules/<pkg>/skills/<skill>/ and @<scope>/<pkg>/skills/<skill>/
	const nm = join(home, ".pi", "agent", "npm", "node_modules");
	if (existsSync(nm)) {
		for (const pkg of safeReaddir(nm)) {
			if (pkg.startsWith(".")) continue;
			const pkgPath = join(nm, pkg);
			if (pkg.startsWith("@")) {
				for (const sub of safeReaddir(pkgPath)) {
					collect(join(pkgPath, sub, "skills"));
				}
			} else {
				collect(join(pkgPath, "skills"));
			}
		}
	}
	return [...names].sort();
}

/** Path segments that carry no identity when naming an extension entry. */
const GENERIC_SEGMENTS = new Set(["index", "main", "extension", "extensions", "src", "dist", "lib", ".", ".."]);

/** Human name for a settings entry: `npm:pi-web-access` → pi-web-access,
 *  `/…/better-claude-code-ui/extension/index.ts` → better-claude-code-ui. */
export function extensionDisplayName(entry: string): string {
	const spec = entry.replace(/^(npm|git|file):/, "");
	const segments = spec.split("/").filter(Boolean);
	for (let i = segments.length - 1; i >= 0; i--) {
		const base = segments[i]!.replace(/\.(ts|js)$/, "");
		if (!GENERIC_SEGMENTS.has(base)) return base;
	}
	return spec;
}

function readSettingsArray(path: string, key: string): string[] {
	try {
		if (!existsSync(path)) return [];
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const v = raw[key];
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Discover extension names the way pi actually loads them: the drop-in
 * `~/.pi/agent/extensions/` dir PLUS the `extensions` (path entries) and
 * `packages` (npm:/git: specs) arrays of the global, agent, and project
 * settings.json. The old dir-only scan missed every path-configured extension
 * (this one included) and all package-provided ones.
 */
function discoverExtensions(cwd: string): string[] {
	const names = new Set<string>();
	const dir = join(homedir(), ".pi", "agent", "extensions");
	if (existsSync(dir)) {
		for (const f of safeReaddir(dir)) {
			if (f.endsWith(".ts") || f.endsWith(".js")) names.add(f.replace(/\.(ts|js)$/, ""));
		}
	}
	const settingsFiles = [
		join(homedir(), ".pi", "settings.json"),
		join(homedir(), ".pi", "agent", "settings.json"),
		join(cwd, ".pi", "settings.json"),
	];
	// Two passes: `-`/`!` entries are exclusion patterns that apply to OTHER
	// entries (pi package-manager semantics), not just themselves — collect
	// them first, then filter the display set.
	const excluded = new Set<string>();
	const candidates: string[] = [];
	for (const file of settingsFiles) {
		for (const entry of [...readSettingsArray(file, "extensions"), ...readSettingsArray(file, "packages")]) {
			if (entry.startsWith("-") || entry.startsWith("!")) {
				excluded.add(extensionDisplayName(entry.slice(1)));
				continue;
			}
			candidates.push(entry.replace(/^\+/, ""));
		}
	}
	for (const entry of candidates) {
		const name = extensionDisplayName(entry);
		if (!excluded.has(name)) names.add(name);
	}
	for (const name of excluded) names.delete(name);
	return [...names].sort();
}

/** Pack names into comma-separated rows that fit `width`, with a "+N more" tail. */
function packNames(names: readonly string[], width: number, maxRows: number): string[] {
	if (names.length === 0) return [];
	const joined = (parts: readonly string[]): string => parts.join(", ");
	const rows: string[] = [];
	let row: string[] = [];
	let placed = 0;
	for (const name of names) {
		if (row.length === 0 || visibleWidth(joined([...row, name])) <= width) {
			row.push(name);
			placed += 1;
			continue;
		}
		if (rows.length + 1 === maxRows) break;
		rows.push(joined(row));
		row = [name];
		placed += 1;
	}
	let hidden = names.length - placed;
	if (hidden > 0) {
		while (row.length > 0 && visibleWidth(joined([...row, `+${hidden} more`])) > width) {
			row.pop();
			hidden += 1;
		}
		row.push(`+${hidden} more`);
	}
	rows.push(joined(row));
	return rows;
}

export class BannerComponent {
	private revealWidth: number | undefined;
	// Render cache: the header is re-rendered every frame by the TUI (tui.js
	// LayoutContainer.render iterates children with no caching), and the box is
	// static once the session is up — recomputing borders/packNames/centering
	// each frame during streaming is pure waste. Cache keyed on every input that
	// affects output; invalidate() drops it (AUDIT §5 banner.ts:176).
	private cacheKey: string | undefined;
	private cacheTheme: Theme | undefined;
	private cacheLines: string[] | undefined;

	constructor(private readonly info: BannerInfo) {}

	setRevealWidth(width: number | undefined): void {
		if (width === this.revealWidth) return;
		this.revealWidth = width;
		this.invalidate();
	}

	invalidate(): void {
		this.cacheKey = undefined;
		this.cacheTheme = undefined;
		this.cacheLines = undefined;
	}

	render(width: number, theme: Theme): string[] {
		// Key on every input the output depends on. model/title/resumed are
		// dynamic getters; a mode/session change flips the key and recomputes.
		const key = [
			width,
			this.revealWidth ?? -1,
			typeof theme.getColorMode === "function" ? theme.getColorMode() : "",
			this.info.model() ?? "",
			this.info.title() ?? "",
			this.info.resumed ?? "",
		].join(" ");
		if (this.cacheLines && this.cacheKey === key && this.cacheTheme === theme) {
			return this.cacheLines;
		}
		// Default startup is the borderless condensed logo; the boxed banner is
		// reserved for new-version / first-project starts (info.full), mirroring
		// CC LogoV2.tsx:178 `hasReleaseNotes || showOnboarding` (AUDIT §6 P1).
		const rows = !this.info.full
			? this.renderCondensed(width, theme)
			: width >= FULL_MIN_WIDTH
				? this.renderWide(width, theme)
				: width >= MIN_BOXED_WIDTH
					? this.renderBoxed(width, theme)
					: this.renderCompact(width, theme);
		const reveal = this.revealWidth;
		const out = reveal === undefined ? rows : rows.map((row) => truncateToWidth(row, reveal, ""));
		this.cacheKey = key;
		this.cacheTheme = theme;
		this.cacheLines = out;
		return out;
	}

	private border(theme: Theme, text: string): string {
		return ccAccent(theme)(text);
	}

	/** The `resumed <id8> · <title>` identity line, or undefined on a fresh session. */
	private resumedLine(): string | undefined {
		if (this.info.resumed === undefined) return undefined;
		const title = this.info.title();
		return `resumed ${this.info.resumed}` + (title ? ` · ${title}` : "");
	}

	/**
	 * The default startup logo: a borderless stack, `Clawd`-style mark left of a
	 * 3-line info column (`pi agent vX.Y.Z` / model / cwd), plus the resumed line
	 * when resuming. Mirrors CC CondensedLogo.tsx (row layout, gap 2, dim info,
	 * bold name + dim version) — no box chrome (AUDIT §6 P1 CondensedLogo).
	 */
	private renderCondensed(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);
		const bold = (s: string): string => theme.bold(s);

		const logoWidth = Math.max(...PI_LOGO.map((row) => visibleWidth(row)));
		// Too narrow to sit the info column beside the mark → borderless centered
		// stack (same degradation as the compact box, no overflow).
		if (width < logoWidth + 4 + 8) return this.renderCompactPlain(width, theme);
		// CC CondensedLogo.tsx:59 — text width accounts for mark + gap + padding.
		const textWidth = Math.max(width - logoWidth - 4, 20);
		const model = this.info.model() ?? "";
		const cwd = truncatePath(this.info.cwd, textWidth);
		const resumed = this.resumedLine();

		// Info column: name+version, model, cwd, (resumed).
		const info: string[] = [
			`${bold("pi agent")} ${dim(`v${VERSION}`)}`,
			...(model ? [dim(truncateToWidth(model, textWidth, "…"))] : []),
			dim(cwd),
			...(resumed ? [dim(truncateToWidth(resumed, textWidth, "…"))] : []),
		];

		// Lay the mark alongside the info column, top-aligned, gap of 2 spaces.
		const height = Math.max(PI_LOGO.length, info.length);
		const rows: string[] = [];
		for (let i = 0; i < height; i++) {
			const art = PI_LOGO[i] ?? " ".repeat(logoWidth);
			const line = i < info.length ? info[i] : "";
			rows.push(truncateToWidth(` ${accent(art)}  ${line}`, Math.max(1, width), ""));
		}
		return rows;
	}

	private renderWide(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);
		const bold = (s: string): string => theme.bold(s);

		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";
		const cwd = truncatePath(this.info.cwd, MAX_LEFT_WIDTH - 4);
		const resumed = this.resumedLine();

		// Left panel width (CC: max(content, 20) + 4, capped at 50)
		const leftWidth = Math.min(
			Math.max(visibleWidth(welcome), visibleWidth(cwd), visibleWidth(model), visibleWidth(resumed ?? ""), MIN_LEFT_WIDTH) + 4,
			MAX_LEFT_WIDTH,
		);
		const boxWidth = width; // adaptive: full terminal width
		// 7 = 2 borders + 2 paddingX + 1 divider + 2 gaps
		const rightWidth = boxWidth - leftWidth - 7;
		// dsh-tui transcript.ts:499-501 — fall back to renderBoxed, not compact.
		if (rightWidth < RIGHT_MIN_WIDTH) return this.renderBoxed(width, theme);

		// Identity lines share one left edge (dsh-tui transcript.ts:583-586):
		// individually centering lines of very different length gives a ragged
		// edge that reads as misalignment.
		const identity: string[] = [
			...(model ? [dim(model)] : []),
			dim(cwd),
			...(resumed ? [dim(resumed)] : []),
		];
		const identityLead = Math.max(
			0,
			Math.floor((leftWidth - Math.max(...identity.map((l) => visibleWidth(l)), 0)) / 2),
		);

		// Left panel (centered, space-between: welcome / logo / identity stack)
		const leftRows: string[] = [
			"",
			center(bold(welcome), leftWidth),
			"",
			...PI_LOGO.map((row) => center(accent(row), leftWidth)),
			"",
			...identity.map((l) => " ".repeat(identityLead) + truncateToWidth(l, leftWidth - 2, "")),
		];

		// Right panel: Extensions + Skills feeds (live from disk)
		const rightRows: string[] = [];
		const exts = this.info.extensions ?? [];
		const skills = this.info.skills ?? [];
		if (exts.length > 0) {
			rightRows.push(bold(accent("Extensions")));
			for (const line of packNames(exts, rightWidth, 2)) {
				rightRows.push(truncateToWidth(line, rightWidth, ""));
			}
		}
		if (skills.length > 0) {
			if (rightRows.length > 0) rightRows.push(accent("─".repeat(rightWidth)));
			rightRows.push(bold(accent("Skills")));
			for (const line of packNames(skills, rightWidth, SKILLS_MAX_ROWS)) {
				rightRows.push(truncateToWidth(line, rightWidth, ""));
			}
		}

		const height = Math.max(leftRows.length, rightRows.length);
		const rows: string[] = [];

		// Top border with embedded title: ╭─── pi agent vX.Y.Z ──fill──╮
		const titlePlain = `pi agent v${VERSION}`;
		const titleColored = `${accent("pi agent")} ${dim(`v${VERSION}`)}`;
		const fillLen = boxWidth - 1 - 3 - 1 - visibleWidth(titlePlain) - 1 - 1;
		rows.push(
			`${this.border(theme, "╭───")} ${titleColored} ${this.border(theme, "─".repeat(Math.max(0, fillLen)) + "╮")}`,
		);

		// Content rows: │ left │ right │
		for (let i = 0; i < height; i++) {
			const left = i < leftRows.length ? leftRows[i] : "";
			const right = i < rightRows.length ? rightRows[i] : "";
			rows.push(
				`${this.border(theme, "│")} ${padRight(left, leftWidth)} ${this.border(theme, "│")} ${padRight(right, rightWidth)} ${this.border(theme, "│")}`,
			);
		}

		// Bottom border
		rows.push(this.border(theme, `╰${"─".repeat(boxWidth - 2)}╯`));
		return rows;
	}

	/**
	 * Boxed tier (40..75 cols, dsh-tui transcript.ts:642-667 renderBoxed): a
	 * single rounded box that hugs its content — the pi logo left, the identity
	 * stack right — with the Extensions/Skills feeds as a borderless trailer
	 * under the box.
	 */
	private renderBoxed(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);

		const model = this.info.model() ?? "";
		const cwd = truncatePath(this.info.cwd, MAX_LEFT_WIDTH - 4);
		const resumed = this.resumedLine();

		// Identity stack right of the logo; the wordmark leads (dsh-tui: wordmark
		// is the first in-box line, not spliced into the border).
		const lines: string[] = [
			`${accent("pi agent")} ${dim(`v${VERSION}`)}`,
			...(model ? [dim(model)] : []),
			dim(cwd),
			...(resumed ? [dim(resumed)] : []),
		];
		const logoWidth = Math.max(...PI_LOGO.map((row) => visibleWidth(row)));
		// Chrome beyond logo + text: 2 borders + 2 padding + 2 gap.
		const overhead = logoWidth + 6;
		// dsh-tui transcript.ts:651-654 — the box hugs its widest identity line
		// (a badge, not a layout region): no MIN_LEFT_WIDTH floor.
		const textWidth = Math.min(
			Math.max(...lines.map((line) => visibleWidth(line))),
			Math.max(1, width - overhead),
		);
		const boxWidth = overhead + textWidth;

		const rows: string[] = [this.border(theme, `╭${"─".repeat(boxWidth - 2)}╮`)];
		const height = Math.max(PI_LOGO.length, lines.length);
		for (let i = 0; i < height; i++) {
			const art = PI_LOGO[i] ?? " ".repeat(logoWidth);
			const text = i < lines.length ? truncateToWidth(lines[i], textWidth, "") : "";
			const pad = " ".repeat(Math.max(0, textWidth - visibleWidth(text)));
			rows.push(
				`${this.border(theme, "│")} ${accent(art)}  ${text}${pad} ${this.border(theme, "│")}`,
			);
		}
		rows.push(this.border(theme, `╰${"─".repeat(boxWidth - 2)}╯`));
		rows.push(...this.renderBoxedTrailer(width, theme));
		return rows;
	}

	/** Borderless welcome + Extensions/Skills feeds under the boxed banner, indented 1. */
	private renderBoxedTrailer(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);
		const bold = (s: string): string => theme.bold(s);
		const usable = Math.max(1, width - 2);
		// dsh-tui transcript.ts:702-714 — the trailer opens with the welcome
		// line, same source as the wide/compact tiers.
		const rows: string[] = [` ${dim(this.info.welcome ?? "Welcome back!")}`];
		const section = (label: string, names: readonly string[], maxRows: number): void => {
			if (names.length === 0) return;
			rows.push("");
			rows.push(` ${bold(accent(label))}`);
			for (const line of packNames(names, usable, maxRows)) {
				rows.push(` ${dim(truncateToWidth(line, usable, ""))}`);
			}
		};
		section("Extensions", this.info.extensions ?? [], 2);
		section("Skills", this.info.skills ?? [], SKILLS_MAX_ROWS);
		return rows;
	}

	private renderCompact(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);
		const bold = (s: string): string => theme.bold(s);

		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";
		const resumed = this.resumedLine();

		const contentWidth = Math.max(
			...PI_LOGO.map((row) => visibleWidth(row)),
			visibleWidth(welcome),
			visibleWidth(model),
			visibleWidth(resumed ?? ""),
			MIN_LEFT_WIDTH,
		);
		const boxWidth = Math.min(contentWidth + 4, Math.max(0, width - 2));
		// The titled top border `╭── pi agent ──╮` is a fixed 14-col scaffold
		// (3 + 1 + 8 + 1 + fill + 1); below 14 cols its fill length goes negative
		// (`"─".repeat(负数)` → RangeError) and the border overflows the box.
		// On a terminal too narrow to hold the box, degrade to a borderless
		// centered stack (CC's progressive narrow-terminal degradation) rather
		// than crash (AUDIT §5 banner.ts:392).
		if (boxWidth < 14) return this.renderCompactPlain(width, theme);
		const inner = boxWidth - 4;
		const cwd = truncatePath(this.info.cwd, inner);

		const rows: string[] = [];
		// Top border with compact title: ╭── pi agent ──╮
		const titlePlain = "pi agent";
		const fillLen = boxWidth - 1 - 2 - 1 - visibleWidth(titlePlain) - 1 - 1;
		rows.push(
			`${this.border(theme, "╭──")} ${accent(titlePlain)} ${this.border(theme, "─".repeat(Math.max(0, fillLen)) + "╮")}`,
		);
		rows.push(`${this.border(theme, "│")} ${center(bold(welcome), inner)} ${this.border(theme, "│")}`);
		for (const artRow of PI_LOGO) {
			rows.push(`${this.border(theme, "│")} ${center(accent(artRow), inner)} ${this.border(theme, "│")}`);
		}
		if (model) rows.push(`${this.border(theme, "│")} ${center(dim(model), inner)} ${this.border(theme, "│")}`);
		rows.push(`${this.border(theme, "│")} ${center(dim(cwd), inner)} ${this.border(theme, "│")}`);
		if (resumed) rows.push(`${this.border(theme, "│")} ${center(dim(resumed), inner)} ${this.border(theme, "│")}`);
		rows.push(this.border(theme, `╰${"─".repeat(boxWidth - 2)}╯`));
		return rows;
	}

	/**
	 * Borderless fallback for terminals too narrow to hold the compact box
	 * (< 14 cols, where the titled top border can't fit). A centered
	 * title/welcome/cwd stack clamped to the available width — no box chrome,
	 * so no `"─".repeat(负数)` (AUDIT §5 banner.ts:392).
	 */
	private renderCompactPlain(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);
		const bold = (s: string): string => theme.bold(s);
		const w = Math.max(1, width);
		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";
		const resumed = this.resumedLine();
		const cwd = truncatePath(this.info.cwd, w);
		const rows: string[] = [center(accent("pi agent"), w), center(bold(welcome), w)];
		if (model) rows.push(center(dim(model), w));
		rows.push(center(dim(cwd), w));
		if (resumed) rows.push(center(dim(resumed), w));
		return rows;
	}
}

/** Remember at most this many recently-seen project cwds in the banner state. */
const SEEN_PROJECTS_MAX = 50;

/**
 * CC LogoV2.tsx:178 shows the boxed logo only on `hasReleaseNotes ||
 * showOnboarding` — i.e. a new version or the first time in this project.
 * Mirror that with a small state file: full banner when the recorded pi
 * version changed or this cwd hasn't been seen, condensed otherwise. Any
 * fs error degrades to condensed (never blocks startup).
 */
function shouldShowFullBanner(cwd: string): boolean {
	const stateDir = join(homedir(), ".pi", "agent");
	const stateFile = join(stateDir, "cc-ui-banner.json");
	let state: { version?: string; projects?: string[] } = {};
	try {
		state = JSON.parse(readFileSync(stateFile, "utf8")) as typeof state;
	} catch {
		// Missing/corrupt state → treat as first run.
	}
	const projects = Array.isArray(state.projects) ? state.projects.filter((p) => typeof p === "string") : [];
	const full = state.version !== VERSION || !projects.includes(cwd);
	try {
		const next = [cwd, ...projects.filter((p) => p !== cwd)].slice(0, SEEN_PROJECTS_MAX);
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(stateFile, JSON.stringify({ version: VERSION, projects: next }));
	} catch {
		// Unwritable state dir: just show whatever `full` resolved to this time.
	}
	return full;
}

export function registerBanner(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const resumed =
			event.reason === "resume" || event.reason === "fork"
				? (ctx.sessionManager.getSessionId() ?? "").slice(0, 8) || undefined
				: undefined;
		const info: BannerInfo = {
			model: () => ctx.model?.id,
			// tildeHome guards the HOME-unset / non-prefix cases (§5 status-line.ts:66
			// fixed the same bare-replace bug; reuse its guarded helper).
			cwd: tildeHome(ctx.cwd),
			resumed,
			title: () => ctx.sessionManager.getSessionName(),
			skills: discoverSkills(ctx.cwd),
			extensions: discoverExtensions(ctx.cwd),
			full: shouldShowFullBanner(ctx.cwd),
		};
		const banner = new BannerComponent(info);
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return banner.render(width, theme);
			},
			invalidate() {
				banner.invalidate();
			},
		}));
	});
}
