/**
 * Tool grouping + collapsed summary.
 *
 * Event-driven port of dsh-tui's collapse grouping (src/core/collapse.ts +
 * CollapsedGroupComponent in transcript.ts): consecutive read-only tool calls
 * within a turn form a group; the group's first tool renders the whole group
 * (collapsed summary row, or glance lines with branch connectors when expanded),
 * the other members render nothing (self-shell, zero lines).
 *
 * Also: pending status dot blink, thinking-duration attribution.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
	classifyToolCall,
	collapsedSummary,
	formatCollapseHint,
	type CollapseClassification,
	type CollapseHint,
} from "./collapse.js";
import { bold, dim, fg, italic, type ResolvedPalette } from "../palette.js";

export type ToolStatus = "pending" | "success" | "error";

export interface ToolRecord {
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: ToolStatus;
	startedAt: number;
	classification: CollapseClassification | undefined;
	result: unknown;
	isError: boolean;
}

export interface GroupInfo {
	id: number;
	members: ToolRecord[];
	thinkingMs: number;
	running: boolean;
	active: boolean;
	failed: boolean;
	searchCount: number;
	readCount: number;
	listCount: number;
	bashCount: number;
	mcpCallCount: number;
	mcpServers: string[];
	/** Last time a member started/finished — drives the MAX 5 blink budget. */
	lastActiveAt: number;
	/** 700ms min-display state for the in-flight ⎿ hint line. */
	hintState: HintState;
	/** The leader's invalidate callback, so the group refreshes on member updates. */
	invalidator: (() => void) | undefined;
	/** Archived groups only: every member's last render invalidate, kept so a
	 *  later `/cc-tools group off` can push hidden PAST-turn members to redraw
	 *  as standalone rows (AUDIT §5:372 — toggling off left them blank forever). */
	memberInvalidators?: Map<string, () => void>;
	/** CC v2.1.234: after a thinking segment completes mid-group, the ⎿ hint
	 *  shows the thinking TEXT (non-streaming) until a newer tool hint arrives.
	 *  Timestamped so latestHint() can arbitrate against member hints. */
	thinkingHint?: { value: string; at: number };
	/** Assistant body text started after this group's tools — CC's
	 *  hasContentAfter: the group settles (past tense) even though the
	 *  generation is still running. */
	contentAfter?: boolean;
}

/**
 * Per-group hint hold state (CC useMinDisplayTime, MIN_HINT_DISPLAY_MS=700):
 * each distinct hint stays visible for at least 700ms before a newer one
 * replaces it, so fast-finishing reads/greps stay readable instead of
 * flickering past in a single frame.
 */
export interface HintState {
	displayed: string | undefined;
	shownAt: number;
	pending: string | undefined;
	timer: ReturnType<typeof setTimeout> | null;
}

function createHintState(): HintState {
	return { displayed: undefined, shownAt: 0, pending: undefined, timer: null };
}

function clearHintTimer(st: HintState): void {
	if (st.timer) {
		clearTimeout(st.timer);
		st.timer = null;
	}
	st.pending = undefined;
}

// ---------------------------------------------------------------------------
// Tracker state (module-level singleton, wired per session)
// ---------------------------------------------------------------------------

let tools = new Map<string, ToolRecord>();
let turnToolOrder: string[] = [];
let groups: GroupInfo[] = [];
// AUDIT §5:399 — settled groups from PAST turns, kept so a global Ctrl+O
// re-render (pi setToolsExpanded re-renders every historical tool component)
// still resolves each member's group. Without this, turn_start cleared `groups`,
// so groupOf() returned undefined for old turns → hidden members drew their own
// standalone rows and leaders lost their summary: the whole collapsed group
// "exploded" into loose lines and could never collapse back. These are LIGHT
// shells: member results are stripped (result=undefined) so nothing accumulates
// across the session (preserves the B0 OOM guard `tools = new Map()`); the
// scalar counts + args are enough to redraw the settled summary and glance lines.
let archivedGroups: GroupInfo[] = [];
// Hard cap on archived groups so a very long session can't grow unbounded even
// with stripped results. Oldest evicted first; evicted turns fall back to pi's
// own rendering (no explosion is still avoided for the most recent ~all turns).
const MAX_ARCHIVED_GROUPS = 500;
let nextGroupId = 1;
let pendingThinkingMs = 0;
let thinkingOpenSince: number | undefined;
// The most recent completed thinking segment's text (whitespace-collapsed),
// waiting to be attached to a group as its ⎿ thinking hint (CC v2.1.234).
let pendingThinkingText: { value: string; at: number } | undefined;
let blinkTimer: ReturnType<typeof setInterval> | null = null;
let blinkPhase = true;
// AUDIT §5:199 — ids in this tick's blink budget. Out-of-budget rows are not
// re-rendered each tick, so they must not resolve to the off-phase blank (that
// would freeze the dot away). These sets let the phase helpers force the solid
// dot for anyone outside the budget while in-budget rows keep blinking.
let blinkBudgetGroups = new Set<number>();
let blinkBudgetStandalone = new Set<string>();
let activeSession = false;
// Non-grouped tools' running dots: armBlink registers their invalidate so the
// same tick drives their blink (CC useBlink: every pending dot blinks, not
// just group leaders). Keyed by toolCallId; dropped on tool_execution_end.
const standaloneBlinkers = new Map<string, () => void>();
// AUDIT §5:493 — the latest render invalidate for EVERY tool this turn, keyed by
// toolCallId, captured on every renderCall/renderResult (before any early
// return). When a later member joins and forms a group whose leader already
// settled (rendered its standalone row, no reason to re-render itself), the
// freshly-built group's invalidator is undefined, so invalidateGroups() could
// not refresh the leader — the group showed only the leader's stale row with the
// new members hidden. This lets invalidateGroups() promote a settled leader.
const toolInvalidators = new Map<string, () => void>();

