/**
 * Commands: /cc-tools, /cc-theme, /cc-spinner (same names as the old extension
 * to keep migration cost zero), plus Ctrl+Shift+O extra-detail toggle.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setExtraDetail } from "./tools/builtins.js";
import { getMcpOutputMode, setMcpOutputMode, type McpOutputMode } from "./tools/mcp.js";

let groupingEnabled = true;
let extraDetail = false;

export function isGroupingEnabled(): boolean {
	return groupingEnabled;
}

export function isExtraDetail(): boolean {
	return extraDetail;
}

export function registerCommands(pi: ExtensionAPI): void {
	const setDetail = (v: boolean) => {
		extraDetail = v;
		setExtraDetail(v);
	};

	// /cc-tools — control tool UI: grouping, extra detail, MCP output mode.
	pi.registerCommand("cc-tools", {
		description: "Control CC tool UI: grouping, extra detail, MCP output mode",
		async handler(args, ctx) {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";

			if (sub === "status") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						[
							`Tool grouping: ${groupingEnabled ? "on" : "off"}`,
							`Extra detail: ${extraDetail ? "on" : "off"} (ctrl+shift+o)`,
							`MCP output: ${getMcpOutputMode()}`,
							"  /cc-tools group on|off|toggle",
							"  /cc-tools detail on|off|toggle",
							"  /cc-tools mcp hidden|summary|preview",
						].join("\n"),
						"info",
					);
				}
				return;
			}

			if (sub === "group") {
				const v = parts[1];
				if (v === "on" || v === "off") {
					groupingEnabled = v === "on";
					if (ctx.hasUI) ctx.ui.notify(`Tool grouping: ${v}`, "info");
				} else {
					groupingEnabled = !groupingEnabled;
					if (ctx.hasUI) ctx.ui.notify(`Tool grouping: ${groupingEnabled ? "on" : "off"}`, "info");
				}
				return;
			}

			if (sub === "detail" || sub === "extra") {
				const v = parts[1];
				if (v === "on" || v === "off") {
					setDetail(v === "on");
					if (ctx.hasUI) ctx.ui.notify(`Extra detail: ${v}`, "info");
				} else {
					setDetail(!extraDetail);
					if (ctx.hasUI) ctx.ui.notify(`Extra detail: ${extraDetail ? "on" : "off"}`, "info");
				}
				return;
			}

			if (sub === "mcp") {
				const v = parts[1] as McpOutputMode | undefined;
				if (v === "hidden" || v === "summary" || v === "preview") {
					setMcpOutputMode(v);
					if (ctx.hasUI) ctx.ui.notify(`MCP output: ${v}`, "info");
				} else if (ctx.hasUI) {
					ctx.ui.notify("Usage: /cc-tools mcp hidden|summary|preview", "error");
				}
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(`Unknown option "${sub}". Try /cc-tools status.`, "error");
			}
		},
	});

	// /cc-theme — show the active theme and palette source.
	pi.registerCommand("cc-theme", {
		description: "Show the active CC theme and palette source",
		async handler(_args, ctx) {
			if (!ctx.hasUI) return;
			const themeName = ctx.ui.theme?.name ?? "unknown";
			ctx.ui.notify(`Active theme: ${themeName}`, "info");
		},
	});

	// /cc-spinner — show spinner configuration.
	pi.registerCommand("cc-spinner", {
		description: "Show the CC spinner configuration",
		async handler(_args, ctx) {
			if (!ctx.hasUI) return;
			ctx.ui.notify("Spinner: CC frames (· ✢ ✳ ✶ ✻ ✽), 170ms, ~190 fun verbs", "info");
		},
	});

	// Ctrl+Shift+O — toggle extra detail (preview line cap 8 → 4000).
	pi.registerShortcut("ctrl+shift+o", {
		description: "Toggle CC tool extra-detail mode",
		handler: async (ctx) => {
			setDetail(!extraDetail);
			if (ctx.hasUI) ctx.ui.notify(`Extra detail: ${extraDetail ? "on" : "off"}`, "info");
		},
	});
}
