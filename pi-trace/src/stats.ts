/**
 * 统计口径（DESIGN.md 3.6 节）。
 *
 * ```
 * 5 轮 · 11 步 · LLM 3m09s · 工具 0.5s · 首 token 平均 5.5s · 47 tok/s
 *   · 缓存命中 81% · 输入 244K tok · 输出 6K tok · $0.12
 * ```
 */
import type { TraceRecord } from './model.ts';

export interface TraceStats {
  /** turn 数 */
  turns: number;
  /** record 数 */
  steps: number;
  /** Σ assistant.durationMs */
  llmMs: number;
  /** tool span 并集的墙钟时长 */
  toolMs: number;
  /** Σ ttft / N（仅 rich；无样本为 null） */
  avgTtftMs: number | null;
  /**
   * 输出速率 tok/s。分子分母必须来自**同一批** assistant 记录：
   * Σ output / Σ decodeMs，只统计「既有解码时长、又有 output token」的记录。
   * 无合格样本为 null。
   *
   * 2026-09-22 修正：部分网关（如 model_hub/es1_orange_o50）的 reasoning token
   * 计入 usage.output，但推理过程**不随流式增量下发**（message 里 thinking 正文
   * 为空、只有签名）。此时 ttft 到 message_end 的窗口只覆盖可见文本的生成时间，
   * 而分子却包含推理 token —— durationMs − ttftMs 作分母会让速率虚高 3-6 倍
   * （实测 408 tok/s vs 端到端 65 tok/s）。凡 reasoning > 0 且 thinking 正文
   * 为空的记录，退回整段 durationMs（端到端口径），见 decodeMsOf。
   */
  tokPerSec: number | null;
  /** tokPerSec 的样本数（合格 assistant 记录数），0 表示该指标不可得。 */
  tokPerSecSamples: number;
  /** Σ cacheRead / Σ (input + cacheRead) */
  cacheHitRate: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 工具嵌套 LLM 调用（subagent 等）的 output token，计入总量但**不进** tokPerSec。 */
  nestedOutputTokens: number;
  /** Σ usage.costTotal */
  costTotal: number;
}

/**
 * tps 单样本的最小解码时长（ms）。
 *
 * 时间戳精度是毫秒，极短 span 上 output/decodeMs 会被舍入误差放大成天文数字
 * （例：200 token / 1ms = 200000 tok/s）。低于该阈值的记录不作为速率样本
 * ——它的 token 同时从分子里剔除，保持分子分母同源。
 */
const MIN_DECODE_MS_FOR_RATE = 50;

function validNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonNegativeOrZero(value: unknown): number {
  return validNonNegative(value) ? value : 0;
}

/** Shared by the aggregate and the browser's per-request timing panel. */
export function outputTokensPerSecond(output: number | null | undefined, durationMs: number | null): number | null {
  if (!validNonNegative(output) || output === 0
    || !validNonNegative(durationMs) || durationMs < MIN_DECODE_MS_FOR_RATE) return null;
  const rate = output / (durationMs / 1000);
  return Number.isFinite(rate) ? rate : null;
}

/**
 * 一条 assistant 记录的「解码时长」：
 * - rich（有 TTFT）：durationMs − ttftMs，即首 token 之后的纯生成时间
 * - reconstructed（无 TTFT）：整段 durationMs（含排队/首包，速率偏保守）
 * 时长缺失（请求进行中、或历史文件里拿不到完成时间）返回 null —— 该记录
 * 既不贡献时间，它的 token 也不能进分子。
 *
 * 例外（reasoning 未随流下发的网关）：usage.reasoning > 0 但 thinking 正文
 * 为空时，推理生成发生在服务端、不产生任何流式增量，ttft 标记的是推理结束后
 * 第一个可见 token 的时刻。此时 decode 窗口（durationMs − ttftMs）根本不包含
 * 推理时间，而分子的 output 包含推理 token —— 扣减 ttft 会得到虚高速率。
 * 这类记录退回整段 durationMs，让分子分母都覆盖完整生成过程。
 */
function decodeMsOf(record: TraceRecord): number | null {
  if (!validNonNegative(record.durationMs)) return null;
  const reasoningUnstreamed = (record.usage?.reasoning ?? 0) > 0 && !record.thinking;
  if (!reasoningUnstreamed && record.ttftMs !== null && record.ttftMs !== undefined) {
    if (!validNonNegative(record.ttftMs) || record.ttftMs > record.durationMs) return null;
    return record.durationMs - record.ttftMs;
  }
  return record.durationMs;
}

