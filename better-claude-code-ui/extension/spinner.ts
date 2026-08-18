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
 * Build one spinner line: `<glyph> <verb…>`. Pure — takes the animation clock
 * and color functions, returns an ANSI string. Mirrors SpinnerAnimationRow's
 * derivations for a single (non-teammate) agent. Glyph and verb are painted in
 * the accent (claude brand) color every tick — no gray verb (AUDIT §6), no
 * baked-in frame color (AUDIT §5 spinner.ts:74) — with a glimmer sweep across
 * the verb (AUDIT §6, CC's most recognizable spinner effect).
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

	return `${glyph} ${verbSpan}`;
}

// ---------------------------------------------------------------------------
// Registration + the 50ms repaint loop
// ---------------------------------------------------------------------------

export function registerSpinner(pi: ExtensionAPI): void {
	let animStartMs = 0;
	let timer: ReturnType<typeof setInterval> | null = null;

	function paintFor(theme: Theme): SpinnerPaint {
		return {
			// accent → claude; customMessageLabel → claudeShimmer (theme JSON).
			accent: (s) => theme.fg("accent", s),
			shimmer: (s) => theme.fg("customMessageLabel", s),
			dim: (s) => theme.fg("dim", s),
		};
	}

	function repaint(ctx: { hasUI: boolean; ui: { theme: Theme; setWorkingMessage(m?: string): void } }): void {
		if (!ctx.hasUI) return;
		const line = buildSpinnerLine(
			{ verb, timeMs: Date.now() - animStartMs, columns: process.stdout.columns ?? 80 },
			paintFor(ctx.ui.theme),
		);
		ctx.ui.setWorkingMessage(line);
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
		if (!ctx.hasUI) return;
		repaint(ctx); // first frame synchronously, no blank tick
		stopLoop();
		timer = setInterval(() => repaint(ctx), TICK_MS);
		// Don't keep the event loop (or test process) alive on the spinner alone.
		timer.unref?.();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		stopLoop();
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});
}
