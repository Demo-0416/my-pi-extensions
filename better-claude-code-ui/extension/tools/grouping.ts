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
import {
	classifyToolCall,
	collapsedSummary,
	groupThinkingMs,
	type CollapseClassification,
	type CollapsedGroup,
} from "./collapse.js";
import { dim as dimText, fg, type ResolvedPalette } from "../palette.js";

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
	thinkingSince: number | undefined;
	running: boolean;
	active: boolean;
	failed: boolean;
	searchCount: number;
	readCount: number;
	listCount: number;
	mcpCallCount: number;
	mcpServers: string[];
	/** The leader's invalidate callback, so the group refreshes on member updates. */
	invalidator: (() => void) | undefined;
}

// ---------------------------------------------------------------------------
// Tracker state (module-level singleton, wired per session)
// ---------------------------------------------------------------------------

let tools = new Map<string, ToolRecord>();
let turnToolOrder: string[] = [];
let groups: GroupInfo[] = [];
let nextGroupId = 1;
let pendingThinkingMs = 0;
let thinkingOpenSince: number | undefined;
let blinkTimer: ReturnType<typeof setInterval> | null = null;
let blinkPhase = true;
let activeSession = false;

function reset(): void {
	tools = new Map();
	turnToolOrder = [];
	groups = [];
	pendingThinkingMs = 0;
	thinkingOpenSince = undefined;
	stopBlink();
}

function stopBlink(): void {
	if (blinkTimer) {
		clearInterval(blinkTimer);
		blinkTimer = null;
	}
}

