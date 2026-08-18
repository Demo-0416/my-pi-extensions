/**
 * CC spinner: teardrop-asterisk frames (forward + reverse) at 170ms, with the
 * full Claude Code fun-verb list sampled once per turn. Public pi APIs only
 * (ctx.ui.setWorkingIndicator / setWorkingMessage) — no Loader prototype patch.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// CC Spinner/utils.ts getDefaultCharacters(): Ghostty renders ✽ slightly offset,
// so the last frame is * there.
function defaultCharacters(): string[] {
	if (process.env.TERM === "xterm-ghostty") return ["·", "✢", "✳", "✶", "✻", "*"];
	return ["·", "✢", "✳", "✶", "✻", "✽"];
}

const FRAMES = defaultCharacters();
// Forward then reverse — CC's SpinnerAnimationRow plays the loop ping-pong.
const SPINNER = [...FRAMES, ...[...FRAMES].reverse()];
// CC Spinner: 120ms per frame.
const INTERVAL_MS = 120;

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

export function registerSpinner(pi: ExtensionAPI): void {

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Frames are pre-colored with the accent (CC brand) color; pi renders them
		// verbatim, so the SGR must be inside the frame strings.
		ctx.ui.setWorkingIndicator({
			frames: SPINNER.map((ch) => ctx.ui.theme.fg("accent", ch)),
			intervalMs: INTERVAL_MS,
		});
		// CC convention: terminal title is `✻ <cwd>`.
		try {
			ctx.ui.setTitle(`✻ ${ctx.cwd}`);
		} catch {
			/* title is best-effort */
		}
	});

	// Sample once per request, at agent_start — matching CC's mount-time
	// useState(() => sample(getSpinnerVerbs())) (CC Spinner.tsx:204). The verb
	// must be picked *before* the first working message is shown; the old code
	// sampled at turn_start, which fires *after* agent_start, so agent_start
	// always displayed the previous request's verb (AUDIT §5 spinner.ts:87).
	// A pi `turn` is one loop iteration, not one request (AUDIT §3-2), so a
	// per-turn resample would also make the verb jump mid-request — CC keeps it
	// stable for the whole request.
	pi.on("agent_start", async (_event, ctx) => {
		verb = sampleVerb();
		if (ctx.hasUI) ctx.ui.setWorkingMessage(`${verb}…`);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});
}
