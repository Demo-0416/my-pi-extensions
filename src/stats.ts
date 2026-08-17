/**
 * 统计口径（DESIGN.md 3.6 节）。
 *
 * ```
 * 5 轮 · 11 步 · LLM 3m09s · 工具 0.5s · 首 token 平均 5.5s · 47 tok/s
 *   · 缓存命中 81% · 输入 244K tok · 输出 6K tok · $0.12
 * ```
 */
import type { TraceSession, TraceUsage } from './model.ts';

export interface TraceStats {
  /** turn 数 */
  turns: number;
  /** record 数 */
  steps: number;
  /** Σ assistant.durationMs */
  llmMs: number;
  /** Σ tool.durationMs */
  toolMs: number;
  /** Σ ttft / N（仅 rich；无样本为 null） */
  avgTtftMs: number | null;
  /** Σ output / Σ (assistant.durationMs − ttftMs)，单位 tok/s */
  tokPerSec: number | null;
  /** Σ cacheRead / Σ (input + cacheRead) */
  cacheHitRate: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Σ usage.costTotal */
  costTotal: number;
}

function usageOf(record: TraceSession['records'][number]): TraceUsage | undefined {
  return record.usage;
}

/** 按 3.6 口径汇总整个会话。 */
export function computeStats(session: TraceSession): TraceStats {
  const records = session.records;
  let llmMs = 0;
  let toolMs = 0;
  let ttftSum = 0;
  let ttftCount = 0;
  let decodeMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costTotal = 0;

  for (const record of records) {
    if (record.kind === 'assistant') {
      if (record.durationMs !== null) llmMs += record.durationMs;
      if (record.ttftMs !== null && record.ttftMs !== undefined) {
        ttftSum += record.ttftMs;
        ttftCount += 1;
        if (record.durationMs !== null) {
          decodeMs += Math.max(0, record.durationMs - record.ttftMs);
        }
      } else if (record.durationMs !== null) {
        // 无 TTFT 样本时，退化为整段时长都算解码（reconstructed 会话）。
        decodeMs += record.durationMs;
      }
    } else if (record.kind === 'tool' && record.durationMs !== null) {
      toolMs += record.durationMs;
    }
    const usage = usageOf(record);
    if (usage !== undefined) {
      inputTokens += usage.input;
      outputTokens += usage.output;
      cacheReadTokens += usage.cacheRead;
      cacheWriteTokens += usage.cacheWrite;
      costTotal += usage.costTotal;
    }
  }

  const cacheDenom = inputTokens + cacheReadTokens;
  return {
    turns: session.turns.length,
    steps: records.length,
    llmMs,
    toolMs,
    avgTtftMs: ttftCount > 0 ? ttftSum / ttftCount : null,
    tokPerSec: decodeMs > 0 && outputTokens > 0 ? outputTokens / (decodeMs / 1000) : null,
    cacheHitRate: cacheDenom > 0 ? cacheReadTokens / cacheDenom : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costTotal,
  };
}

/** 人类可读时长：3m09s / 0.5s / 12s / 1h02m。 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m${String(restSeconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours}h${String(restMinutes).padStart(2, '0')}m`;
}

/** TUI widget 单行统计（DESIGN.md 3.10）。 */
export function formatStatsLine(stats: TraceStats): string {
  const parts: string[] = [`${stats.turns} 轮`, `LLM ${formatElapsed(stats.llmMs)}`];
  if (stats.toolMs > 0) parts.push(`工具 ${formatElapsed(stats.toolMs)}`);
  if (stats.avgTtftMs !== null) parts.push(`首 token ${formatElapsed(stats.avgTtftMs)}`);
  if (stats.tokPerSec !== null) parts.push(`${stats.tokPerSec.toFixed(1)} tok/s`);
  if (stats.cacheHitRate !== null) parts.push(`缓存 ${(stats.cacheHitRate * 100).toFixed(0)}%`);
  if (stats.costTotal > 0) parts.push(`$${stats.costTotal.toFixed(2)}`);
  return parts.join(' · ');
}

/**
 * TUI widget 单行（DESIGN.md 3.10）：`✻ 5 轮 · LLM 3m09s · 工具 0.5s · 47 tok/s · 缓存 81% · $0.12`。
 * 与 formatStatsLine 的区别：带 ✻ 前缀、省略 TTFT（widget 空间有限）。
 */
export function formatWidgetLine(stats: TraceStats): string {
  const parts: string[] = [`✻ ${stats.turns} 轮`, `LLM ${formatElapsed(stats.llmMs)}`];
  if (stats.toolMs > 0) parts.push(`工具 ${formatElapsed(stats.toolMs)}`);
  if (stats.tokPerSec !== null) parts.push(`${stats.tokPerSec.toFixed(1)} tok/s`);
  if (stats.cacheHitRate !== null) parts.push(`缓存 ${(stats.cacheHitRate * 100).toFixed(0)}%`);
  if (stats.costTotal > 0) parts.push(`$${stats.costTotal.toFixed(2)}`);
  return parts.join(' · ');
}
