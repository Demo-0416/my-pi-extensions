/**
 * Commands: /cc-tools, /cc-theme, /cc-spinner (same names as the old extension
 * to keep migration cost zero). Extra detail 对齐 CC：无键盘快捷键（CC 只在
 * /config 面板切 verbose），只能 /cc-tools detail 切换，开启时状态栏显示 detail。
 *
 * The group and extra-detail toggles persist to ~/.pi/settings.json (old ext
 * writeSettingsKey pattern) so they survive restarts; grouping.ts reads
 * `groupToolCalls` (same key the old extension used) from the same file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setExtraDetail } from "./tools/builtins.js";
import { bustGroupingSettingsCache, repaintGroupedRows } from "./tools/grouping.js";

const SETTINGS_KEY_GROUP = "groupToolCalls";
const SETTINGS_KEY_EXTRA_DETAIL = "ccToolsExtraDetail";
const SETTINGS_KEY_CC_THEME = "ccTheme";

// Old-ext settings cache (index.ts:121-143): merged cwd + home settings, 5s TTL.
let settingsCache: { value: Record<string, unknown>; timestamp: number } | null = null;
const SETTINGS_CACHE_TTL_MS = 5_000;

function readSettings(): Record<string, unknown> {
	const now = Date.now();
	if (settingsCache && now - settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) {
		return settingsCache.value;
	}
	const merged: Record<string, unknown> = {};
	for (const path of [join(process.cwd(), ".pi", "settings.json"), join(homedir(), ".pi", "settings.json")]) {
		try {
			if (!path || !existsSync(path)) continue;
			const raw = JSON.parse(readFileSync(path, "utf8"));
			if (raw && typeof raw === "object") Object.assign(merged, raw);
		} catch {
			// ignore invalid settings files
		}
	}
	settingsCache = { value: merged, timestamp: now };
	return merged;
}

/** Write one key to ~/.pi/settings.json (old ext index.ts:155-174). Uses
 *  homedir() — the same source readSettings uses, so the toggle survives
 *  even when HOME is unset. */
function writeSettingsKey(key: string, value: unknown): void {
	settingsCache = null; // invalidate cache on write
	const dir = join(homedir(), ".pi");
	const path = join(dir, "settings.json");
	let settings: Record<string, unknown> = {};
	try {
		if (existsSync(path)) settings = JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch {
		/* start fresh */
	}
	if (value === undefined) {
		delete settings[key];
	} else {
		settings[key] = value;
	}
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
	} catch {
		/* best effort */
	}
}

// Initial state from settings: grouping defaults on, extra detail defaults off.
let groupingEnabled = readSettings()[SETTINGS_KEY_GROUP] !== false;
let extraDetail = readSettings()[SETTINGS_KEY_EXTRA_DETAIL] === true;

export function isGroupingEnabled(): boolean {
	return groupingEnabled;
}

export function isExtraDetail(): boolean {
	return extraDetail;
}

