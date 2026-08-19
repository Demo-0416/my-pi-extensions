/**
 * CC turn footer: `✻ Worked for 45s`, dim, printed after every request that
 * took ≥1s (CC v2.1.234 shows it for 4s/11s turns too). Persisted via
 * appendEntry + registerEntryRenderer so it survives reload/resume.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// dsh-tui transcript.ts: TURN_COMPLETION_VERBS — CC's past-tense turn verbs.
const TURN_COMPLETION_VERBS = [
	"Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked",
] as const;

// CC v2.1.234 (user-verified renders): the footer prints for EVERY request —
// `✻ Sautéed for 4s`, `✻ Cooked for 11s`. The old snapshot's 30s REPL.tsx
// threshold no longer applies; only sub-second turns are skipped (a "0s"
// footer is noise CC never shows).
const TURN_FOOTER_MIN_MS = 1_000;

// dsh-tui transcript.ts: formatTurnDuration — `45s`, `1m 23s`, `2h 5m 1s`.
export function formatTurnDuration(ms: number): string {
	const elapsed = Math.max(0, ms);
	if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
	let seconds = Math.round((elapsed % 60_000) / 1000);
	let minutes = Math.floor((elapsed % 3_600_000) / 60_000);
	let hours = Math.floor(elapsed / 3_600_000);
	if (seconds === 60) {
		seconds = 0;
		minutes += 1;
	}
	if (minutes === 60) {
		minutes = 0;
		hours += 1;
	}
	return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

function sampleTurnVerb(): string {
	return TURN_COMPLETION_VERBS[Math.floor(Math.random() * TURN_COMPLETION_VERBS.length)] ?? "Worked";
}

interface TurnFooterData {
	ms: number;
	verb: string;
}

export function registerTurnFooter(pi: ExtensionAPI): void {
	// CC's turn footer is per *request*, not per LLM call: it appends one line at
	// query completion measuring `Date.now() - loadingStartTimeRef` (CC
	// REPL.tsx:4004). A pi `turn` is a single agent-loop iteration — one LLM reply
	// plus its tools — so a request spans N turn_start/turn_end pairs (AUDIT §3-2,
	// pi agent-loop.js:43-131). Keying the footer on turn_end therefore printed
	// one `✻ Worked for Ns` per iteration (AUDIT §5 turn-footer.ts:48).
	//
	// The request boundary is agent_start … agent_settled: `_runAgentPrompt` runs
	// the initial prompt plus any continuations (retries, compaction, queued
	// follow-ups) — each emitting its own agent_start/agent_end — then fires a
	// single agent_settled in its finally (pi agent-session.js:744-756). We start
	// the clock on the first agent_start of a request and settle exactly once on
	// agent_settled, matching CC's one-line-per-request semantics.
	let requestStartMs = 0;

	pi.on("agent_start", async () => {
		// Only the first agent_start of a request starts the clock; continuation
		// runs (agent.continue) keep the original start time so the reported
		// duration covers the whole request, like CC's loadingStartTimeRef.
		if (!requestStartMs) requestStartMs = Date.now();
	});

	pi.on("agent_settled", async () => {
		if (!requestStartMs) return;
		const duration = Date.now() - requestStartMs;
		requestStartMs = 0;
		if (duration < TURN_FOOTER_MIN_MS) return;
		// CC picks a fresh random past-tense verb when it creates the completion
		// message (createTurnDurationMessage); sample here at settle time.
		pi.appendEntry<TurnFooterData>("cc-turn-footer", { ms: duration, verb: sampleTurnVerb() });
	});

	pi.registerEntryRenderer<TurnFooterData>("cc-turn-footer", (entry, _options, theme) => {
		const data = entry.data ?? { ms: 0, verb: "Worked" };
		// Gutter: one leading space so the ✻ sits in the same column as the
		// assistant bullet (dsh-tui GUTTER).
		return new Text(theme.fg("dim", ` ✻ ${data.verb} for ${formatTurnDuration(data.ms)}`), 0, 0);
	});
}
