/**
 * Read/search collapse: classification + summary wording, ported from
 * dsh-tui/src/core/collapse.ts. The pure functions (shell command classification,
 * MCP query detection, collapsedSummary) are verbatim; the node-list group
 * builder is replaced by an event-driven tracker in grouping.ts.
 */

// dsh-tui collapse.ts: shell words that make a command a search.
const BASH_SEARCH_COMMANDS = new Set(["find", "grep", "rg", "ag", "ack", "locate", "which", "whereis"]);
// dsh-tui collapse.ts: shell words that make a command a read.
const BASH_READ_COMMANDS = new Set([
	"cat", "head", "tail", "less", "more",
	"wc", "stat", "file", "strings",
	"jq", "awk", "cut", "sort", "uniq", "tr",
]);
// dsh-tui collapse.ts: shell words that list a directory.
const BASH_LIST_COMMANDS = new Set(["ls", "tree", "du"]);
// dsh-tui collapse.ts: semantically neutral words.
const BASH_NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"]);

const REDIRECT_OPERATORS = new Set([">", ">>", ">&", "2>", "2>>", "2>&", "<"]);
const WRITE_REDIRECT_OPERATORS = new Set([">", ">>", ">&", "2>", "2>>", "2>&"]);
const FD_DUP_OPERATORS = new Set([">&", "2>&"]);
const NULL_DEVICE = "/dev/null";
const FIND_MUTATING_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf"]);
const COMMAND_SUBSTITUTION = /\$\(|`|<\(/u;
const SEPARATOR_OPERATORS = new Set(["|", "||", "&&", ";", "&"]);

const MCP_PREFIX = "mcp__";
const MCP_READ_VERBS = new Set([
	"search", "find", "get", "list", "read", "fetch", "query",
	"describe", "view", "lookup", "browse", "inspect", "show",
]);
const MCP_WRITE_VERBS = new Set([
	"create", "update", "delete", "remove", "write", "set", "add", "send",
	"post", "patch", "save", "clear", "drop", "move", "rename", "upload",
	"insert", "edit", "append", "archive", "close", "cancel", "run", "execute",
]);

export type CollapseKind = "search" | "read" | "list" | "mcp";

export interface CollapseClassification {
	kind: CollapseKind;
	server?: string;
	path?: string;
	hint?: CollapseHint;
}

export interface CollapseHint {
	// "comment" = a bash call's leading `# comment` label (CC BashTool shows the
	// human label, not the raw command); rendered without the `$ ` prefix.
	kind: "path" | "pattern" | "command" | "comment" | "thinking";
	value: string;
}

// dsh-tui collapse.ts: writesThroughArguments
function writesThroughArguments(base: string, words: readonly string[]): boolean {
	const args = words.slice(1);
	if (base === "sort") {
		return args.some((word) => word.startsWith("--output") || /^-[a-zA-Z]*o$/u.test(word));
	}
	if (base === "uniq") {
		const valued = new Set(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]);
		let operands = 0;
		for (let index = 0; index < args.length; index += 1) {
			const word = args[index] as string;
			if (valued.has(word)) {
				index += 1;
				continue;
			}
			if (word.startsWith("-") && word !== "-") continue;
			operands += 1;
		}
		return operands >= 2;
	}
	return false;
}

// dsh-tui collapse.ts: splitCommandWithOperators
function splitCommandWithOperators(command: string): string[] | undefined {
	const parts: string[] = [];
	let current = "";
	let quote: string | undefined;
	let index = 0;
	const flush = (): void => {
		const trimmed = current.trim();
		if (trimmed !== "") parts.push(trimmed);
		current = "";
	};
	while (index < command.length) {
		const char = command[index] as string;
		if (quote !== undefined) {
			current += char;
			if (char === quote) quote = undefined;
			index += 1;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			index += 1;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			current += char + (command[index + 1] as string);
			index += 2;
			continue;
		}
		const triple = command.slice(index, index + 3);
		if (triple === "2>>" || triple === "2>&") {
			flush();
			parts.push(triple);
			index += 3;
			continue;
		}
		const pair = command.slice(index, index + 2);
		if (pair === "||" || pair === "&&" || pair === ">>" || pair === ">&" || pair === "2>") {
			flush();
			parts.push(pair);
			index += 2;
			continue;
		}
		if (char === "|" || char === ";" || char === "&" || char === ">" || char === "<" || char === "\n") {
			flush();
			parts.push(char);
			index += 1;
			continue;
		}
		current += char;
		index += 1;
	}
	if (quote !== undefined) return undefined;
	flush();
	return parts;
}