/**
 * 工具总时长：取各 tool span 的**并集**而非简单累加。
 * pi 并行工具模式下多个 tool 同时在跑，Σ durationMs 会把同一段墙钟时间
 * 重复计几次，使「工具总时」轻松超过会话实际时长。
 */
function unionMs(spans: ReadonlyArray<readonly [number, number]>): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, cursor] = sorted[0]!;
  for (const [from, to] of sorted.slice(1)) {
    if (from > cursor) {
      total += cursor - start;
      start = from;
      cursor = to;
    } else if (to > cursor) {
      cursor = to;
    }
  }
  return total + (cursor - start);
}

/** 按 3.6 口径汇总整个会话。 */
export function computeStats(session: { records: readonly TraceRecord[]; turns?: readonly unknown[] }): TraceStats {
  const records = session.records;
  let llmMs = 0;
  const toolSpans: Array<readonly [number, number]> = [];
  let ttftSum = 0;
  let ttftCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let nestedOutputTokens = 0;
  let costTotal = 0;
  // tps 的分子/分母成对累加，只收合格样本。
  let rateTokens = 0;
  let rateMs = 0;
  let rateSamples = 0;

  for (const record of records) {
    if (record.kind === 'assistant') {
      llmMs += nonNegativeOrZero(record.durationMs);
      if (validNonNegative(record.ttftMs) && validNonNegative(record.durationMs)
        && record.ttftMs <= record.durationMs) {
        ttftSum += record.ttftMs;
        ttftCount += 1;
      }
      const decodeMs = decodeMsOf(record);
      const output = record.usage?.output ?? 0;
      // 成对入账：只有「解码时长可信 + 有 output」的记录才是速率样本。
      // 失败/中断的请求（isError）时间真实但 token 不完整，整条剔除。
      if (!record.isError && decodeMs !== null && outputTokensPerSecond(output, decodeMs) !== null) {
        rateTokens += output;
        rateMs += decodeMs;
        rateSamples += 1;
      }
    } else if (record.kind === 'tool' && validNonNegative(record.startedAt)
      && validNonNegative(record.durationMs)
      && Number.isFinite(record.startedAt + record.durationMs)) {
      toolSpans.push([record.startedAt, record.startedAt + record.durationMs]);
    }
    const usage = record.usage;
    if (usage !== undefined && (record.kind === 'assistant' || record.kind === 'tool')) {
      inputTokens += nonNegativeOrZero(usage.input);
      outputTokens += nonNegativeOrZero(usage.output);
      cacheReadTokens += nonNegativeOrZero(usage.cacheRead);
      cacheWriteTokens += nonNegativeOrZero(usage.cacheWrite);
      costTotal += nonNegativeOrZero(usage.costTotal);
      // 工具自带 usage = 它内部的嵌套 LLM 调用（subagent）。这些 token 不是
      // 本会话主链路解码出来的，计入总量/费用，但绝不进 tps 分子。
      if (record.kind === 'tool') nestedOutputTokens += nonNegativeOrZero(usage.output);
    }
  }

  const cacheDenom = inputTokens + cacheReadTokens;
  return {
    turns: session.turns?.length ?? new Set(records.filter(r => r.turn !== null).map(r => r.turn)).size,
    steps: records.length,
    llmMs,
    toolMs: unionMs(toolSpans),
    avgTtftMs: ttftCount > 0 ? ttftSum / ttftCount : null,
    tokPerSec: outputTokensPerSecond(rateTokens, rateMs),
    tokPerSecSamples: rateSamples,
    cacheHitRate: cacheDenom > 0 ? cacheReadTokens / cacheDenom : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    nestedOutputTokens,
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
  return widgetLineParts(stats).join(' · ');
}

/** widget 行的各段（未上色），供 TUI 层逐段着色，也便于单测。 */
export function widgetLineParts(stats: TraceStats): string[] {
  const parts: string[] = [`✻ ${stats.turns} 轮`, `LLM ${formatElapsed(stats.llmMs)}`];
  if (stats.toolMs > 0) parts.push(`工具 ${formatElapsed(stats.toolMs)}`);
  if (stats.tokPerSec !== null) parts.push(`${stats.tokPerSec.toFixed(1)} tok/s`);
  if (stats.cacheHitRate !== null) parts.push(`缓存 ${(stats.cacheHitRate * 100).toFixed(0)}%`);
  if (stats.costTotal > 0) parts.push(`$${stats.costTotal.toFixed(2)}`);
  return parts;
}
