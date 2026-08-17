/**
 * better-claude-code-ui — Claude Code visual identity for pi.
 *
 * Layers:
 *   1. themes/            six CC color themes (JSON, loaded by pi)
 *   2. chrome             banner (welcome box), spinner, status line, turn footer
 *   3. tools/             CC-style tool rendering (builtins, diff, grouping, mcp)
 *
 * Only pi public APIs are used; no prototype/monkey patches.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSpinner } from "./spinner.js";
import { registerTurnFooter } from "./turn-footer.js";
import { registerBanner } from "./banner.js";
import { registerStatusLine } from "./status-line.js";
import { registerGrouping } from "./tools/grouping.js";
import { registerBuiltins } from "./tools/builtins.js";
import { registerMcpTools } from "./tools/mcp.js";
import { registerCommands } from "./commands.js";

export default function (pi: ExtensionAPI) {
	// Layer 2: chrome
	registerSpinner(pi);
	registerTurnFooter(pi);
	registerBanner(pi);
	registerStatusLine(pi);

	// Layer 3: tool rendering
	registerGrouping(pi);
	registerBuiltins(pi);
	registerMcpTools(pi);

	// Commands + shortcuts
	registerCommands(pi);

	// ∴ thinking marker: prefix thinking blocks with the CC glyph.
	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType !== "assistant-thinking") return markdown;
		const lines = markdown.split("\n");
		if (lines.length === 0) return markdown;
		lines[0] = `∴ ${lines[0]}`;
		return lines.join("\n");
	});
}