// Blink watchdog (ported from pi-claude-code-ui extensions/index.ts:2656-2783):
// one global timer blinks all active groups; four safeguards keep it honest.
const MAX_BLINKING_GROUPS = 5;
// CC useBlink.ts:3 — one fixed 600ms rhythm for every pending dot.
const BLINK_INTERVAL_MS = 600;
// CC CollapsedReadSearchContent.tsx: MIN_HINT_DISPLAY_MS — each distinct ⎿ hint
// stays visible at least this long before a newer one replaces it.
const HINT_MIN_DISPLAY_MS = 700;
// Safety net ONLY for leaked entries after the agent run stopped. Quiet
// long-running tools (sleep, sparse builds) legitimately emit no updates for
// minutes — the agent heartbeat below keeps those blinking; this reclaims
// rows whose run died without firing agent_end.
const BLINK_STALE_TIMEOUT_MS = 15_000;
let lastBlinkActivity = 0;
// Depth of live agent runs (agent_start/agent_end pair per loop run, including
// retries and nested subagent loops). While > 0, the tick is a heartbeat:
// quiet tools keep blinking because the run is still alive.
let agentDepth = 0;

function markBlinkActivity(): void {
	lastBlinkActivity = Date.now();
}

function reset(): void {
	tools = new Map();
	turnToolOrder = [];
	clearAllHintTimers();
	groups = [];
	archivedGroups = [];
	standaloneBlinkers.clear();
	toolInvalidators.clear();
	blinkBudgetGroups = new Set();
	blinkBudgetStandalone = new Set();
	pendingThinkingMs = 0;
	thinkingOpenSince = undefined;
	pendingThinkingText = undefined;
	agentDepth = 0;
	stopBlink();
}

function clearAllHintTimers(): void {
	for (const g of groups) clearHintTimer(g.hintState);
}

function stopBlink(): void {
	if (blinkTimer) {
		clearInterval(blinkTimer);
		blinkTimer = null;
	}
}

/**
 * Settle groups whose members never received tool_execution_end (run died
 * without agent_end). Display-only reclamation: we don't own the real tool
 * state, we just stop lying that it is still running.
 */
function settleLeakedGroups(): void {
	let changed = false;
	for (const g of groups) {
		for (const m of g.members) {
			if (m.status === "pending") {
				// AUDIT §5:157 — a still-pending member here means its
				// tool_execution_end was never observed (the run died abnormally:
				// crash / kill, no agent_end path). Clean Esc-interrupts are NOT this
				// case — the agent loop emits tool_execution_end{isError:true} with an
				// "Operation aborted" result (pi-agent-core agent-loop.js:414-436), so
				// they already settle as "error" via tool_execution_end and never reach
				// here. An unobserved-completion tool is not a confirmed success, so mark
				// it "error" (red/interrupted) rather than painting a false green dot.
				m.status = "error";
				m.isError = true;
				changed = true;
			}
		}
		if (g.active) {
			g.running = false;
			g.active = false;
			g.failed = g.members.some((m) => m.isError);
			changed = true;
		}
		clearHintTimer(g.hintState);
	}
	standaloneBlinkers.clear();
	if (changed) invalidateGroups();
}

function blinkTick(): void {
	const now = Date.now();
	if (agentDepth > 0) {
		// Agent run live: quiet tools are still in flight — heartbeat keeps the
		// blink alive so sparse/no-output commands never look stale mid-run.
		lastBlinkActivity = now;
	} else if (lastBlinkActivity !== 0 && now - lastBlinkActivity > BLINK_STALE_TIMEOUT_MS) {
		// No run live and no progress for 15s: leftover pending members are
		// leaks. Reclaim them and stop the re-render storm.
		settleLeakedGroups();
		stopBlink();
		return;
	}
	blinkPhase = !blinkPhase;
	// Invalidate at most MAX_BLINKING_GROUPS leaders per tick, most recent first.
	const active = groups.filter((g) => g.active).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	const budgetGroups = active.slice(0, MAX_BLINKING_GROUPS);
	// AUDIT §5:199 — record who is in this tick's blink budget. Rows OUTSIDE the
	// budget are not re-rendered, so they freeze on whatever frame they last
	// painted; if that frame was the "off" (space) phase, the dot vanishes for
	// good. currentBlinkPhase()/groupBlinkVisible() consult these sets so an
	// out-of-budget row always resolves to the solid dot (never the blank space),
	// while in-budget rows keep blinking. The budget still caps re-render volume.
	blinkBudgetGroups = new Set(budgetGroups.map((g) => g.id));
	for (const g of budgetGroups) {
		if (g.invalidator) {
			try {
				g.invalidator();
			} catch {
				/* noop */
			}
		}
	}
	// Standalone (non-grouped) running dots — same rhythm, same budget, most
	// recently armed first.
	const standaloneEntries = [...standaloneBlinkers.entries()].slice(-MAX_BLINKING_GROUPS);
	blinkBudgetStandalone = new Set(standaloneEntries.map(([id]) => id));
	for (const [, invalidate] of standaloneEntries) {
		try {
			invalidate();
		} catch {
			/* noop */
		}
	}
	if (active.length === 0 && standaloneBlinkers.size === 0) stopBlink();
}

