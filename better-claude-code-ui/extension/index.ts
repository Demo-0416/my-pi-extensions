/**
 * better-claude-code-ui — Claude Code visual identity for pi.
 *
 * Layers:
 *   1. themes/            six CC color themes (JSON, loaded by pi)
 *   2. chrome             banner (welcome box), spinner, status line, turn footer
 *   3. tools/             CC-style tool rendering (builtins, diff, grouping)
 *   4. thinking           CC-style thinking title + hidden label + spinner row
 *
 * Layers 1-4 use only pi public extension APIs. host-patches.ts additionally
 * wraps two prototype methods of PUBLIC pi exports (AssistantMessageComponent,
 * InteractiveMode) as the extension-side landing of the upstream PR draft —
 * see its header for scope and removal criteria.
 * See ALIGNMENT.md for the per-module CC source mapping.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installHostPatches } from "./host-patches.js";
import { registerSpinner } from "./spinner.js";
import { registerTurnFooter } from "./turn-footer.js";
import { registerBanner } from "./banner.js";
import { registerStatusLine } from "./status-line.js";
import { registerGrouping } from "./tools/grouping.js";
import { registerBuiltins } from "./tools/builtins.js";
import { registerCommands } from "./commands.js";
import { registerThinking } from "./thinking.js";
import { registerPromptPointer } from "./prompt-editor.js";

export default function (pi: ExtensionAPI) {
	// Host patches (ghost blank rows, ctrl+o status residue) — before any render.
	installHostPatches();

	// Layer 2: chrome
	registerSpinner(pi);
	registerTurnFooter(pi);
	registerBanner(pi);
	registerStatusLine(pi);
	registerPromptPointer(pi);

	// Layer 3: tool rendering
	registerGrouping(pi);
	registerBuiltins(pi);

	// Layer 4: thinking (transformer + hidden label + spinner-row coordination)
	registerThinking(pi);

	// Commands + shortcuts
	registerCommands(pi);
}
