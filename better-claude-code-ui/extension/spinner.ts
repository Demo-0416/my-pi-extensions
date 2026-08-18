/**
 * CC spinner status row, reproduced on pi's public APIs.
 *
 * CC's SpinnerAnimationRow (SpinnerAnimationRow.tsx) is a 20fps self-drawn row:
 * useAnimationFrame(50) drives the glyph frame (120ms), a glimmer sweep, the
 * elapsed-time + token byline (after 30s), and a thinking append. pi's built-in
 * Loader can do none of that — it bakes the glyph color once at
 * setWorkingIndicator time (AUDIT §5 spinner.ts:74 burn-in) and forces the verb
 * through messageColorFn = theme.fg("muted") (AUDIT §6: the verb should be
 * claude brand orange, not muted gray).
 *
 * So we do what the audit's feasibility note prescribes: hide the built-in
 * indicator with `frames: []` (pi loader.js:44,51 — empty frames ⇒ no glyph and
 * no internal timer) and repaint the whole line ourselves on a 50ms interval via
 * setWorkingMessage (pi interactive-mode.js:1878-1883 → StatusIndicator.setMessage
 * → Loader.updateDisplay → ui.requestRender, loader.js:38-41,59-67). Because the
 * line is rebuilt each tick from the live theme, a mid-session theme switch is
 * picked up immediately (no burn-in) and we own every color span.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

// CC Spinner/utils.ts getDefaultCharacters(): Ghostty renders ✽ slightly offset,
// so the last frame is * there.
function defaultCharacters(): string[] {
	if (process.env.TERM === "xterm-ghostty") return ["·", "✢", "✳", "✶", "✻", "*"];
	return ["·", "✢", "✳", "✶", "✻", "✽"];
}

const FRAMES = defaultCharacters();
// Forward then reverse — CC's SpinnerAnimationRow plays the loop ping-pong.
const SPINNER = [...FRAMES, ...[...FRAMES].reverse()];
// CC SpinnerAnimationRow.tsx:133 — frame = Math.floor(time / 120).
const FRAME_MS = 120;
// CC useAnimationFrame(50): the whole row is repainted at 20fps.
const TICK_MS = 50;
// CC SpinnerAnimationRow.tsx:135 — non-requesting glimmer cadence.
const GLIMMER_MS = 200;

// claude-code-main/src/constants/spinnerVerbs.ts — SPINNER_VERBS, full list.
const VERBS = [
	"Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming",
	"Beboppin'", "Befuddling", "Billowing", "Blanching", "Bloviating", "Boogieing",
	"Boondoggling", "Booping", "Bootstrapping", "Brewing", "Bunning", "Burrowing",
	"Calculating", "Canoodling", "Caramelizing", "Cascading", "Catapulting", "Cerebrating",
	"Channeling", "Channelling", "Choreographing", "Churning", "Clauding", "Coalescing",
	"Cogitating", "Combobulating", "Composing", "Computing", "Concocting", "Considering",
	"Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Crystallizing",
	"Cultivating", "Deciphering", "Deliberating", "Determining", "Dilly-dallying",
	"Discombobulating", "Doing", "Doodling", "Drizzling", "Ebbing", "Effecting",
	"Elucidating", "Embellishing", "Enchanting", "Envisioning", "Evaporating",
	"Fermenting", "Fiddle-faddling", "Finagling", "Flambéing", "Flibbertigibbeting",
	"Flowing", "Flummoxing", "Fluttering", "Forging", "Forming", "Frolicking",
	"Frosting", "Gallivanting", "Galloping", "Garnishing", "Generating", "Gesticulating",
	"Germinating", "Gitifying", "Grooving", "Gusting", "Harmonizing", "Hashing",
	"Hatching", "Herding", "Honking", "Hullaballooing", "Hyperspacing", "Ideating",
	"Imagining", "Improvising", "Incubating", "Inferring", "Infusing", "Ionizing",
	"Jitterbugging", "Julienning", "Kneading", "Leavening", "Levitating", "Lollygagging",
	"Manifesting", "Marinating", "Meandering", "Metamorphosing", "Misting", "Moonwalking",
	"Moseying", "Mulling", "Mustering", "Musing", "Nebulizing", "Nesting",
	"Newspapering", "Noodling", "Nucleating", "Orbiting", "Orchestrating", "Osmosing",
	"Perambulating", "Percolating", "Perusing", "Philosophising", "Photosynthesizing",
	"Pollinating", "Pondering", "Pontificating", "Pouncing", "Precipitating",
	"Prestidigitating", "Processing", "Proofing", "Propagating", "Puttering", "Puzzling",
	"Quantumizing", "Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating",
	"Roosting", "Ruminating", "Sautéing", "Scampering", "Schlepping", "Scurrying",
	"Seasoning", "Shenaniganing", "Shimmying", "Simmering", "Skedaddling", "Sketching",
	"Slithering", "Smooshing", "Sock-hopping", "Spelunking", "Spinning", "Sprouting",
	"Stewing", "Sublimating", "Swirling", "Swooping", "Symbioting", "Synthesizing",
	"Tempering", "Thinking", "Thundering", "Tinkering", "Tomfoolering", "Topsy-turvying",
	"Transfiguring", "Transmuting", "Twisting", "Undulating", "Unfurling", "Unravelling",
	"Vibing", "Waddling", "Wandering", "Warping", "Whatchamacalliting", "Whirlpooling",
	"Whirring", "Whisking", "Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging",
] as const;

function sampleVerb(): string {
	return VERBS[Math.floor(Math.random() * VERBS.length)] ?? "Working";
}

/** The active turn's spinner verb (for other modules restoring the working message). */
export function currentWorkingVerb(): string {
	return verb;
}