// dsh-tui collapse.ts: classifyShellCommand
export function classifyShellCommand(command: string): {
	isSearch: boolean;
	isRead: boolean;
	isList: boolean;
} {
	const none = { isSearch: false, isRead: false, isList: false };
	if (COMMAND_SUBSTITUTION.test(command)) return none;
	const parts = splitCommandWithOperators(command);
	if (parts === undefined || parts.length === 0) return none;
	let hasSearch = false;
	let hasRead = false;
	let hasList = false;
	let hasCommand = false;
	let redirect: string | undefined;
	for (const part of parts) {
		if (redirect !== undefined) {
			const operator = redirect;
			redirect = undefined;
			if (!WRITE_REDIRECT_OPERATORS.has(operator)) continue;
			const target = part.split(/\s+/)[0] ?? "";
			if (FD_DUP_OPERATORS.has(operator) && /^\d+-?$/u.test(target)) continue;
			if (target === NULL_DEVICE) continue;
			return none;
		}
		if (REDIRECT_OPERATORS.has(part)) {
			redirect = part;
			continue;
		}
		if (SEPARATOR_OPERATORS.has(part)) continue;
		const words = part.split(/\s+/);
		const base = words[0];
		if (base === undefined || base === "") continue;
		if (BASH_NEUTRAL_COMMANDS.has(base)) continue;
		hasCommand = true;
		const isSearch = BASH_SEARCH_COMMANDS.has(base);
		const isRead = BASH_READ_COMMANDS.has(base);
		const isList = BASH_LIST_COMMANDS.has(base);
		if (!isSearch && !isRead && !isList) return none;
		if (base === "find" && words.some((word) => FIND_MUTATING_FLAGS.has(word))) return none;
		if (writesThroughArguments(base, words)) return none;
		if (isSearch) hasSearch = true;
		if (isRead) hasRead = true;
		if (isList) hasList = true;
	}
	if (redirect !== undefined && WRITE_REDIRECT_OPERATORS.has(redirect)) return none;
	if (!hasCommand) return none;
	return { isSearch: hasSearch, isRead: hasRead, isList: hasList };
}

function argString(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function mcpParts(name: string): { server: string; raw: string } | undefined {
	if (!name.startsWith(MCP_PREFIX)) return undefined;
	const rest = name.slice(MCP_PREFIX.length);
	const separator = rest.indexOf("__");
	if (separator <= 0) return undefined;
	return { server: rest.slice(0, separator), raw: rest.slice(separator + 2) };
}

function isMcpQuery(raw: string): boolean {
	const verb = raw
		.replace(/([a-z\d])([A-Z])/g, "$1_$2")
		.replace(/-/g, "_")
		.toLowerCase()
		.split("_")
		.filter((part) => part !== "");
	if (verb[0] !== undefined && MCP_WRITE_VERBS.has(verb[0])) return false;
	return verb.slice(0, 2).some((part) => MCP_READ_VERBS.has(part));
}

function compactCommand(command: string): string {
	return command
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line !== "")
		.join("\n");
}

/**
 * CC BashTool label: the first leading `# comment` line (hash stripped) is the
 * human label for the call — the collapsed hint shows it instead of the raw
 * command. Blank lines are skipped; the first non-blank line decides.
 */