function ensureBlink(): void {
	if (blinkTimer) return;
	blinkTimer = setInterval(blinkTick, BLINK_INTERVAL_MS);
	blinkTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Group construction
// ---------------------------------------------------------------------------

function buildGroup(members: ToolRecord[], id: number): GroupInfo {
	let searchCount = 0;
	let readCount = 0;
	let listCount = 0;
	let bashCount = 0;
	let mcpCallCount = 0;
	const mcpServers: string[] = [];
	let running = false;
	let failed = false;
	let lastActiveAt = 0;
	const readPaths = new Set<string>();
	let readNoPath = 0;
	for (const m of members) {
		if (m.status === "pending") running = true;
		if (m.isError) failed = true;
		if (m.startedAt > lastActiveAt) lastActiveAt = m.startedAt;
		// AUDIT §6 (P1) — a read-only bash command counts as read/search/list, not
		// "ran N bash commands". CC (getToolSearchOrReadInfo, collapseReadSearch.ts:831-882)
		// routes read-only bash by its classification (isList → listCount, isSearch →
		// searchCount, otherwise readOperationCount); only NON-read-only bash becomes
		// bashCount, and that only under fullscreen. In pi a non-read-only bash has no
		// classification, so it already breaks the group (rebuildGroups flushes on the
		// undefined classification) and never reaches here — every bash member is
		// read-only. So route bash the same as any other tool, by classification.kind.
		const c = m.classification;
		if (!c) continue;
		switch (c.kind) {
			case "search":
				searchCount += 1;
				break;
			case "list":
				listCount += 1;
				break;
			case "mcp":
				mcpCallCount += 1;
				if (c.server && !mcpServers.includes(c.server)) mcpServers.push(c.server);
				break;
			default:
				// read: track unique file paths (real Read calls carry a path); bash
				// reads like `cat`/`head` have no path, so count the operation (CC
				// readOperationCount, collapseReadSearch.ts:874-882).
				if (c.path) readPaths.add(c.path);
				else readNoPath += 1;
				break;
		}
	}
	readCount = readPaths.size + readNoPath;
	return {
		id,
		members,
		thinkingMs: 0,
		running,
		active: running,
		failed,
		searchCount,
		readCount,
		listCount,
		bashCount,
		mcpCallCount,
		mcpServers,
		lastActiveAt,
		hintState: createHintState(),
		invalidator: undefined,
	};
}

/** Recompute groups from the current turn's tool order. */
function rebuildGroups(): void {
	const newGroups: GroupInfo[] = [];
	let run: ToolRecord[] = [];
	const flush = () => {
		// AUDIT §6 (P1) — CC collapseReadSearch.ts:770-780 flushGroup builds a
		// collapsed group whenever the run has ≥1 collapsible tool use (a lone
		// read/search/list still renders as "Read 1 file (ctrl+o to expand)").
		// pi previously required ≥2, so a single read-only call fell back to a
		// bare tool row. buildGroup + the render path already handle 1 member.
		if (run.length >= 1) {
			const g = buildGroup(run, nextGroupId++);
			// Absorb any pending thinking into the new group.
			if (pendingThinkingMs > 0) {
				g.thinkingMs = pendingThinkingMs;
				pendingThinkingMs = 0;
			}
			// The thinking segment that preceded this group travels with it as the
			// ⎿ thinking-text hint (CC v2.1.234); latestHint() lets any newer tool
			// hint win by timestamp.
			if (pendingThinkingText !== undefined) {
				g.thinkingHint = pendingThinkingText;
				pendingThinkingText = undefined;
			}
			newGroups.push(g);
		}
		run = [];
	};
	for (const id of turnToolOrder) {
		const t = tools.get(id);
		if (!t) continue;
		if (t.classification) {
			run.push(t);
		} else {
			flush();
		}
	}
	flush();
	// Preserve invalidators, hint hold-state, and the attributed thinking
	// duration across rebuilds (leaders may already be rendering; without
	// inheriting thinkingMs, ≥3-member groups lose "thinking for Xs" on the
	// second rebuild — buildGroup zeroes it and pendingThinkingMs is spent).
	for (const ng of newGroups) {
		const old = groups.find((g) => g.members[0]?.toolCallId === ng.members[0]?.toolCallId);
		if (old) {
			ng.invalidator = old.invalidator;
			ng.hintState = old.hintState;
			ng.thinkingMs += old.thinkingMs;
			ng.thinkingHint = ng.thinkingHint ?? old.thinkingHint;
			ng.contentAfter = old.contentAfter;
		}
	}
	groups = newGroups;
}

function groupOf(toolCallId: string): GroupInfo | undefined {
	return (
		groups.find((g) => g.members.some((m) => m.toolCallId === toolCallId)) ??
		// AUDIT §5:399 — also resolve members of PAST turns' settled groups so a
		// global Ctrl+O re-render keeps them collapsed instead of exploding.
		archivedGroups.find((g) => g.members.some((m) => m.toolCallId === toolCallId))
	);
}

/** Cap retained arg strings for archived members. glance lines truncate to ~72
 *  chars anyway (toolSummary), so a 512-char ceiling loses nothing visible while
 *  ensuring a huge bash command / path can't stay resident for the session. */
function capArgs(args: unknown): unknown {
	if (typeof args !== "object" || args === null) return args;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		out[k] = typeof v === "string" && v.length > 512 ? v.slice(0, 512) : v;
	}
	return out;
}

