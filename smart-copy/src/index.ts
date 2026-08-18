/**
 * smart-copy：模仿 Claude Code /copy 的智能复制扩展。
 *
 * /copyx [N]    N=1 最新 assistant 消息（默认），上限 20；弹出切段选择器
 * ctrl+shift+x  等价 /copyx 1
 *
 * 切段（代码块 / Markdown 章节）、多消息切换、w 写文件、alwaysFull 偏好。
 * streaming 中触发降级为直接全量复制，避免 UI 层级冲突。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { buildSegments } from "./segments.ts";
import { pickSegment, writeToFile } from "./picker.ts";
import { configPath, readConfig, writeConfig } from "./config.ts";

const MAX_LOOKBACK = 20;

/** getBranch 条目的最小结构（防御式，不依赖完整 session 类型）。 */
interface BranchEntry {
  type?: string;
  parentId?: string;
  id?: string;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
  };
}

/** 拼接 assistant 消息的 text 块（跳过 thinking / toolCall），trim 后为空返回 ""。 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if ((block as { type?: unknown }).type !== "text") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n\n").trim();
}

/**
 * 倒序收集候选 assistant 消息文本（新→旧，最多 20 条）。
 * 跳过 aborted 且无文本的、纯 tool-call 轮次。导出供测试。
 */
export function collectCandidates(branch: readonly unknown[]): string[] {
  const entries = branch as readonly BranchEntry[];
  if (entries.length === 0) return [];
  // getBranch 文档说从叶子走到根（新→旧）；防御性校验 parentId 链，方向反了就 reverse。
  const first = entries[0]!;
  const second = entries[1];
  const newestFirst = second === undefined
    || (typeof first.parentId === "string" && first.parentId === second.id);
  const ordered = newestFirst ? entries : [...entries].reverse();

  const texts: string[] = [];
  for (const entry of ordered) {
    if (texts.length >= MAX_LOOKBACK) break;
    const msg = entry.message;
    if (entry.type !== "message" || msg?.role !== "assistant") continue;
    const text = extractText(msg.content);
    if (text === "") continue; // 含 aborted 且无文本、纯 tool-call 轮次
    texts.push(text);
  }
  return texts;
}

/** 复制主路径 + 文件 fallback（clipboard 全失败时保证拿得到内容）。 */
async function copyOrFallback(ctx: ExtensionContext, text: string): Promise<void> {
  try {
    await copyToClipboard(text);
    ctx.ui.notify(`Copied ${text.length} chars to clipboard`, "info");
  } catch {
    try {
      const path = writeToFile(text, "response.md");
      ctx.ui.notify(`Clipboard unavailable, written to ${path}`, "warning");
    } catch (e) {
      ctx.ui.notify(`Copy failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }
}

/** 补全用的候选数缓存：getArgumentCompletions 没有 ctx，靠事件刷新。 */
let cachedCandidateCount = 0;
function refreshCandidateCount(ctx: ExtensionContext): void {
  try {
    cachedCandidateCount = collectCandidates(ctx.sessionManager.getBranch() as readonly unknown[]).length;
  } catch {
    // 会话未就绪时保持旧值。
  }
}

async function handleCopyx(args: string, ctx: ExtensionContext): Promise<void> {
  const candidates = collectCandidates(ctx.sessionManager.getBranch() as readonly unknown[]);
  cachedCandidateCount = candidates.length;
  if (candidates.length === 0) {
    ctx.ui.notify("No agent messages to copy yet.", "warning");
    return;
  }

  // /copyx N：1 = 最新，2 = 倒数第二条，…
  let index = 0;
  const arg = args.trim();
  if (arg !== "") {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) {
      ctx.ui.notify(`Usage: /copyx [N] where N is 1 (latest), 2, 3, … Got: ${arg}`, "error");
      return;
    }
    if (n > candidates.length) {
      ctx.ui.notify(
        `Only ${candidates.length} assistant ${candidates.length === 1 ? "message" : "messages"} available to copy`,
        "error",
      );
      return;
    }
    index = n - 1;
  }

  const fullText = candidates[index]!;

  // streaming 中：降级为直接全量复制，不弹选择器（避免 UI 层级冲突）。
  if (ctx.signal !== undefined) {
    await copyOrFallback(ctx, fullText);
    return;
  }

  // alwaysFull 偏好：跳过选择器。
  if (readConfig().alwaysFull === true) {
    await copyOrFallback(ctx, fullText);
    return;
  }

  const build = buildSegments(fullText);
  // 代码块和章节都为 0 → 不弹选择器，直接全量复制。
  if (build.codeBlockCount === 0 && build.sectionCount === 0) {
    await copyOrFallback(ctx, fullText);
    return;
  }

  const outcome = await pickSegment(ctx, candidates, index);
  if (outcome.action === "cancel") return;
  if (outcome.action === "always") {
    writeConfig({ alwaysFull: true });
    await copyOrFallback(ctx, outcome.segment.content);
    ctx.ui.notify(`Preference saved: alwaysFull=true (delete ${configPath()} to revert)`, "info");
    return;
  }
  await copyOrFallback(ctx, outcome.segment.content);
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("copyx", {
    description: "Smart copy: pick code blocks / sections from recent assistant messages",
    getArgumentCompletions: (prefix: string) => {
      const max = cachedCandidateCount > 0
        ? Math.min(MAX_LOOKBACK, cachedCandidateCount)
        : 1;
      const items = [];
      for (let i = 1; i <= max; i++) {
        const value = String(i);
        if (!value.startsWith(prefix)) continue;
        items.push({
          value,
          label: value,
          description: i === 1 ? "latest assistant message" : `${i}th from latest`,
        });
      }
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      await handleCopyx(args, ctx);
    },
  });

  pi.registerShortcut("ctrl+shift+x", {
    description: "Smart copy latest assistant message (/copyx)",
    handler: async (ctx) => {
      await handleCopyx("", ctx);
    },
  });

  // 补全缓存随会话刷新。
  pi.on("session_start", (_event, ctx) => refreshCandidateCount(ctx));
  pi.on("turn_end", (_event, ctx) => refreshCandidateCount(ctx));
}