let verb = sampleVerb();

// ---------------------------------------------------------------------------
// Pure frame builder (tested in isolation)
// ---------------------------------------------------------------------------

/** Color functions for one frame — resolved from the *live* theme each tick. */
export interface SpinnerPaint {
	/** claude brand orange (CC messageColor 'claude'). */
	accent: (s: string) => string;
	/** claude shimmer (CC shimmerColor 'claudeShimmer'). */
	shimmer: (s: string) => string;
	/** CC's dimColor. */
	dim: (s: string) => string;
}

export interface SpinnerFrameState {
	verb: string;
	/** Milliseconds since the request (agent loop) started. */
	timeMs: number;
	columns: number;
	/** Cumulative downstream (output) tokens this request; segment hidden when 0/undefined. */
	tokens?: number;
	/** Active thinking descriptor ("thinking" / "thinking · high"), appended into the byline. */
	thinking?: string;
}

/** CC-style compact token count: 847 → "847", 1234 → "1.2k", 25600 → "26k". */
export function formatTokenCount(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${Math.round(n / 1000)}k`;
}

/** Elapsed time for the spinner byline: 12s / 1m 5s / 1h 2m 3s. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/** Visible width of a plain (ANSI-free) verb/label — spinner text is width-1 per code point. */
function plainWidth(s: string): number {
	return [...s].length;
}

/**
 * The glimmer-swept verb. CC GlimmerMessage.tsx:103-141 — chars within ±1 of
 * `glimmerIndex` (a visual column that sweeps right→left) get the shimmer color,
 * the rest get the base (accent) color. When the sweep is offscreen the whole
 * message renders in the base color.
 */
export function glimmerMessage(message: string, glimmerIndex: number, paint: SpinnerPaint): string {
	const chars = [...message];
	const messageWidth = chars.length;
	const shimmerStart = glimmerIndex - 1;
	const shimmerEnd = glimmerIndex + 1;
	if (shimmerStart >= messageWidth || shimmerEnd < 0) return paint.accent(message);

	const clampedStart = Math.max(0, shimmerStart);
	let before = "";
	let shim = "";
	let after = "";
	let col = 0;
	for (const ch of chars) {
		if (col + 1 <= clampedStart) before += ch;
		else if (col > shimmerEnd) after += ch;
		else shim += ch;
		col += 1;
	}
	return (before ? paint.accent(before) : "") + (shim ? paint.shimmer(shim) : "") + (after ? paint.accent(after) : "");
}

/**
 * Build one spinner line: `<glyph> <verb…> (thinking · 12s · ↓ 1.2k tokens ·
 * esc to interrupt)`. Pure — takes the animation clock and color functions,
 * returns an ANSI string. Mirrors SpinnerAnimationRow's derivations for a
 * single (non-teammate) agent. Glyph and verb are painted in the accent
 * (claude brand) color every tick — no gray verb (AUDIT §6), no baked-in frame
 * color (AUDIT §5 spinner.ts:74) — with a glimmer sweep across the verb
 * (AUDIT §6, CC's most recognizable spinner effect). The dim byline carries
 * the thinking state (appended after the verb, never replacing it — AUDIT §6
 * thinking P1), the elapsed clock, the downstream token count, and the
 * `esc to interrupt` hint (AUDIT §6 spinner P1/P2). On narrow terminals the
 * byline sheds segments (esc → tokens → clock → thinking) before ever
 * touching the verb — CC's progressive width degradation.
 */
export function buildSpinnerLine(state: SpinnerFrameState, paint: SpinnerPaint): string {
	const message = `${state.verb}…`;
	const messageWidth = plainWidth(message);
	const frame = Math.floor(state.timeMs / FRAME_MS) % SPINNER.length;
	const glyph = paint.accent(SPINNER[frame] ?? "✻");

	// Glimmer sweep — CC SpinnerAnimationRow.tsx:139-147 (non-requesting branch):
	// glimmerIndex = messageWidth + 10 - (cyclePosition % cycleLength), sweeping
	// right→left across the verb, then off the left edge and back.
	const cycleLength = messageWidth + 20;
	const cyclePosition = Math.floor(state.timeMs / GLIMMER_MS);
	const glimmerIndex = messageWidth + 10 - (cyclePosition % cycleLength);
	const verbSpan = glimmerMessage(message, glimmerIndex, paint);

	// Byline segments, in fixed order; dropped back-to-front when too wide.
	const segments = [
		...(state.thinking ? [state.thinking] : []),
		formatElapsed(state.timeMs),
		...(state.tokens && state.tokens > 0 ? [`↓ ${formatTokenCount(state.tokens)} tokens`] : []),
		"esc to interrupt",
	];
	// Shed the least informative segments first: esc hint, then tokens, then
	// the clock, then thinking. `2 + messageWidth` = glyph + space + verb.
	const drop = ["esc to interrupt", /^↓ /, /^\d/];
	let kept = segments;
	const fits = (parts: string[]): boolean =>
		parts.length === 0 || 2 + messageWidth + 1 + 2 + plainWidth(parts.join(" · ")) <= state.columns;
	for (const target of drop) {
		if (fits(kept)) break;
		kept = kept.filter((seg) => (typeof target === "string" ? seg !== target : !target.test(seg)));
	}
	if (!fits(kept)) kept = [];

	const byline = kept.length > 0 ? ` ${paint.dim(`(${kept.join(" · ")})`)}` : "";
	return `${glyph} ${verbSpan}${byline}`;
}

// ---------------------------------------------------------------------------
// Registration + the 50ms repaint loop
// ---------------------------------------------------------------------------

/** Byline wording for the active thinking level (matches thinking.ts's text). */
function thinkingSegment(level: string | undefined): string {
	if (!level || level === "none" || level === "off") return "thinking";
	return `thinking · ${level}`;
}

export function registerSpinner(pi: ExtensionAPI): void {
	let animStartMs = 0;
	let timer: ReturnType<typeof setInterval> | null = null;
	// Downstream token tally for the request: settled messages + streaming one.
	let settledTokens = 0;
	let streamTokens = 0;
	// Active thinking byline segment (undefined when no block is open).
	let thinking: string | undefined;
	let repaintScheduled = false;

	function paintFor(theme: Theme): SpinnerPaint {
		return {
			// accent → claude; customMessageLabel → claudeShimmer (theme JSON).
			accent: (s) => theme.fg("accent", s),
			shimmer: (s) => theme.fg("customMessageLabel", s),
			dim: (s) => theme.fg("dim", s),
		};
	}

	type UiCtx = { hasUI: boolean; ui: { theme: Theme; setWorkingMessage(m?: string): void } };

	function repaint(ctx: UiCtx): void {
		if (!ctx.hasUI || !timer) return;
		const line = buildSpinnerLine(
			{
				verb,
				timeMs: Date.now() - animStartMs,
				columns: process.stdout.columns ?? 80,
				tokens: settledTokens + streamTokens,
				thinking,
			},
			paintFor(ctx.ui.theme),
		);
		ctx.ui.setWorkingMessage(line);
	}

	/**
	 * Repaint after the current emit chain: spinner handlers registered before
	 * thinking.ts run first on the same event, and thinking.ts still writes its
	 * own working message (legacy path, repainted over within one tick). A
	 * macrotask puts our full composed row last deterministically.
	 */
	function scheduleRepaint(ctx: UiCtx): void {
		if (repaintScheduled) return;
		repaintScheduled = true;
		setTimeout(() => {
			repaintScheduled = false;
			repaint(ctx);
		}, 0);
	}

	function stopLoop(): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Hide pi's built-in glyph and its internal timer (loader.js:44,51). We
		// paint the glyph into the message ourselves so its color tracks the live
		// theme every tick (fixes AUDIT §5 spinner.ts:74 burn-in).
		ctx.ui.setWorkingIndicator({ frames: [] });
		// CC convention: terminal title is `✻ <cwd>`.
		try {
			ctx.ui.setTitle(`✻ ${ctx.cwd}`);
		} catch {
			/* title is best-effort */
		}
	});

	// Sample the verb once per request, at agent_start (AUDIT §5 spinner.ts:87 /
	// §3-2), matching CC's mount-time useState(() => sample(...)) (Spinner.tsx:204).
	pi.on("agent_start", async (_event, ctx) => {
		verb = sampleVerb();
		animStartMs = Date.now();
		settledTokens = 0;
		streamTokens = 0;
		thinking = undefined;
		if (!ctx.hasUI) return;
		stopLoop();
		timer = setInterval(() => repaint(ctx), TICK_MS);
		// Don't keep the event loop (or test process) alive on the spinner alone.
		timer.unref?.();
		repaint(ctx); // first frame synchronously, no blank tick
	});

	// Token + thinking feed for the byline. The streaming AssistantMessage
	// carries cumulative usage (usage.output) on every event variant; thinking
	// blocks toggle the byline's thinking segment (verb stays — AUDIT §6 P1).
	pi.on("message_update", async (event, ctx) => {
		const ame = event.assistantMessageEvent as
			| { type?: string; partial?: { usage?: { output?: number } }; message?: { usage?: { output?: number } } }
			| undefined;
		const kind = ame?.type;
		let changed = false;
		const out = (ame?.partial ?? ame?.message)?.usage?.output;
		if (typeof out === "number" && out !== streamTokens) {
			streamTokens = out;
			changed = true;
		}
		if (kind === "thinking_start") {
			thinking = thinkingSegment(ctx.thinkingLevel);
			changed = true;
		} else if (kind === "thinking_end") {
			thinking = undefined;
			changed = true;
		}
		if (changed && ctx.hasUI) scheduleRepaint(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message?.role !== "assistant") return;
		// Fold the finished message's downstream tokens into the settled tally.
		const out = (event.message as { usage?: { output?: number } }).usage?.output;
		settledTokens += typeof out === "number" ? out : streamTokens;
		streamTokens = 0;
		// Abort path: a dying stream may never emit thinking_end.
		thinking = undefined;
		if (ctx.hasUI) scheduleRepaint(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		stopLoop();
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});
}