/** Move the current turn's settled groups into the archive (light shells: member
 *  results stripped) so a later global Ctrl+O still resolves and collapses them.
 *  AUDIT §5:399. */
function archiveCurrentGroups(): void {
	for (const g of groups) {
		// Only archive groups that actually collapsed (≥1 leader summary worth
		// keeping). Strip heavy per-member results so nothing large persists.
		// Keep each member's render invalidate (a closure over a component that
		// lives in the chat container anyway) so `/cc-tools group off` can push
		// past-turn hidden members to redraw as standalone rows (AUDIT §5:372).
		const invalidators = new Map<string, () => void>();
		for (const m of g.members) {
			m.result = undefined;
			m.status = m.status === "pending" ? "success" : m.status;
			// Cap retained arg strings — glance lines only need a short summary, and
			// a bash command / long path could otherwise pin megabytes per turn.
			m.args = capArgs(m.args);
			const inv = toolInvalidators.get(m.toolCallId);
			if (inv) invalidators.set(m.toolCallId, inv);
		}
		g.running = false;
		g.active = false;
		g.invalidator = undefined;
		g.memberInvalidators = invalidators;
		g.thinkingHint = undefined; // hint only ever shows while active
		clearHintTimer(g.hintState);
		archivedGroups.push(g);
	}
	if (archivedGroups.length > MAX_ARCHIVED_GROUPS) {
		archivedGroups = archivedGroups.slice(archivedGroups.length - MAX_ARCHIVED_GROUPS);
	}
}

/** Bump a group's recency so the MAX 5 blink budget favors the latest work. */
function touchGroup(toolCallId: string): void {
	const g = groupOf(toolCallId);
	if (g) g.lastActiveAt = Date.now();
}

function isLeader(toolCallId: string): boolean {
	const g = groupOf(toolCallId);
	return !!g && g.members[0]?.toolCallId === toolCallId;
}

// ---------------------------------------------------------------------------
// /cc-tools group on|off — persisted in ~/.pi/settings.json under
// `groupToolCalls` (same key the old extension used; commands.ts writes it).
// ---------------------------------------------------------------------------

const SETTINGS_CACHE_TTL_MS = 2_000;
let settingsCache: { value: boolean; timestamp: number } | null = null;

function readGroupToolCalls(): boolean {
	// Default ON; only an explicit `false` disables grouping.
	let enabled = true;
	// AUDIT §5:347 — commands.ts WRITES the toggle via homedir(); reading it via
	// process.env.HOME broke the round-trip when HOME is unset. Same source both ways.
	const paths = [`${process.cwd()}/.pi/settings.json`, `${homedir()}/.pi/settings.json`];
	for (const path of paths) {
		try {
			if (!path || !existsSync(path)) continue;
			const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			if (typeof raw.groupToolCalls === "boolean") enabled = raw.groupToolCalls;
		} catch {
			/* keep previous value on parse error */
		}
	}
	return enabled;
}

/**
 * Push every row this module has ever influenced to re-render — current-turn
 * tools (leaders AND hidden members), current groups, and archived past-turn
 * groups. Called by /cc-tools group on|off so the toggle takes effect on
 * screen immediately: hidden members redraw as standalone rows when grouping
 * turns off, and leaders drop/regain their summary row (AUDIT §5:372,
 * commands.ts:88 — the toggle used to leave the transcript looking unchanged).
 */
export function repaintGroupedRows(): void {
	const seen = new Set<() => void>();
	const push = (inv: (() => void) | undefined): void => {
		if (!inv || seen.has(inv)) return;
		seen.add(inv);
		try {
			inv();
		} catch {
			/* noop */
		}
	};
	for (const inv of toolInvalidators.values()) push(inv);
	for (const g of groups) push(g.invalidator);
	for (const g of archivedGroups) {
		push(g.invalidator);
		if (g.memberInvalidators) for (const inv of g.memberInvalidators.values()) push(inv);
	}
}

/** Whether collapsed tool grouping is enabled (reads settings.json, 2s cache). */
export function isGroupingEnabled(): boolean {
	const now = Date.now();
	if (settingsCache && now - settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) {
		return settingsCache.value;
	}
	const value = readGroupToolCalls();
	settingsCache = { value, timestamp: now };
	return value;
}

