/**
 * CC status line: model / cwd / git branch / context% / cost, via setFooter.
 * Fields mirror CC's StatusLine; colors stay on dim/muted theme tokens like
 * CC's dim status bar (warning only when the context is nearly exhausted).
 * Session totals (old ext "Total time · N turns" semantics): wall-clock since
 * session_start plus a user-turn counter, appended as one dim part.
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

/** CC/old-ext duration format: <60s "Ns", <1h "Mm Ss", else "Hh Mm Ss". */
function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const hours = Math.floor(totalSec / 3600);
	const mins = Math.floor((totalSec % 3600) / 60);
	const secs = totalSec % 60;
	if (hours < 1) return `${mins}m ${secs}s`;
	return `${hours}h ${mins}m ${secs}s`;
}

export function registerStatusLine(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Session totals: wall-clock from session_start, turns from user
		// messages. pi's turn_start fires once per LLM call (agent-loop.js:50,
		// :89-91) — tools, retries and compaction would all inflate it;
		// message_end with role "user" fires exactly once per submitted prompt
		// (agent-loop.js:51-54/96-103).
		const sessionStartMs = Date.now();
		let turns = 0;

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
			} else if (event.message.role === "user") {
				turns += 1;
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

					const parts: string[] = [theme.fg("muted", model)];
					parts.push(theme.fg("dim", cwd));
					if (branch) parts.push(theme.fg("dim", `⎇ ${branch}`));
					if (tokens > 0) {
						const ctxText = window > 0 ? `${pct}%` : formatTokens(tokens);
						parts.push(warn ? theme.fg("warning", `ctx ${ctxText}`) : theme.fg("dim", `ctx ${ctxText}`));
					}
					if (cost > 0) parts.push(theme.fg("dim", `$${cost.toFixed(2)}`));
					// Session totals (old ext: "Total time X · N turns"); hidden on a
					// fresh session before the first turn completes.
					if (turns > 0) {
						const total = formatDuration(Date.now() - sessionStartMs);
						parts.push(theme.fg("dim", `${total} · ${turns} ${turns === 1 ? "turn" : "turns"}`));
					}

					const line = parts.join(theme.fg("dim", " · "));
					return [truncateToWidth(line, width, "")];
				},
			};
		});
	});
}