function leadingComment(command: string): string | undefined {
	for (const line of command.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		if (!trimmed.startsWith("#")) return undefined;
		const text = trimmed.slice(1).trim();
		return text !== "" ? text : undefined;
	}
	return undefined;
}

/**
 * Drop leading blank + `# comment` lines so the shell classifier sees the real
 * command — a `#` first word makes classifyShellCommand bail (not a known verb).
 */
function stripLeadingComments(command: string): string {
	const lines = command.split("\n");
	let i = 0;
	for (; i < lines.length; i++) {
		const trimmed = (lines[i] ?? "").trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		break;
	}
	return lines.slice(i).join("\n");
}

/**
 * Classify one tool call as a read-only operation. Adapted from dsh-tui
 * collapse.ts:classifyToolCall for pi's builtin tool set (read/bash/grep/find/ls
 * + mcp__*).
 */
export function classifyToolCall(name: string, args: unknown): CollapseClassification | undefined {
	const mcp = mcpParts(name);
	if (mcp !== undefined) {
		if (!isMcpQuery(mcp.raw)) return undefined;
		const query = argString(args, "query") ?? argString(args, "pattern");
		return {
			kind: "mcp",
			server: mcp.server,
			...(query === undefined ? {} : { hint: { kind: "pattern", value: query } as const }),
		};
	}
	switch (name) {
		case "read": {
			const path = argString(args, "path") ?? argString(args, "file_path");
			return {
				kind: "read",
				...(path === undefined ? {} : { path, hint: { kind: "path", value: path } as const }),
			};
		}
		case "grep":
		case "find": {
			const pattern = argString(args, "pattern");
			return {
				kind: "search",
				...(pattern === undefined ? {} : { hint: { kind: "pattern", value: pattern } as const }),
			};
		}
		case "ls": {
			return { kind: "list" };
		}
		case "bash": {
			const command = argString(args, "command");
			if (command === undefined) return undefined;
			const comment = leadingComment(command);
			// Classify the command without its leading comment lines — a `#` first
			// word makes classifyShellCommand bail (not a known verb).
			const stripped = stripLeadingComments(command);
			const { isSearch, isRead, isList } = classifyShellCommand(stripped);
			if (!isSearch && !isRead && !isList) return undefined;
			const kind: CollapseKind = isSearch ? "search" : isList && !isRead ? "list" : "read";
			return {
				kind,
				hint:
					comment !== undefined
						? { kind: "comment", value: comment }
						: { kind: "command", value: compactCommand(stripped) },
			};
		}
		default:
			return undefined;
	}
}

// dsh-tui collapse.ts: CollapsedGroup (trimmed to what the renderer needs).
export interface CollapsedGroup {
	searchCount: number;
	readCount: number;
	listCount: number;
	bashCount: number;
	mcpCallCount: number;
	mcpServers: readonly string[];
	thinkingMs: number;
	running: boolean;
	active: boolean;
	failed: boolean;
}

// dsh-tui transcript.ts: COLLAPSE_THINKING_MIN_MS
export const COLLAPSE_THINKING_MIN_MS = 1_000;

// dsh-tui i18n/messages.ts: collapse.* strings (English).
function plural(count: number, one: string, other: string): string {
	return count === 1 ? one : other;
}

// The thinking duration is a settled accumulator (no open-interval wall clock):
// it is attributed to the group when the thinking span closes, before the
// group's tools start. Latest CC (v2.1.234, observed in-transcript) folds this
// duration into the collapsed group line itself — present tense "thinking for
// Xs" while the group is active, past "thought for Xs" once settled. (The local
// CC source snapshot is older and still skips thinking in collapseReadSearch;
// the spinner row's own thinkingStatus clock is a separate, live signal.)
export function groupThinkingMs(group: CollapsedGroup): number {
	return Math.max(0, group.thinkingMs);
}