/** Drop the settings cache so a /cc-tools group toggle applies immediately. */
export function bustGroupingSettingsCache(): void {
	settingsCache = null;
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

export function registerGrouping(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		reset();
		activeSession = true;
	});

	pi.on("session_shutdown", async () => {
		reset();
		activeSession = false;
	});

	pi.on("turn_start", async () => {
		// New turn: clear per-turn state but keep the tracker alive.
		// tools is only ever looked up by ids in turnToolOrder (see rebuildGroups),
		// so dropping it here is safe and prevents every ToolRecord (with full
		// tool result) from accumulating for the whole session.
		// AUDIT §5:399 — archive this turn's settled groups (as light shells with
		// results stripped) BEFORE dropping them, so a later global Ctrl+O still
		// resolves past-turn members and keeps them collapsed instead of exploding
		// into loose rows. tools/turnToolOrder are still cleared (B0 OOM guard).
		archiveCurrentGroups();
		tools = new Map();
		turnToolOrder = [];
		clearAllHintTimers();
		groups = [];
		toolInvalidators.clear();
		pendingThinkingMs = 0;
		thinkingOpenSince = undefined;
		pendingThinkingText = undefined;
		markBlinkActivity();
	});

	// Agent heartbeat (old ext index.ts:4800-4866, 6863-6890): agent_start and
	// agent_end pair per loop run (retries and nested subagent loops included),
	// so depth counts them correctly. While depth > 0 the blink tick is a
	// heartbeat — quiet long-running tools keep blinking.
	pi.on("before_agent_start", async () => {
		markBlinkActivity();
	});

	pi.on("agent_start", async () => {
		agentDepth += 1;
		markBlinkActivity();
	});

	pi.on("agent_end", async () => {
		agentDepth = Math.max(0, agentDepth - 1);
		// Defer so a sibling agent_start (retry/continuation) in the same
		// window re-arms the depth before we decide the run is over.
		queueMicrotask(() => {
			if (agentDepth === 0) {
				// Run finished: settle any leaked pending members (tool_end lost)
				// and stop blink. Do NOT clear on turn_end — a turn ends when the
				// assistant message finishes, BEFORE its tools run.
				settleLeakedGroups();
				stopBlink();
			}
		});
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "user") markBlinkActivity();
	});

	// Track thinking spans for the collapsed summary's "Thought for Xs".
	pi.on("message_update", async (event) => {
		markBlinkActivity();
		// CC v2.1.234 — a COMPLETED thinking segment's text becomes the active
		// group's ⎿ hint (non-streaming: it appears once the segment ends). The
		// thinking_end stream event carries the full segment text.
		const ame = (event as { assistantMessageEvent?: { type?: string; content?: string } }).assistantMessageEvent;
		if (ame?.type === "thinking_end" && typeof ame.content === "string") {
			const flat = ame.content.replace(/\s+/g, " ").trim();
			if (flat.length > 0) {
				const hint = { value: flat, at: Date.now() };
				const g = groups[groups.length - 1];
				if (g && g.active) {
					g.thinkingHint = hint;
					invalidateGroups();
				} else {
					// No active group yet — travels with the next group built
					// (rebuildGroups flush), like pendingThinkingMs.
					pendingThinkingText = hint;
				}
			}
		}
		// CC MessageRow.tsx hasContentAfter — assistant BODY text after a group's
		// tools settles the group (past tense) even mid-generation. Thinking does
		// NOT settle it ("Thinking for Xs, searching…" keeps present tense).
		if (ame?.type === "text_start") {
			const g = groups[groups.length - 1];
			if (g && !g.running && g.active) {
				g.contentAfter = true;
				g.active = false;
				clearHintTimer(g.hintState);
				invalidateGroups();
			} else if (g) {
				g.contentAfter = true;
			}
		}
		const content = (event as { message?: { content?: unknown } })?.message?.content;
		if (!Array.isArray(content) || content.length === 0) return;
		// AUDIT §5:449 — decide open/close by the LAST (currently-streaming) block,
		// not by "any non-thinking block present". event.message.content is the
		// cumulative streaming array, so once a text block precedes a *second*
		// thinking block, the old "hasThinking && hasOther" logic both re-opened
		// (thinking present) and closed (text present) the span in the same tick
		// → every 2nd+ thinking segment was attributed 0ms. Anthropic streams
		// thinking → text → toolCall in order, so the last element is the block
		// being written right now.
		const last = content[content.length - 1] as { type?: string };
		const lastIsThinking = last?.type === "thinking";
		if (lastIsThinking) {
			if (thinkingOpenSince === undefined) thinkingOpenSince = Date.now();
		} else if (thinkingOpenSince !== undefined) {
			pendingThinkingMs += Date.now() - thinkingOpenSince;
			thinkingOpenSince = undefined;
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		if (thinkingOpenSince !== undefined) {
			pendingThinkingMs += Date.now() - thinkingOpenSince;
			thinkingOpenSince = undefined;
		}
	});

	pi.on("tool_execution_start", async (event) => {
		const record: ToolRecord = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			status: "pending",
			startedAt: Date.now(),
			classification: undefined,
			result: undefined,
			isError: false,
		};
		// Classify read-only calls for collapse grouping.
		try {
			record.classification = classifyToolCall(event.toolName, event.args);
		} catch {
			record.classification = undefined;
		}
		tools.set(event.toolCallId, record);
		turnToolOrder.push(event.toolCallId);
		rebuildGroups();
		// A still-open thinking span counts toward the group this call joins.
		if (thinkingOpenSince !== undefined) {
			pendingThinkingMs += Date.now() - thinkingOpenSince;
			thinkingOpenSince = undefined;
		}
		markBlinkActivity();
		touchGroup(event.toolCallId);
		invalidateGroups();
		if (record.classification) ensureBlink();
	});

	// Partial tool output is the main long-running signal (bash streams for
	// minutes) — keep the blink watchdog's activity clock fresh.
	pi.on("tool_execution_update", async (event) => {
		markBlinkActivity();
		touchGroup(event.toolCallId);
	});

	pi.on("tool_execution_end", async (event) => {
		const t = tools.get(event.toolCallId);
		standaloneBlinkers.delete(event.toolCallId);
		if (!t) return;
		t.status = event.isError ? "error" : "success";
		t.isError = event.isError;
		t.result = event.result;
		// Refresh group running/active/failed flags.
		const g = groupOf(event.toolCallId);
		if (g) {
			g.running = g.members.some((m) => m.status === "pending");
			g.failed = g.members.some((m) => m.isError);
			// CC isActiveGroup = hasAnyToolInProgress || (isLoading && !hasContentAfter)
			// (MessageRow.tsx:118). The second term keeps the LATEST group in present
			// tense between tool batches — through thinking pauses — until the run
			// ends (agent_end → settleLeakedGroups), body text lands after it
			// (text_start above), or the next turn archives it. CC v2.1.234 shows
			// "Thinking for Xs, searching…" exactly in that window.
			g.active =
				g.running ||
				(agentDepth > 0 && groups[groups.length - 1] === g && !g.contentAfter);
			g.lastActiveAt = Date.now();
		}
		markBlinkActivity();
		invalidateGroups();
	});
}

