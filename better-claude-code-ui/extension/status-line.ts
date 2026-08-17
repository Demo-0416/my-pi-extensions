/**
 * CC status line: model / cwd / git branch / context% / cost, via setFooter.
 * Fields mirror CC's StatusLine; colors stay on theme tokens (dim/muted/accent/
 * warning) like CC's dim status bar.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Loose type for the assistant message usage we sum (avoids a direct pi-ai dependency).
interface AssistantUsage {
	usage: { cost: { total: number } };
}

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	return `${(n / 1000).toFixed(1)}k`;
}

export function registerStatusLine(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Accumulate cost from assistant usage (message_end), like CC's getTotalCost.
		let cost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				cost += (e.message as unknown as AssistantUsage).usage.cost.total;
			}
		}
		pi.on("message_end", async (event) => {
			if (event.message.role === "assistant") {
				cost += event.message.usage.cost.total;
			}
		});

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model?.id ?? "no-model";
					const cwd = ctx.cwd.replace(process.env.HOME ?? "", "~");
					const branch = footerData.getGitBranch();
					const usage = ctx.getContextUsage();
					const window = ctx.model?.contextWindow ?? 0;
					const tokens = usage?.tokens ?? 0;
					const pct = window > 0 ? Math.round((tokens / window) * 100) : 0;
					// CC's exceeds200kTokens: warn when the context is nearly exhausted.
					const warn = window > 0 && tokens > window * 0.9;

					const parts: string[] = [theme.fg("accent", model)];
					parts.push(theme.fg("dim", cwd));
					if (branch) parts.push(theme.fg("dim", `⎇ ${branch}`));
					if (tokens > 0) {
						const ctxText = window > 0 ? `${pct}%` : formatTokens(tokens);
						parts.push(warn ? theme.fg("warning", `ctx ${ctxText}`) : theme.fg("dim", `ctx ${ctxText}`));
					}
					if (cost > 0) parts.push(theme.fg("dim", `$${cost.toFixed(2)}`));

					const line = parts.join(theme.fg("dim", " · "));
					return [truncateToWidth(line, width, "")];
				},
			};
		});
	});
}
