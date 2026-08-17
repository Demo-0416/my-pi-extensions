/**
 * Welcome banner — pi brand mark (the geometric P+i logo from pi.dev) in a
 * rounded box, with the "pi agent vX.Y.Z" wordmark and a welcome line.
 * Layout follows CC's boxed welcome; the mark and wordmark are pi's own.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const SKILLS_MAX_ROWS = 4;
const MIN_BOXED_WIDTH = 30;

// pi brand mark — the geometric P+i logo (pi.dev/logo-auto.svg), rasterized to
// a 6-row block grid. Monochrome: renders in the terminal's default fg, which
// is white on dark terminals and black on light (matching the SVG's
// prefers-color-scheme swap).
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
		const rows = width < MIN_BOXED_WIDTH ? this.renderPlain(width, theme) : this.renderBoxed(width, theme);
		const reveal = this.revealWidth;
		if (reveal === undefined) return rows;
		return rows.map((row) => truncateToWidth(row, reveal, ""));
	}

	private renderBoxed(width: number, theme: Theme): string[] {
		const dim = (text: string): string => theme.fg("dim", text);
		const wordmark = `${theme.bold("pi agent")} ${dim(`v${VERSION}`)}`;
		const welcome = dim(this.info.welcome ?? "Welcome to pi!");

		// Compact box: fit the logo + wordmark + welcome only (model/cwd live in
		// the status line). This keeps the banner tight like CC's welcome.
		const contentWidth = Math.max(
			...PI_LOGO.map((row) => visibleWidth(row)),
			visibleWidth(`pi agent v${VERSION}`),
			visibleWidth(this.info.welcome ?? "Welcome to pi!"),
		);
		const inner = contentWidth + 2;
		const rule = "─".repeat(inner);
		const pad = (text: string): string => {
			const clipped = truncateToWidth(text, contentWidth, "");
			return `${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}`;
		};

		const rows: string[] = [` ${dim(`╭${rule}╮`)}`];
		for (const artRow of PI_LOGO) {
			rows.push(` ${dim("│")} ${pad(artRow)} ${dim("│")}`);
		}
		rows.push(` ${dim("│")} ${pad(wordmark)} ${dim("│")}`);
		rows.push(` ${dim("│")} ${pad(welcome)} ${dim("│")}`);
		rows.push(` ${dim(`╰${rule}╯`)}`);
		return [...rows, ...this.trailer(width, theme)];
	}

	private renderPlain(width: number, theme: Theme): string[] {
		const usable = Math.max(1, width - 2);
		const dim = (text: string): string => theme.fg("dim", text);
		const rows: string[] = [...PI_LOGO.map((row) => ` ${row}`.trimEnd())];
		rows.push(` ${theme.bold("pi agent")} ${dim(`v${VERSION}`)}`);
		rows.push(` ${dim(this.info.welcome ?? "Welcome to pi!")}`);
		const model = this.info.model();
		if (model !== undefined) rows.push(` ${dim(model)}`);
		rows.push(` ${dim(this.info.cwd)}`);
		return [...rows.map((row) => truncateToWidth(row, usable, "")), ...this.trailer(width, theme)];
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
