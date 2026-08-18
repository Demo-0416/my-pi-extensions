/**
 * CC turn footer: `✻ Worked for 45s`, dim, printed only for turns that ran
 * longer than 30s. Persisted via appendEntry + registerEntryRenderer so it
 * survives reload/resume.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// dsh-tui transcript.ts: TURN_COMPLETION_VERBS — CC's past-tense turn verbs.
const TURN_COMPLETION_VERBS = [
	"Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked",
] as const;

// dsh-tui transcript.ts: TURN_FOOTER_MIN_MS — CC's REPL.tsx threshold (30s).
const TURN_FOOTER_MIN_MS = 30_000;

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
	let turnStartMs = 0;
	let verb = sampleTurnVerb();

	pi.on("turn_start", async () => {
		turnStartMs = Date.now();
		verb = sampleTurnVerb();
	});

	pi.on("turn_end", async () => {
		if (!turnStartMs) return;
		const duration = Date.now() - turnStartMs;
		turnStartMs = 0;
		if (duration <= TURN_FOOTER_MIN_MS) return;
		pi.appendEntry<TurnFooterData>("cc-turn-footer", { ms: duration, verb });
	});

	pi.registerEntryRenderer<TurnFooterData>("cc-turn-footer", (entry, _options, theme) => {
		const data = entry.data ?? { ms: 0, verb: "Worked" };
		// Gutter: one leading space so the ✻ sits in the same column as the
		// assistant bullet (dsh-tui GUTTER).
		return new Text(theme.fg("dim", ` ✻ ${data.verb} for ${formatTurnDuration(data.ms)}`), 0, 0);
	});
}
