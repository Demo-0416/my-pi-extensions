/**
 * Welcome banner — CC's wide two-column box layout with pi branding.
 *
 * Layout (ported from CC's LogoV2 horizontal mode):
 *   ╭─── pi agent vX.Y.Z ─────────────────────────────╮
 *   │   Welcome back!      │ Tips for getting started  │
 *   │      pi logo         │ tip 1                     │
 *   │   model · cwd        │ What's new                │
 *   ╰──────────────────────────────────────────────────╯
 * - Title in the top border (accent wordmark + dim version)
 * - Left panel: welcome (bold), pi P+i logo, model/cwd (dim), centered
 * - Vertical divider, right panel: tips + what's-new feeds
 * - Narrow terminals (<70 cols) fall back to a centered compact box
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SKILLS_MAX_ROWS = 4;
const WIDE_MIN_WIDTH = 70;
const MAX_LEFT_WIDTH = 50;
const MIN_LEFT_WIDTH = 20;
const RIGHT_MIN_WIDTH = 20;
const BOX_MAX_WIDTH = 100;

// pi brand mark — the geometric P+i logo (pi.dev/logo-auto.svg), 6-row grid.
const PI_LOGO: readonly string[] = [
	"██████████    ",
	"████  ████    ",
	"████  ████    ",
	"████████  ████",
	"████      ████",
	"████      ████",
];

const TIPS: readonly string[] = [
	"Run /help to browse commands",
	"Type @ to reference files",
	"Use /model to switch models",
];

const WHATS_NEW: readonly string[] = [
	"Subagents for parallel work",
	"Custom themes & extensions",
];

export interface BannerInfo {
	model: () => string | undefined;
	cwd: string;
	resumed: string | undefined;
	title: () => string | undefined;
	welcome?: string;
	skills?: readonly string[];
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
	const lastMax = maxLen - visibleWidth(first) - 4; // "/…/" + trunc
	if (lastMax > 0) return `${first}/…/${truncateToWidth(last, lastMax, "…")}`;
	return truncateToWidth(path, maxLen, "…");
}

function packSkillNames(names: readonly string[], width: number, maxRows = SKILLS_MAX_ROWS): string[] {
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
		const boxWidth = Math.min(width, BOX_MAX_WIDTH);
		// 7 = 2 borders + 2 paddingX + 1 divider + 2 gaps
		const rightWidth = boxWidth - leftWidth - 7;
		if (rightWidth < RIGHT_MIN_WIDTH) return this.renderCompact(width, theme);

		// Left panel (centered, space-between: welcome / logo / model+cwd)
		const leftRows: string[] = [
			"",
			center(bold(welcome), leftWidth),
			"",
			...PI_LOGO.map((row) => center(row, leftWidth)),
			"",
			center(dim(model), leftWidth),
			center(dim(cwd), leftWidth),
		];

		// Right panel (feeds, accent divider between feeds — matches CC FeedColumn)
		const rightRows: string[] = [
			bold(accent("Tips for getting started")),
			...TIPS.map((t) => truncateToWidth(t, rightWidth, "")),
			accent("─".repeat(rightWidth)),
			bold(accent("What's new")),
			...WHATS_NEW.map((t) => truncateToWidth(t, rightWidth, "")),
		];

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
		return [...rows, ...this.trailer(width, theme)];
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
			rows.push(`${this.border(theme, "│")} ${center(artRow, inner)} ${this.border(theme, "│")}`);
		}
		if (model) rows.push(`${this.border(theme, "│")} ${center(dim(model), inner)} ${this.border(theme, "│")}`);
		rows.push(`${this.border(theme, "│")} ${center(dim(cwd), inner)} ${this.border(theme, "│")}`);
		rows.push(this.border(theme, `╰${"─".repeat(boxWidth - 2)}╯`));
		return [...rows, ...this.trailer(width, theme)];
	}

	private trailer(width: number, theme: Theme): string[] {
		const usable = Math.max(1, width - 2);
		const names = this.info.skills ?? [];
		const lines =
			names.length === 0
				? []
				: [
						"",
						theme.bold(theme.fg("dim", "[Skills]")),
						...packSkillNames(names, usable).map((row) => truncateToWidth(theme.fg("dim", row), usable, "")),
					];
		return lines.map((line) => (line === "" ? "" : ` ${line}`));
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