function invalidateGroups(): void {
	for (const g of groups) {
		// Prefer the leader's registered invalidator; fall back to the leader's
		// last-captured render invalidate (AUDIT §5:493 — a group formed after its
		// leader already settled has no g.invalidator yet, so the leader would
		// never re-render to draw the newly-hidden members).
		const leaderId = g.members[0]?.toolCallId;
		const invalidate = g.invalidator ?? (leaderId ? toolInvalidators.get(leaderId) : undefined);
		if (invalidate) {
			try {
				invalidate();
			} catch {
				/* noop */
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Render helpers (called from builtins.ts renderCall/renderResult)
// ---------------------------------------------------------------------------

/** Register the leader's invalidate so the group refreshes on member updates.
 *  Called by every member's renderCall/renderResult; we record EVERY tool's
 *  latest invalidate (AUDIT §5:493) so a settled leader can be promoted when a
 *  later member turns its standalone row into a group. */
export function registerGroupInvalidator(toolCallId: string, invalidate: () => void): void {
	toolInvalidators.set(toolCallId, invalidate);
	const g = groupOf(toolCallId);
	if (g && isLeader(toolCallId)) g.invalidator = invalidate;
}

/** Whether this tool should render zero lines (a non-leader group member). */
export function isHiddenGroupMember(toolCallId: string): boolean {
	if (!isGroupingEnabled()) return false;
	const g = groupOf(toolCallId);
	return !!g && !isLeader(toolCallId);
}

export interface GroupRenderInfo {
	group: GroupInfo;
	leader: boolean;
	phase: "collapsed" | "preview";
}

export function getGroupRenderInfo(toolCallId: string, expanded: boolean): GroupRenderInfo | undefined {
	if (!isGroupingEnabled()) return undefined;
	const g = groupOf(toolCallId);
	if (!g || !isLeader(toolCallId)) return undefined;
	return { group: g, leader: true, phase: expanded ? "preview" : "collapsed" };
}

// CC figures.ts: BLACK_CIRCLE = darwin ? '⏺' : '●'.
const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

// AUDIT §5:722 — glance-line bash command budget. Truncation appends `…`.
const GLANCE_COMMAND_MAX = 72;

function statusDot(status: ToolStatus, theme: Theme): string {
	switch (status) {
		case "success":
			return theme.fg("success", BLACK_CIRCLE);
		case "error":
			return theme.fg("error", BLACK_CIRCLE);
		default:
			// CC ToolUseLoader: while unresolved, dim, blink on/off. AUDIT §5:577 —
			// no foreground here read one notch brighter than every other pending dot.
			return blinkPhase ? theme.fg("dim", BLACK_CIRCLE) : " ";
	}
}

/**
 * The latest hint to show on the ⎿ line. CC prefers the currently-running
 * operation's hint (CollapsedReadSearchContent isActiveGroup branch), falling
 * back to the last hinted call in the group (readPaths.at(-1) / searchArgs.at(-1)).
 * We mirror that: newest pending member with a hint wins; otherwise the newest
 * member with any hint. Returns undefined when no member carries a hint (e.g. an
 * all-ls group), which blanks the line — matching CC's `incomingHint===undefined`.
 */
function latestHint(g: GroupInfo): CollapseHint | undefined {
	let member: ToolRecord | undefined;
	for (let i = g.members.length - 1; i >= 0; i--) {
		const m = g.members[i]!;
		if (m.status === "pending" && m.classification?.hint) {
			member = m;
			break;
		}
	}
	if (!member) {
		for (let i = g.members.length - 1; i >= 0; i--) {
			const m = g.members[i]!;
			if (m.classification?.hint) {
				member = m;
				break;
			}
		}
	}
	// CC v2.1.234 — a thinking segment completed AFTER the newest hinted tool
	// call shows its text on the ⎿ line until the next tool starts. Arbitrate
	// by timestamp: the newer of (thinking segment, tool call start) wins.
	const th = g.thinkingHint;
	if (th && (!member || th.at > member.startedAt)) {
		return { kind: "thinking", value: th.value };
	}
	return member?.classification?.hint;
}

/**
 * The in-flight hint line for a group (CC CollapsedReadSearchContent.tsx:462-476):
 * `  ⎿  ` + the latest operation's path/pattern/command, dim, held ≥700ms per
 * distinct value so fast-finishing calls stay readable. Only shown while active.
 */
function hintLineFor(
	g: GroupInfo,
	theme: Theme,
	displayPath: (p: string) => string,
): string {
	if (!g.active) {
		clearHintTimer(g.hintState);
		g.hintState.displayed = undefined;
		return "";
	}
	// AUDIT §5:596 — CC derives the live hint from the LATEST hinted operation
	// (CollapsedReadSearchContent.tsx:196-201: readPaths.at(-1) / searchArgs.at(-1)),
	// not the first pending member. Taking the first pending member froze the
	// hint on the first file of a parallel batch, and blanked the whole line when
	// the leader was an ls (no hint) even though a later grep/read in the group
	// had one. Walk members newest-first and take the first that carries a hint.
	const raw = latestHint(g);
	const incoming = raw ? formatCollapseHint(raw, displayPath) : undefined;
	const st = g.hintState;
	if (incoming === undefined) {
		clearHintTimer(st);
		st.displayed = undefined;
		return "";
	}
	const now = Date.now();
	if (st.displayed === undefined) {
		st.displayed = incoming;
		st.shownAt = now;
	} else if (incoming !== st.displayed) {
		const elapsed = now - st.shownAt;
		if (elapsed >= HINT_MIN_DISPLAY_MS) {
			clearHintTimer(st);
			st.displayed = incoming;
			st.shownAt = now;
		} else if (st.pending !== incoming) {
			// Newer hint waits its turn; switch when the current one has aged out.
			st.pending = incoming;
			if (st.timer === null) {
				st.timer = setTimeout(() => {
					st.timer = null;
					if (st.pending !== undefined) {
						st.displayed = st.pending;
						st.pending = undefined;
						st.shownAt = Date.now();
					}
					if (g.invalidator) {
						try {
							g.invalidator();
						} catch {
							/* noop */
						}
					}
				}, HINT_MIN_DISPLAY_MS - elapsed);
				st.timer.unref?.();
			}
		}
	}
	// CC indents continuation lines to column 5 (2 lead + ⎿ + 2 gap) so a
	// multi-line command hint reads as one block, not column-0 ragged lines.
	const body = st.displayed.split("\n").join("\n     ");
	return st.displayed !== undefined ? `\n  ${theme.fg("dim", `⎿  ${body}`)}` : "";
}

/** The collapsed summary row (dsh-tui CollapsedGroupComponent). */
export function renderCollapsedSummary(
	info: GroupRenderInfo,
	theme: Theme,
	palette: ResolvedPalette,
	displayPath: (p: string) => string,
): string {
	const g = info.group;
	// CC wraps every count in <Bold>; bold's 22m closes only the intensity
	// attribute, so it survives the settled line's dim foreground (38;2).
	const summary = collapsedSummary(g, (count) => bold(String(count)));
	// CC CollapsedReadSearchContent.tsx:450 — settled groups render <Box minWidth={2}/>
	// (2 spaces, NO glyph, even when a member errored); active groups render
	// ToolUseLoader, whose isError dot is red but dimColor (dim + error, static —
	// a resolved error shows its state, not the pending blink).
	const gutter = !g.active
		? "  "
		: g.failed
			? `${dim(fg(palette.cc.error, BLACK_CIRCLE))} `
			: (ensureBlink(), groupBlinkVisible(g.id) ? `${theme.fg("dim", BLACK_CIRCLE)} ` : "  ");
	const text = g.active ? summary : theme.fg("dim", summary);
	// CC CtrlOToExpand.tsx:39 — dim "(ctrl+o to expand)", always rendered.
	const hint = italic(theme.fg("dim", "(ctrl+o to expand)"));
	const hintLine = hintLineFor(g, theme, displayPath);
	return `${gutter}${text} ${hint}${hintLine}`;
}

/** Branch prefix for a member's glance line (bare ├/└, no horizontal arm). */
function branchPrefix(index: number, total: number, theme: Theme): string {
	const rule = theme.fg("dim", "│");
	if (index === total - 1) return `${theme.fg("dim", "└")} `;
	return `${theme.fg("dim", "├")} `;
}

function branchContinuation(theme: Theme): string {
	return `${theme.fg("dim", "│")} `;
}

/** AUDIT §5:754 — continuation under the LAST member (drawn with `└`): the tree
 *  is closed, so the vertical rail stops. Two spaces keep the result body aligned
 *  in the same column the `│` would have occupied, without drawing the rail. */
function branchClosedContinuation(_theme: Theme): string {
	return "  ";
}

/** A member's glance line: `├ ⏺ Read(path)` or `└ ⏺ Bash(cmd)` (CC name/summary colors). */
function glanceLine(m: ToolRecord, index: number, total: number, theme: Theme, displayPath: (p: string) => string): string {
	const prefix = branchPrefix(index, total, theme);
	const dot = statusDot(m.status, theme);
	const label = toolLabel(m.toolName);
	const summary = toolSummary(m, displayPath);
	// CC AssistantToolUseMessage: bold default-color name + (summary) in parens, default color.
	const summaryText = summary ? `(${summary})` : "";
	return `${prefix}${dot} ${theme.bold(label)}${summaryText}`;
}

function toolLabel(name: string): string {
	switch (name) {
		case "read":
			return "Read";
		case "bash":
			return "Bash";
		case "grep":
			// AUDIT §5:701 — the standalone row calls this tool "Search" (CC
			// userFacingName); the expanded glance line must use the same name.
			return "Search";
		case "find":
			return "Find";
		case "ls":
			return "List";
		case "edit":
			return "Edit";
		case "write":
			return "Write";
		default:
			return name.startsWith("mcp__") ? "MCP" : name;
	}
}

function toolSummary(m: ToolRecord, displayPath: (p: string) => string): string {
	const args = (m.args ?? {}) as Record<string, unknown>;
	const sp = (v: unknown) => (typeof v === "string" ? displayPath(v) : "");
	switch (m.toolName) {
		case "read":
			return sp(args.path ?? args.file_path);
		case "bash": {
			if (typeof args.command !== "string") return "";
			// AUDIT §5:722 — collapse whitespace, then truncate WITH an ellipsis so a
			// long command reads as truncated, not as if the command itself ended at
			// 72 chars. (Old code sliced to 72 with no marker.)
			const flat = args.command.replace(/\s+/g, " ").trim();
			return flat.length > GLANCE_COMMAND_MAX ? `${flat.slice(0, GLANCE_COMMAND_MAX - 1)}…` : flat;
		}
		case "grep":
		case "find": {
			const pattern = typeof args.pattern === "string" ? `"${args.pattern}"` : "";
			const path = sp(args.path);
			return path ? `${pattern} in ${path}` : pattern;
		}
		case "ls":
			return sp(args.path ?? ".");
		default:
			return "";
	}
}

/**
 * The preview-phase group body: glance lines for each member + result previews.
 * Rendered by the leader only.
 */
export function renderGroupPreview(
	info: GroupRenderInfo,
	theme: Theme,
	palette: ResolvedPalette,
	displayPath: (p: string) => string,
	renderResultLine: (m: ToolRecord) => string,
): string {
	const g = info.group;
	const lines: string[] = [];
	for (let i = 0; i < g.members.length; i++) {
		const m = g.members[i]!;
		const isLast = i === g.members.length - 1;
		lines.push(glanceLine(m, i, g.members.length, theme, displayPath));
		const resultLine = renderResultLine(m);
		if (resultLine) {
			// AUDIT §5:754 — the last member's glance line uses `└` (the closer), so
			// its result continuation must NOT re-draw the vertical `│` — the tree is
			// closed. Non-last members continue with `│`; the last uses blank padding
			// so the branch line stops at the closer instead of running past it.
			const cont = isLast ? branchClosedContinuation(theme) : branchContinuation(theme);
			for (const rl of resultLine.split("\n")) {
				lines.push(`${cont}${rl}`);
			}
		}
	}
	return lines.join("\n");
}

/** Re-export for builtins to classify a tool on demand. */
export { classifyToolCall };

/**
 * Whether a group leader's pending dot should be visible this frame. In-budget
 * groups follow the global blink phase; out-of-budget groups (not re-rendered
 * every tick) always show the solid dot so they never freeze on the blank phase.
 * (AUDIT §5:199.)
 */
function groupBlinkVisible(groupId: number): boolean {
	return blinkBudgetGroups.has(groupId) ? blinkPhase : true;
}

/** The current blink phase for a non-grouped tool's status dot. Out-of-budget
 *  standalone tools (not re-rendered this tick) resolve to visible so their dot
 *  never freezes on the blank phase; in-budget ones follow the global phase.
 *  (AUDIT §5:199.) Called with no id from contexts that just want the phase. */
export function currentBlinkPhase(toolCallId?: string): boolean {
	if (toolCallId !== undefined && !blinkBudgetStandalone.has(toolCallId)) return true;
	return blinkPhase;
}

/** Ensure the blink timer runs while a pending tool is visible, and register
 *  the tool's own invalidate so its dot actually toggles (group leaders are
 *  invalidated via g.invalidator; standalone tools need their own entry). */
export function armBlink(toolCallId: string, invalidate: () => void): void {
	if (!activeSession) return;
	standaloneBlinkers.set(toolCallId, invalidate);
	ensureBlink();
}

export function makeText(last: unknown, text: string): Text {
	// AUDIT §2 P0-4 — only reuse `last` when it is actually a Text. On expand
	// toggles the previous component may be a DiffCardComponent (write/edit) whose
	// setText is undefined; blindly casting + setText throws TypeError.
	const t = last instanceof Text ? last : new Text("", 0, 0);
	t.setText(text);
	return t;
}
