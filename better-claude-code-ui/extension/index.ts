/**
 * better-claude-code-ui — Claude Code visual identity for pi.
 *
 * Layers:
 *   1. themes/            six CC color themes (JSON, loaded by pi)
 *   2. chrome             banner (welcome box), spinner, status line, turn footer
 *   3. tools/             CC-style tool rendering (builtins, diff, grouping, mcp, live preview)
 *
 * Only pi public APIs are used; no prototype/monkey patches.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSpinner } from "./spinner.js";
import { registerTurnFooter } from "./turn-footer.js";
import { registerBanner } from "./banner.js";
import { registerStatusLine } from "./status-line.js";

export default function (pi: ExtensionAPI) {
	registerSpinner(pi);
	registerTurnFooter(pi);
	registerBanner(pi);
	registerStatusLine(pi);
}
