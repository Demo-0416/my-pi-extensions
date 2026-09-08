/**
 * CC status line: model / cwd / git branch / context% / cache% / cost, via
 * setFooter.
 * Fields mirror CC's StatusLine; colors stay on dim/muted theme tokens like
 * CC's dim status bar (warning only when the context is nearly exhausted).
 * Session totals (old ext "Total time · N turns" semantics): wall-clock since
 * session_start plus a user-turn counter, appended as one dim part.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Collapse the home-dir prefix of an absolute path to `~`, CC-style
 * (getDisplayPath, file.ts:163-166): only rewrite when the path actually sits
 * under home, guarded by a `home + "/"` boundary. A bare
 * `cwd.replace(HOME ?? "", "~")` injects a stray leading `~` when HOME is unset
 * (`replace("", "~")` matches at index 0) (AUDIT §5 status-line.ts:66).
 */
export function tildeHome(cwd: string): string {
	const home = homedir();
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
	return cwd;
}

// Loose type for the assistant message usage we sum (avoids a direct pi-ai dependency).
interface AssistantUsage {
	usage?: {
		cost?: { total?: number };
		input?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
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

		// Session totals: wall-clock and a user-turn counter. All three fields
		// (cost / duration / turns) must share one baseline — CC seeds them
		// together on resume (setCostStateForRestore adjusts startTime =
		// Date.now() - lastDuration, cost-tracker.ts). Seeding cost from history
		// but starting duration/turns from the resume moment makes the two halves
		// of the same line contradict (AUDIT §5 status-line.ts:41). So on resume
		// we seed turns from the user messages already in the branch and anchor
		// the clock to the earliest entry's timestamp.
		//
		// message_end with role "user" fires exactly once per submitted prompt
		// (agent-loop.js:51-54/96-103) — not per LLM turn, so it isn't inflated
		// by tools/retries/compaction.
		let cost = 0;
		let turns = 0;
		// Prompt-cache totals across the session: cacheRead is what the provider
		// served from cache, the rest of the prompt (input + cacheWrite) is what
		// was billed at the full rate. cacheTokens (cacheRead + cacheWrite) is the
		// "provider reports cache support" signal — 0 for non-caching providers.
		let cacheRead = 0;
		let promptTokens = 0;
		let cacheTokens = 0;
		let earliestMs = Date.now();
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const u = (e.message as unknown as AssistantUsage).usage;
				cost += u?.cost?.total ?? 0;
				cacheRead += u?.cacheRead ?? 0;
				promptTokens += (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
				cacheTokens += (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
			}
			if (e.type === "message" && e.message.role === "user") {
				turns += 1;
			}
			// SessionEntryBase.timestamp is an ISO string (session-manager.d.ts:21).
			if (typeof e.timestamp === "string") {
				const t = Date.parse(e.timestamp);
				if (Number.isFinite(t) && t < earliestMs) earliestMs = t;
			}
		}
		const sessionStartMs = earliestMs;

		pi.on("message_end", async (event) => {
			// Optional-chain the whole path: a failure-path assistant message may
			// carry no usage, and defensive handlers must not throw in the bus.
			if (event.message?.role === "assistant") {
				const u = (event.message as unknown as AssistantUsage).usage;
				cost += u?.cost?.total ?? 0;
				cacheRead += u?.cacheRead ?? 0;
				promptTokens += (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
				cacheTokens += (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
			} else if (event.message?.role === "user") {
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
					const cwd = tildeHome(ctx.cwd);
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
					// Cache hit rate across the session; shown only once the provider
					// has reported cache activity (providers without prompt caching
					// never emit cacheRead/cacheWrite, so the segment stays hidden).
					if (cacheTokens > 0) {
						parts.push(theme.fg("dim", `cache ${((cacheRead / promptTokens) * 100).toFixed(1)}%`));
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
