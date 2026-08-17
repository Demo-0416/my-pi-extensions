/**
 * Welcome banner — CC's wide two-column box layout with pi branding.
 *
 * Layout (ported from CC's LogoV2 horizontal mode):
 *   ╭─── pi agent vX.Y.Z ─────────────────────────────╮
 *   │   Welcome back!      │ Extensions                │
 *   │      pi logo         │ ext-a, ext-b              │
 *   │   model · cwd        │ Skills                    │
 *   ╰──────────────────────────────────────────────────╯
 * - Title in the top border (accent wordmark + dim version)
 * - Left panel: welcome (bold), pi P+i logo (accent), model/cwd (dim), centered
 * - Vertical divider, right panel: Extensions + Skills feeds (live from disk)
 * - Box width adapts to the terminal; <70 cols falls back to a centered compact box
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SKILLS_MAX_ROWS = 6;
const WIDE_MIN_WIDTH = 70;
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
		const rows = width >= WIDE_MIN_WIDTH ? this.renderWide(width, theme) : this.renderCompact(width, theme);
		const reveal = this.revealWidth;
		if (reveal === undefined) return rows;
		return rows.map((row) => truncateToWidth(row, reveal, ""));
	}

	private border(theme: Theme, text: string): string {
		return theme.fg("accent", text);
	}

	private renderWide(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = (s: string): string => theme.fg("accent", s);
		const bold = (s: string): string => theme.bold(s);

		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";
		const cwd = truncatePath(this.info.cwd, MAX_LEFT_WIDTH - 4);

		// Left panel width (CC: max(content, 20) + 4, capped at 50)
		const leftWidth = Math.min(
			Math.max(visibleWidth(welcome), visibleWidth(cwd), visibleWidth(model), MIN_LEFT_WIDTH) + 4,
			MAX_LEFT_WIDTH,
		);
		const boxWidth = width; // adaptive: full terminal width
		// 7 = 2 borders + 2 paddingX + 1 divider + 2 gaps
		const rightWidth = boxWidth - leftWidth - 7;
		if (rightWidth < RIGHT_MIN_WIDTH) return this.renderCompact(width, theme);

		// Left panel (centered, space-between: welcome / logo / model+cwd)
		const leftRows: string[] = [
			"",
			center(bold(welcome), leftWidth),
			"",
			...PI_LOGO.map((row) => center(accent(row), leftWidth)),
			"",
			center(dim(model), leftWidth),
			center(dim(cwd), leftWidth),
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

	private renderCompact(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = (s: string): string => theme.fg("accent", s);
		const bold = (s: string): string => theme.bold(s);

		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";

		const contentWidth = Math.max(
			...PI_LOGO.map((row) => visibleWidth(row)),
			visibleWidth(welcome),
			visibleWidth(model),
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