function formatDuration(ms: number): string {
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

/**
 * dsh-tui transcript.ts: collapsedSummary — present tense while the group runs,
 * past tense once it settles; each fragment agrees with its own count. The
 * running/settled tense is driven by `group.running`, not by a wall clock.
 * `styleCount` styles the count numbers (CC CollapsedReadSearchContent wraps
 * every count in <Bold>); defaults to plain. The thinking duration is a clock,
 * not a count, so it is never styled — and CC only shows it settled ("thought
 * for Xs"), so there is no live-ticking parameter here.
 */
export function collapsedSummary(
	group: CollapsedGroup,
	styleCount?: (count: number) => string,
): string {
	const n = (count: number): string => (styleCount ? styleCount(count) : String(count));
	const parts: string[] = [];
	// CC v2.1.234 — tense follows the group's ACTIVE window (present until the
	// whole generation run settles, through thinking pauses between batches),
	// not just whether a member is mid-flight (`running`). AUDIT §6 P2 "工具一
	// 跑完就变过去时,CC 会一直保持进行时到整轮生成结束".
	const phase = group.active ? "active" : "settled";
	const fragment = (kind: "search" | "read" | "list", count: number): void => {
		const text =
			kind === "search"
				? plural(count, `searching for ${n(count)} pattern`, `searching for ${n(count)} patterns`)
				: kind === "read"
					? plural(count, `reading ${n(count)} file`, `reading ${n(count)} files`)
					: plural(count, `listing ${n(count)} directory`, `listing ${n(count)} directories`);
		const settled =
			kind === "search"
				? plural(count, `searched for ${n(count)} pattern`, `searched for ${n(count)} patterns`)
				: kind === "read"
					? plural(count, `read ${n(count)} file`, `read ${n(count)} files`)
					: plural(count, `listed ${n(count)} directory`, `listed ${n(count)} directories`);
		parts.push(phase === "active" ? text : settled);
	};
	// CC folds the thinking duration into the collapsed group line: present
	// tense "thinking for Xs" while the group runs, past "thought for Xs"
	// once settled — same active/settled tense as the search/read fragments.
	const thinking = groupThinkingMs(group);
	if (thinking >= COLLAPSE_THINKING_MIN_MS) {
		parts.push(phase === "active" ? `thinking for ${formatDuration(thinking)}` : `thought for ${formatDuration(thinking)}`);
	}
	if (group.searchCount > 0) fragment("search", group.searchCount);
	if (group.readCount > 0) fragment("read", group.readCount);
	if (group.listCount > 0) fragment("list", group.listCount);
	if (group.mcpCallCount > 0) {
		const server = group.mcpServers.length > 0 ? group.mcpServers.join(", ") : "MCP";
		const active = plural(group.mcpCallCount, `querying ${server}`, `querying ${server} ${n(group.mcpCallCount)} times`);
		const settled = plural(group.mcpCallCount, `queried ${server}`, `queried ${server} ${n(group.mcpCallCount)} times`);
		parts.push(phase === "active" ? active : settled);
	}
	// CC CollapsedReadSearchContent.tsx:403-413 — bash counted last (CC gates it
	// on fullscreen; pi has no fullscreen, so every grouped bash call counts).
	if (group.bashCount > 0) {
		const noun = plural(group.bashCount, "bash command", "bash commands");
		parts.push(`${phase === "active" ? "running" : "ran"} ${n(group.bashCount)} ${noun}`);
	}
	const text = parts.join(", ");
	// CC CollapsedReadSearchContent: first fragment capitalized ('Read 3 files, searched for…').
	const capped = text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
	return group.active ? `${capped}…` : capped;
}

/** dsh-tui collapse.ts: formatCollapseHint */
export function formatCollapseHint(hint: CollapseHint, displayPath: (path: string) => string): string {
	const text =
		hint.kind === "path"
			? displayPath(hint.value)
			: hint.kind === "thinking"
				? hint.value
				: hint.kind === "pattern"
					? `"${hint.value}"`
					: hint.kind === "comment"
						? hint.value
						: `$ ${hint.value}`;
	return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
