/**
 * Welcome box — ported from dsh-tui's HeaderComponent (itself "in the shape of
 * Claude Code's welcome box"), rebranded to pi ✻. Three width tiers:
 *   ≥76 cols  two-column box (mascot + identity | skills) — needs a skill list
 *   40-75 cols bordered badge box (mascot + identity, skills below)
 *   <40 cols  borderless plain stack
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const SKILLS_MAX_ROWS = 4;
const MIN_BOXED_WIDTH = 40;
const FULL_MIN_WIDTH = 76;
const FULL_LEFT_MAX = 44;
const FULL_RIGHT_MIN = 24;

// CC teardrop-asterisk mark, replacing dsh-tui's whale.
const ART_SMALL = [" ✻✻✻ ", "✻✻✻✻✻", " ✻✻✻ "] as const;
const ART_SMALL_WIDTH = 5;
const ART_LARGE = ["  ✻✻✻  ", "✻✻✻✻✻✻✻", "  ✻✻✻  "] as const;
const ART_LARGE_WIDTH = 7;

const BOX_INNER_CHROME = 1 + ART_SMALL_WIDTH + 2 + 1;
const BOX_OVERHEAD = BOX_INNER_CHROME + 3;

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
		const rows =
			width < MIN_BOXED_WIDTH
				? this.renderPlain(width, theme)
				: (width >= FULL_MIN_WIDTH ? this.renderFull(width, theme) : undefined) ?? this.renderBoxed(width, theme);
		const reveal = this.revealWidth;
		if (reveal === undefined) return rows;
		return rows.map((row) => truncateToWidth(row, reveal, ""));
	}

	private wordmark(theme: Theme): string {
		const name = `${theme.bold("pi")} ${theme.fg("accent", "✻")}`;
		return `${name} ${theme.fg("dim", `v${VERSION}`)}`;
	}

	private resumedLine(theme: Theme): string | undefined {
		if (this.info.resumed === undefined) return undefined;
		const title = this.info.title();
		const line = theme.fg("dim", `resumed ${this.info.resumed}`);
		return title === undefined ? line : `${line}${theme.fg("dim", ` · ${title}`)}`;
	}

	private renderFull(width: number, theme: Theme): string[] | undefined {
		if (this.info.skills === undefined) return undefined;
		const dim = (text: string): string => theme.fg("dim", text);
		const inner = width - 3;
		const model = this.info.model();
		const resumed = this.resumedLine(theme);
		const identity = [
			...(model === undefined ? [] : [model]),
			this.info.cwd,
			...(resumed === undefined ? [] : [resumed]),
		];
		const welcome = this.info.welcome;
		const leftWidth = Math.min(
			Math.max(
				ART_LARGE_WIDTH + 6,
				...[...identity, ...(welcome === undefined ? [] : [welcome])].map((line) => visibleWidth(line) + 4),
			),
			FULL_LEFT_MAX,
			inner - FULL_RIGHT_MIN - 1,
		);
		const rightWidth = inner - leftWidth - 1;
		if (leftWidth < ART_LARGE_WIDTH + 2) return undefined;
		const centered = (text: string): string => {
			const clipped = truncateToWidth(text, leftWidth - 2, "");
			const lead = Math.floor((leftWidth - visibleWidth(clipped)) / 2);
			return `${" ".repeat(lead)}${clipped}`;
		};
		const identityLead = " ".repeat(
			Math.max(
				1,
				Math.floor(
					(leftWidth - Math.min(Math.max(...identity.map((line) => visibleWidth(line))), leftWidth - 2)) / 2,
				),
			),
		);
		const left = [
			"",
			...(welcome === undefined ? [] : [centered(theme.bold(welcome)), ""]),
			...ART_LARGE.map((row) => centered(theme.fg("accent", row))),
			"",
			...identity.map((line) => `${identityLead}${dim(truncateToWidth(line, leftWidth - 2, ""))}`),
		];
		const section = (label: string, names: readonly string[]): string[] =>
			names.length === 0
				? []
				: [` ${theme.bold(theme.fg("accent", label))}`, ...packSkillNames(names, rightWidth - 2).map((row) => ` ${dim(row)}`)];
		const skillsSection = section("[Skills]", this.info.skills);
		const right = ["", ...skillsSection, ""];
		const cell = (text: string, cellWidth: number): string => {
			const clipped = truncateToWidth(text, cellWidth, "");
			return `${clipped}${" ".repeat(Math.max(0, cellWidth - visibleWidth(clipped)))}`;
		};
		const wordmark = this.wordmark(theme);
		const rule = inner - visibleWidth(wordmark) - 3;
		const rows = [
			rule < 1
				? ` ${dim(`╭${"─".repeat(inner)}╮`)}`
				: ` ${dim("╭─")} ${wordmark} ${dim(`${"─".repeat(rule)}╮`)}`,
		];
		const height = Math.max(left.length, right.length);
		const drop = Math.floor((height - left.length) / 2);
		for (let index = 0; index < height; index += 1) {
			rows.push(
				` ${dim("│")}${cell(left[index - drop] ?? "", leftWidth)}${dim("│")}${cell(right[index] ?? "", rightWidth)}${dim("│")}`,
			);
		}
		rows.push(` ${dim(`╰${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}╯`)}`);
		return rows;
	}

	private renderBoxed(width: number, theme: Theme): string[] {
		const model = this.info.model();
		const resumed = this.resumedLine(theme);
		const lines = [
			this.wordmark(theme),
			...(model === undefined ? [] : [theme.fg("dim", model)]),
			theme.fg("dim", this.info.cwd),
			...(resumed === undefined ? [] : [resumed]),
		];
		const textWidth = Math.min(Math.max(...lines.map((line) => visibleWidth(line))), width - BOX_OVERHEAD);
		const rule = "─".repeat(BOX_INNER_CHROME + textWidth);
		const rows = [` ${theme.fg("dim", `╭${rule}╮`)}`];
		for (let index = 0; index < ART_SMALL.length || index < lines.length; index += 1) {
			const art = ART_SMALL[index] ?? " ".repeat(ART_SMALL_WIDTH);
			const text = truncateToWidth(lines[index] ?? "", textWidth, "");
			const pad = " ".repeat(Math.max(0, textWidth - visibleWidth(text)));
			rows.push(
				` ${theme.fg("dim", "│")} ${theme.fg("accent", art)}  ${text}${pad} ${theme.fg("dim", "│")}`,
			);
		}
		rows.push(` ${theme.fg("dim", `╰${rule}╯`)}`);
		return [...rows, ...this.trailer(width, theme)];
	}

	private renderPlain(width: number, theme: Theme): string[] {
		const usable = Math.max(1, width - 2);
		const model = this.info.model();
		const cwd = this.info.cwd;
		const resumed = this.resumedLine(theme);
		const detail = (text: string): string[] =>
			wrapTextWithAnsi(theme.fg("dim", text), usable).map((line) => truncateToWidth(line, usable, ""));
		const lines = [
			truncateToWidth(this.wordmark(theme), usable, ""),
			...detail(model === undefined ? cwd : `${model} · ${cwd}`),
			...(resumed === undefined ? [] : detail(resumed)),
		];
		return [...lines.map((line) => (line === "" ? "" : ` ${line}`)), ...this.trailer(width, theme)];
	}

	private trailer(width: number, theme: Theme): string[] {
		const usable = Math.max(1, width - 2);
		const welcome = this.info.welcome;
		const names = this.info.skills ?? [];
		const lines = [
			...(welcome === undefined
				? []
				: wrapTextWithAnsi(theme.fg("dim", welcome), usable).map((line) => truncateToWidth(line, usable, ""))),
			...(names.length === 0
				? []
				: [
						"",
						theme.bold(theme.fg("dim", "[Skills]")),
						...packSkillNames(names, usable).map((row) => truncateToWidth(theme.fg("dim", row), usable, "")),
					]),
		];
		return lines.map((line) => (line === "" ? "" : ` ${line}`));
	}
}

// Minimal structural type for the theme methods the banner uses (pi's Theme).
// pi's Theme has no dim() method; use fg("dim", ...) instead.
// (ThemeLike removed — using pi's Theme directly)

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
