/**
 * better-claude-code-ui — Claude Code visual identity for pi.
 *
 * Layers:
 *   1. themes/            six CC color themes (JSON, loaded by pi)
 *   2. chrome             banner (welcome box), spinner, status line, turn footer
 *   3. tools/             CC-style tool rendering (builtins, diff, grouping, mcp)
 *   4. thinking           CC-style thinking title + hidden label + spinner row
 *
 * Only pi public APIs are used; no prototype/monkey patches.
 * See ALIGNMENT.md for the per-module CC source mapping.
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
import { registerThinking } from "./thinking.js";

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

	// Layer 4: thinking (transformer + hidden label + spinner-row coordination)
	registerThinking(pi);

	// Commands + shortcuts
	registerCommands(pi);
}
