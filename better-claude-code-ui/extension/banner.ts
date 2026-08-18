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
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SKILLS_MAX_ROWS = 6;
/** Below this render width the banner degrades to the centered compact box. */
const MIN_BOXED_WIDTH = 40;
/** From this width up the two-column wide box renders. */
const FULL_MIN_WIDTH = 76;
const MAX_LEFT_WIDTH = 50;
const MIN_LEFT_WIDTH = 20;
const RIGHT_MIN_WIDTH = 20;

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

/** Middle-truncate a path: keep first/…/last so the useful tail survives. */
function truncatePath(path: string, maxLen: number): string {
	if (visibleWidth(path) <= maxLen) return path;
	const parts = path.split("/");
	if (parts.length <= 1) return truncateToWidth(path, maxLen, "…");
	const first = parts[0] || "/";
	const last = parts[parts.length - 1] || "";
	const candidate = `${first}/…/${last}`;
	if (visibleWidth(candidate) <= maxLen) return candidate;
	const lastMax = maxLen - visibleWidth(first) - 4;
	if (lastMax > 0) return `${first}/…/${truncateToWidth(last, lastMax, "…")}`;
	return truncateToWidth(path, maxLen, "…");
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Discover skill names from user, agent, and package skill directories. */
function discoverSkills(): string[] {
	const home = homedir();
	const names = new Set<string>();
	const collect = (dir: string): void => {
		if (!existsSync(dir)) return;
		for (const entry of safeReaddir(dir)) {
			if (existsSync(join(dir, entry, "SKILL.md"))) names.add(entry);
		}
	};
	// User + agent skills
	collect(join(home, ".pi", "agent", "skills"));
	collect(join(home, ".agents", "skills"));
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

/** Discover extension names from the user extensions directory. */
function discoverExtensions(): string[] {
	const dir = join(homedir(), ".pi", "agent", "extensions");
	if (!existsSync(dir)) return [];
	return safeReaddir(dir)
		.filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
		.map((f) => f.replace(/\.(ts|js)$/, ""))
		.sort();
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

	constructor(private readonly info: BannerInfo) {}

	setRevealWidth(width: number | undefined): void {
		this.revealWidth = width;
	}

	invalidate(): void {}

	render(width: number, theme: Theme): string[] {
		const rows =
			width >= FULL_MIN_WIDTH
				? this.renderWide(width, theme)
				: width >= MIN_BOXED_WIDTH
					? this.renderBoxed(width, theme)
					: this.renderCompact(width, theme);
		const reveal = this.revealWidth;
		if (reveal === undefined) return rows;
		return rows.map((row) => truncateToWidth(row, reveal, ""));
	}

	private border(theme: Theme, text: string): string {
		return theme.fg("accent", text);
	}

	/** The `resumed <id8> · <title>` identity line, or undefined on a fresh session. */
	private resumedLine(): string | undefined {
		if (this.info.resumed === undefined) return undefined;
		const title = this.info.title();
		return `resumed ${this.info.resumed}` + (title ? ` · ${title}` : "");
	}

	private renderWide(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = (s: string): string => theme.fg("accent", s);
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
		const accent = (s: string): string => theme.fg("accent", s);

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
		const accent = (s: string): string => theme.fg("accent", s);
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
		const accent = (s: string): string => theme.fg("accent", s);
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
		const boxWidth = Math.min(contentWidth + 4, width - 2);
		const inner = boxWidth - 2;
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
			cwd: ctx.cwd.replace(process.env.HOME ?? "", "~"),
			resumed,
			title: () => ctx.sessionManager.getSessionName(),
			skills: discoverSkills(),
			extensions: discoverExtensions(),
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