export function registerCommands(pi: ExtensionAPI): void {
	// AUDIT §4 / §5:71 (P2 ×11): extraDetail 是持久化的（ccToolsExtraDetail），但
	// builtins.ts 的模块级 extraDetail 只默认 false、且仅由 setExtraDetail() 改写。
	// 启动时没人把持久化值回灌给 builtins → 状态栏读 commands.ts 的 extraDetail 说
	// "on"，实际预览仍按 8 行（off），而第一次 Ctrl+Shift+O 做 setDetail(!extraDetail)
	// = setDetail(false)，把两边都归到 off，看起来“第一次快捷键空按/反而关掉”。
	// 在这里一次性同步：让 builtins 的开关与持久化/显示状态一致。
	setExtraDetail(extraDetail);

	// Restore the CC theme if pi fell back to its built-in default at startup.
	// This happens when the CC theme package isn't registered yet when pi
	// applies the saved theme (package resolution timing in createStartupTui).
	// pi's initTheme catches the load failure and silently falls back to
	// "dark"; without this restore, the user's /cc-theme choice is lost for
	// the rest of the session.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const saved = readSettings()[SETTINGS_KEY_CC_THEME];
		if (typeof saved !== "string" || !saved.startsWith("claude-code-")) return;
		const current = ctx.ui.theme?.name;
		// Only re-apply when the theme fell back to pi's built-in default.
		// If the user intentionally switched to dark/light via /settings,
		// this overrides that choice — but a CC-extension user who picked a
		// CC theme via /cc-theme expects it to stick across projects.
		if (current === "dark" || current === "light") {
			ctx.ui.setTheme(saved);
		}
	});

	const setDetail = (v: boolean) => {
		extraDetail = v;
		setExtraDetail(v);
		writeSettingsKey(SETTINGS_KEY_EXTRA_DETAIL, v);
	};

	const setGrouping = (v: boolean) => {
		groupingEnabled = v;
		writeSettingsKey(SETTINGS_KEY_GROUP, v);
		// grouping.ts caches the setting for 2s; bust it so the toggle is instant.
		bustGroupingSettingsCache();
		// AUDIT §5:372 / commands.ts:88 — the toggle used to change only future
		// renders: hidden member rows stayed blank and leaders kept stale
		// summaries. Push every grouped row (current turn + archived turns) to
		// re-render under the new setting.
		repaintGroupedRows();
	};

	// /cc-tools — control tool UI: grouping, extra detail.
	pi.registerCommand("cc-tools", {
		description: "Control CC tool UI: grouping, extra detail",
		async handler(args, ctx) {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";

			if (sub === "status") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						[
							`Tool grouping: ${groupingEnabled ? "on" : "off"}`,
							`Extra detail: ${extraDetail ? "on" : "off"} (/cc-tools detail on|off|toggle)`,
							"  /cc-tools group on|off|toggle",
							"  /cc-tools detail on|off|toggle",
						].join("\n"),
						"info",
					);
				}
				return;
			}

			if (sub === "group") {
				const v = parts[1];
				if (v === "on" || v === "off") {
					setGrouping(v === "on");
					if (ctx.hasUI) ctx.ui.notify(`Tool grouping: ${v}`, "info");
				} else {
					setGrouping(!groupingEnabled);
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

			if (ctx.hasUI) {
				ctx.ui.notify(`Unknown option "${sub}". Try /cc-tools status.`, "error");
			}
		},
	});

	// /cc-theme — pick one of the shipped CC themes (pi persists the choice via
	// its setTheme path, settings.json `theme`). pi 0.84 has no built-in /theme
	// command — theme switching lives in /settings — so this panel is the fast
	// path for the six CC variants.
	pi.registerCommand("cc-theme", {
		description: "Pick a Claude Code theme",
		async handler(_args, ctx) {
			if (!ctx.hasUI) return;
			const themes = [
				"claude-code-dark",
				"claude-code-light",
				"claude-code-dark-ansi",
				"claude-code-light-ansi",
				"claude-code-dark-daltonized",
				"claude-code-light-daltonized",
			];
			const current = ctx.ui.theme?.name;
			const choice = await ctx.ui.select(
				current ? `Claude Code theme (current: ${current})` : "Claude Code theme",
				themes,
			);
			if (!choice) return;
			const result = ctx.ui.setTheme(choice) as { success?: boolean; error?: string } | boolean | undefined;
			const failed = result === false || (typeof result === "object" && result !== null && result.success === false);
			if (failed) {
				const err = typeof result === "object" && result !== null ? result.error : undefined;
				ctx.ui.notify(`Theme switch failed: ${err ?? choice}`, "error");
				return;
			}
			ctx.ui.notify(`Theme: ${choice}`, "info");
			// Belt-and-suspenders: persist the choice to the extension's own settings
			// file too. pi's setTheme already writes ~/.pi/agent/settings.json, but
			// if the CC theme package isn't registered yet at startup (package
			// resolution timing), pi silently falls back to "dark" and never
			// recovers. The session_start handler below restores it.
			writeSettingsKey(SETTINGS_KEY_CC_THEME, choice);
		},
	});

	// /cc-spinner — show spinner configuration.
	pi.registerCommand("cc-spinner", {
		description: "Show the CC spinner configuration",
		async handler(_args, ctx) {
			if (!ctx.hasUI) return;
			ctx.ui.notify("Spinner: CC frames (· ✢ ✳ ✶ ✻ ✽), 120ms, ~190 fun verbs", "info");
		},
	});

	// CC 没有 verbose 的键盘快捷键 —— claude-code-main 里 verbose 只能在 /config
	// 面板切换（ctrl+shift+o 是 app:toggleTeammatePreview，与 verbose 无关）。
	// 我们曾经把 extra detail 绑到 ctrl+shift+o 和 alt+o：单修饰键和弦在终端里
	// 极易误触（macOS Option 即 ESC 前缀），而开关是持久化的、状态栏又无指示，
	// 误触一次就默默刷几千行（2026-09-22 刷屏事故）。对齐 CC：只保留
	// /cc-tools 命令切换；持久化保留（CC 也持久化 verbose 到 global config），
	// 但开启时状态栏必须有指示（status-line.ts 的 detail 段）。
}