function ensureBlink(): void {
	if (blinkTimer) return;
	blinkTimer = setInterval(() => {
		blinkPhase = !blinkPhase;
		// Invalidate every active group's leader so the pending dot blinks.
		for (const g of groups) {
			if (g.active && g.invalidator) {
				try {
					g.invalidator();
				} catch {
					/* noop */
				}
			}
		}
		if (!groups.some((g) => g.active)) stopBlink();
	}, 500);
	blinkTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Group construction
// ---------------------------------------------------------------------------

function buildGroup(members: ToolRecord[], id: number): GroupInfo {
	let searchCount = 0;
	let readCount = 0;
	let listCount = 0;
	let mcpCallCount = 0;
	const mcpServers: string[] = [];
	let running = false;
	let failed = false;
	const readPaths = new Set<string>();
	let readNoPath = 0;
	for (const m of members) {
		if (m.status === "pending") running = true;
		if (m.isError) failed = true;
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
		thinkingSince: undefined,
		running,
		active: running,
		failed,
		searchCount,
		readCount,
		listCount,
		mcpCallCount,
		mcpServers,
		invalidator: undefined,
	};
}

/** Recompute groups from the current turn's tool order. */
function rebuildGroups(): void {
	const newGroups: GroupInfo[] = [];
	let run: ToolRecord[] = [];
	const flush = () => {
		if (run.length >= 2) {
			const g = buildGroup(run, nextGroupId++);
			// Absorb any pending thinking into the new group.
			if (pendingThinkingMs > 0) {
				g.thinkingMs = pendingThinkingMs;
				pendingThinkingMs = 0;
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
	// Preserve invalidators across rebuilds (leaders may already be rendering).
	for (const ng of newGroups) {
		const old = groups.find((g) => g.members[0]?.toolCallId === ng.members[0]?.toolCallId);
		if (old) ng.invalidator = old.invalidator;
	}
	groups = newGroups;
}

function groupOf(toolCallId: string): GroupInfo | undefined {
	return groups.find((g) => g.members.some((m) => m.toolCallId === toolCallId));
}

function isLeader(toolCallId: string): boolean {
	const g = groupOf(toolCallId);
	return !!g && g.members[0]?.toolCallId === toolCallId;
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
		turnToolOrder = [];
		groups = [];
		pendingThinkingMs = 0;
		thinkingOpenSince = undefined;
	});

	// Track thinking spans for the collapsed summary's "Thought for Xs".
	pi.on("message_update", async (event) => {
		const content = (event as { message?: { content?: unknown } })?.message?.content;
		if (!Array.isArray(content)) return;
		let hasThinking = false;
		let hasOther = false;
		for (const block of content) {
			const b = block as { type?: string };
			if (b.type === "thinking") hasThinking = true;
			else if (b.type === "text" || b.type === "toolCall") hasOther = true;
		}
		if (hasThinking && thinkingOpenSince === undefined) {
			thinkingOpenSince = Date.now();
		}
		if (hasOther && thinkingOpenSince !== undefined) {
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
		invalidateGroups();
		if (record.classification) ensureBlink();
	});

	pi.on("tool_execution_end", async (event) => {
		const t = tools.get(event.toolCallId);
		if (!t) return;
		t.status = event.isError ? "error" : "success";
		t.isError = event.isError;
		t.result = event.result;
		// Refresh group running/active/failed flags.
		const g = groupOf(event.toolCallId);
		if (g) {
			g.running = g.members.some((m) => m.status === "pending");
			g.failed = g.members.some((m) => m.isError);
			g.active = g.running || g.thinkingSince !== undefined;
		}
		invalidateGroups();
	});
}

function invalidateGroups(): void {
	for (const g of groups) {
		if (g.invalidator) {
			try {
				g.invalidator();
			} catch {
				/* noop */
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Render helpers (called from builtins.ts renderCall/renderResult)
// ---------------------------------------------------------------------------

/** Register the leader's invalidate so the group refreshes on member updates. */
export function registerGroupInvalidator(toolCallId: string, invalidate: () => void): void {
	const g = groupOf(toolCallId);
	if (g && isLeader(toolCallId)) g.invalidator = invalidate;
}

/** Whether this tool should render zero lines (a non-leader group member). */
export function isHiddenGroupMember(toolCallId: string): boolean {
	const g = groupOf(toolCallId);
	return !!g && !isLeader(toolCallId);
}

export interface GroupRenderInfo {
	group: GroupInfo;
	leader: boolean;
	phase: "collapsed" | "preview";
}

export function getGroupRenderInfo(toolCallId: string, expanded: boolean): GroupRenderInfo | undefined {
	const g = groupOf(toolCallId);
	if (!g || !isLeader(toolCallId)) return undefined;
	return { group: g, leader: true, phase: expanded ? "preview" : "collapsed" };
}

// CC figures.ts: BLACK_CIRCLE = darwin ? '⏺' : '●'.
const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

function statusDot(status: ToolStatus, theme: Theme): string {
	switch (status) {
		case "success":
			return theme.fg("success", BLACK_CIRCLE);
		case "error":
			return theme.fg("error", BLACK_CIRCLE);
		default:
			// CC ToolUseLoader: while unresolved, default color, blink on/off.
			return blinkPhase ? BLACK_CIRCLE : " ";
	}
}

/** The collapsed summary row (dsh-tui CollapsedGroupComponent). */
export function renderCollapsedSummary(
	info: GroupRenderInfo,
	theme: Theme,
	palette: ResolvedPalette,
	displayPath: (p: string) => string,
): string {
	const g = info.group;
	const now = Date.now();
	const summary = collapsedSummary(g, now);
	// CC CollapsedReadSearchContent: active = ToolUseLoader (⏺, default, blink);
// done = empty 2-wide gutter (no dot); error = ⏺ red. Text dim when done, default when active.
const bullet = g.failed
		? theme.fg("error", BLACK_CIRCLE)
		: g.active
			? (ensureBlink(), blinkPhase ? BLACK_CIRCLE : " ")
			: " ";
	const text = g.active ? summary : theme.fg("dim", summary);
	const hint = theme.fg("dim", "(ctrl+o to expand)");
	// In-flight hint: the latest operation's path/pattern/command.
	const inFlight = g.members.find((m) => m.status === "pending") ?? g.members[g.members.length - 1];
	let hintLine = "";
	if (inFlight?.classification?.hint && g.active) {
		const h = inFlight.classification.hint;
		const value = h.kind === "path" ? displayPath(h.value) : h.kind === "pattern" ? `"${h.value}"` : h.kind === "command" ? `$ ${h.value}` : h.value;
		hintLine = `\n  ${theme.fg("dim", "⎿ " + value)}`;
	}
	return ` ${bullet} ${text} ${hint}${hintLine}`;
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
			return "Grep";
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
		case "bash":
			return typeof args.command === "string" ? args.command.replace(/\s+/g, " ").slice(0, 72) : "";
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
		lines.push(glanceLine(m, i, g.members.length, theme, displayPath));
		const resultLine = renderResultLine(m);
		if (resultLine) {
			const cont = branchContinuation(theme);
			for (const rl of resultLine.split("\n")) {
				lines.push(`${cont}${rl}`);
			}
		}
	}
	return lines.join("\n");
}

/** Re-export for builtins to classify a tool on demand. */
export { classifyToolCall };

/** The current blink phase (for status dots in non-grouped tools). */
export function currentBlinkPhase(): boolean {
	return blinkPhase;
}

/** Ensure the blink timer runs while a pending tool is visible. */
export function armBlink(): void {
	if (activeSession) ensureBlink();
}

export function makeText(last: unknown, text: string): Text {
	const t = (last as Text | undefined) ?? new Text("", 0, 0);
	t.setText(text);
	return t;
}
