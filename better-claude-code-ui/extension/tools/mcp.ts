/**
 * MCP tool rendering — generic wrapper for mcp__* tools with three output modes
 * (hidden / summary / preview), ported from pi-claude-code-ui's MCP overrides.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { makeText, armBlink, currentBlinkPhase } from "./grouping.js";

type RenderContext = {
	state: Record<string, unknown>;
	lastComponent: unknown;
	invalidate: () => void;
	toolCallId: string;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	isError: boolean;
	args: unknown;
};

export type McpOutputMode = "hidden" | "summary" | "preview";

let mcpOutputMode: McpOutputMode = "preview";

export function setMcpOutputMode(mode: McpOutputMode): void {
	mcpOutputMode = mode;
}

export function getMcpOutputMode(): McpOutputMode {
	return mcpOutputMode;
}

function humanizeToolName(name: string): string {
	const raw = name.replace(/^mcp__[^_]+__/, "");
	return raw
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const parts: string[] = [];
	for (const [k, v] of Object.entries(a)) {
		if (v === undefined || v === null) continue;
		const s = typeof v === "string" ? v : JSON.stringify(v);
		parts.push(`${k}=${s.length > 40 ? `${s.slice(0, 39)}…` : s}`);
		if (parts.length >= 3) break;
	}
	return parts.join(" ");
}

function resultText(result: unknown): string {
	const r = result as { content?: Array<{ type: string; text?: string }> } | undefined;
	if (!r || !Array.isArray(r.content)) return "";
	return r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

function statusDot(ctx: RenderContext, theme: Theme): string {
	if (ctx.isError) return theme.fg("error", "●");
	if (ctx.isPartial) {
		if (ctx.executionStarted) {
			armBlink();
			return currentBlinkPhase() ? theme.fg("warning", "●") : " ";
		}
		return theme.fg("dim", "●");
	}
	return theme.fg("success", "●");
}

/**
 * Wrap every registered MCP tool with a CC-style renderer. Called on
 * session_start and before_agent_start (MCP tools may register late).
 */
export function registerMcpTools(pi: ExtensionAPI): void {
	const wrapped = new Set<string>();
	const wrap = () => {
		let all: unknown[] = [];
		try {
			all = pi.getAllTools();
		} catch {
			all = [];
		}
		for (const tool of all) {
			const rec = tool as Record<string, unknown>;
			const name = typeof rec.name === "string" ? rec.name : "";
			if (!name || wrapped.has(name)) continue;
			// Only wrap MCP tools (mcp__ prefix or self-identified).
			const isMcp = name.startsWith("mcp__") || name === "mcp";
			if (!isMcp) continue;
			const execute = rec.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
			if (!execute) continue;
			const label = humanizeToolName(name);
			const description = typeof rec.description === "string" ? rec.description : "MCP tool";
			const parameters = rec.parameters;
			wrapped.add(name);
			pi.registerTool({
				name,
				label,
				description,
				parameters: parameters as never,
				renderShell: "self",
				async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) {
					return (await execute(toolCallId, params, signal, onUpdate as never, ctx as never)) as never;
				},
				renderCall(args: unknown, theme: Theme, ctx: RenderContext) {
					if (mcpOutputMode === "hidden") return makeText(ctx.lastComponent, "");
					const dot = statusDot(ctx, theme);
					const summary = summarizeArgs(args);
					const header = `${dot} ${theme.fg("toolTitle", theme.bold(label))}${summary ? ` ${theme.fg("accent", summary)}` : ""}`;
					return makeText(ctx.lastComponent, header);
				},
				renderResult(result: unknown, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme, ctx: RenderContext) {
					if (mcpOutputMode === "hidden") return makeText(ctx.lastComponent, "");
					if (isPartial) return makeText(ctx.lastComponent, theme.fg("dim", "..."));
					if (mcpOutputMode === "summary") {
						const text = resultText(result);
						const oneLine = text.replace(/\s+/g, " ").trim();
						return makeText(ctx.lastComponent, theme.fg("dim", oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine));
					}
					// preview
					const text = resultText(result);
					const lines = text.split("\n").filter((l) => l.trim().length > 0);
					if (lines.length === 0) return makeText(ctx.lastComponent, theme.fg("muted", "(no output)"));
					const limit = expanded ? 4000 : 8;
					const shown = lines.slice(0, limit);
					const remaining = lines.length - shown.length;
					let out = shown.map((l) => theme.fg("dim", l)).join("\n");
					if (remaining > 0) out += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
					return makeText(ctx.lastComponent, out);
				},
			});
		}
	};
	pi.on("session_start", async () => wrap());
	pi.on("before_agent_start", async () => wrap());
}
