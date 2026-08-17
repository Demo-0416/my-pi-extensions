/**
 * Collector：pi 事件流 → TraceRecord（DESIGN.md 3.3 事件映射表）。
 *
 * 一个 Collector 绑定一个会话，持有内存态 TraceSession，并把闭合后的记录
 * 追加到 sidecar JSONL。Web/TUI/SSE 都是它的消费者。
 *
 * 事件映射（3.3）：
 *   turn_start              开 turn；把先到的 user 记录归入该 turn
 *   before_provider_request 记 LLM 调用起点（payload 里取 model）
 *   message_update          首个 content delta 的时间 = 首 token 时间（算 TTFT）
 *   message_end(user)       追加 user 记录
 *   message_end(assistant)  闭合 LLM span：durationMs/ttftMs/usage
 *   tool_execution_start    开 tool 记录
 *   tool_result             取最终 content/details（截断后存入）
 *   tool_execution_end      闭合 tool 记录
 *   turn_end                闭合 turn；广播 SSE stats
 *   session_compact         追加 compaction 记录
 */
import type { TraceRecord, TraceSession, TraceUsage } from './model.ts';
import { groupRecordsByTurn } from './model.ts';
import { appendRecord, truncateField } from './store.ts';
import { computeStats, type TraceStats } from './stats.ts';

/** SSE 增量事件（DESIGN.md 3.8）。 */
export type LiveEvent =
  | { type: 'record'; record: TraceRecord }
  | { type: 'turn'; turn: number; endedAt: number }
  | { type: 'stats'; stats: TraceStats };

type Listener = (event: LiveEvent) => void;

interface LlmStart {
  startedAt: number;
  firstTokenAt: number | null;
  model?: string;
  provider?: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const type = (block as { type?: unknown }).type;
    if (type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

function oneLine(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function usageFromMessage(message: { usage?: unknown }): TraceUsage | undefined {
  const usage = message.usage as
    | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
    | undefined;
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    costTotal: usage.cost?.total ?? 0,
  };
}

export class Collector {
  readonly session: TraceSession;
  private readonly listeners = new Set<Listener>();
  /** LIFO 栈：compaction 等非 turn 的 provider 请求也会入栈，assistant 闭合时取最近一个。 */
  private readonly llmStarts: LlmStart[] = [];
  /** toolCallId → 进行中的 tool 记录。 */
  private readonly openTools = new Map<string, TraceRecord>();
  /** turn_start 前到达的 user 记录（pi 先持久化 user 消息再开 turn）。 */
  private pendingUserRecords: TraceRecord[] = [];
  private currentTurn: number | null = null;
  private seq = 0;

  constructor(session: TraceSession) {
    this.session = session;
    this.seq = session.records.length;
    for (const record of session.records) {
      const match = /-r(\d+)$/.exec(record.id);
      if (match) this.seq = Math.max(this.seq, Number(match[1]) + 1);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: LiveEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个消费者失败不影响采集。
      }
    }
  }

  private nextId(): string {
    return `${this.session.sessionId}-r${this.seq++}`;
  }

  /** 内存追加 + 广播（不落盘；落盘在 closeRecord）。 */
  private addRecord(record: TraceRecord): void {
    this.session.records.push(record);
    this.attachToTurn(record);
    this.session.endedAt = record.startedAt + (record.durationMs ?? 0);
    this.emit({ type: 'record', record });
  }

  private attachToTurn(record: TraceRecord): void {
    if (record.turn === null) return;
    let bucket = this.session.turns.find(t => t.turn === record.turn);
    if (bucket === undefined) {
      bucket = { turn: record.turn, startedAt: record.startedAt, endedAt: null, records: [] };
      this.session.turns.push(bucket);
      this.session.turns.sort((a, b) => a.turn - b.turn);
    }
    bucket.records.push(record);
    bucket.startedAt = Math.min(bucket.startedAt, record.startedAt);
  }

  /** 记录闭合：算 durationMs、落 sidecar、广播 upsert。 */
  private closeRecord(record: TraceRecord, durationMs: number | null): void {
    record.durationMs = durationMs;
    this.attachToTurn(record);
    const end = record.startedAt + (durationMs ?? 0);
    const bucket = record.turn === null
      ? undefined
      : this.session.turns.find(t => t.turn === record.turn);
    if (bucket) bucket.endedAt = bucket.endedAt === null ? end : Math.max(bucket.endedAt, end);
    this.session.endedAt = this.session.endedAt === null ? end : Math.max(this.session.endedAt, end);
    appendRecord(this.session, record);
    this.emit({ type: 'record', record });
  }

  // --- 3.3 事件映射 -------------------------------------------------------

  onTurnStart(turnIndex: number, timestamp: number): void {
    this.currentTurn = turnIndex;
    // user 消息先于 turn_start 到达，归入本 turn。
    for (const record of this.pendingUserRecords) {
      record.turn = turnIndex;
      this.attachToTurn(record);
      appendRecord(this.session, record);
      this.emit({ type: 'record', record });
    }
    this.pendingUserRecords = [];
    if (!this.session.turns.some(t => t.turn === turnIndex)) {
      this.session.turns.push({ turn: turnIndex, startedAt: timestamp, endedAt: null, records: [] });
      this.session.turns.sort((a, b) => a.turn - b.turn);
    }
  }

  onBeforeProviderRequest(payload: unknown, fallbackModel?: string, fallbackProvider?: string): void {
    const payloadModel = typeof payload === 'object' && payload !== null
      ? (payload as { model?: unknown }).model
      : undefined;
    this.llmStarts.push({
      startedAt: Date.now(),
      firstTokenAt: null,
      model: typeof payloadModel === 'string' ? payloadModel : fallbackModel,
      provider: fallbackProvider,
    });
  }

  onMessageUpdate(): void {
    // 首个 content delta 的时间 = 首 token 时间。
    const start = this.llmStarts[this.llmStarts.length - 1];
    if (start !== undefined && start.firstTokenAt === null) {
      start.firstTokenAt = Date.now();
    }
  }

  onMessageEnd(message: {
    role?: string;
    content?: unknown;
    timestamp?: number;
    provider?: string;
    model?: string;
    stopReason?: string;
    usage?: unknown;
  }): void {
    if (message.role === 'user') {
      const record: TraceRecord = {
        id: this.nextId(),
        kind: 'user',
        turn: this.currentTurn,
        startedAt: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
        durationMs: null,
        text: oneLine(textFromContent(message.content)),
        isError: false,
      };
      this.session.records.push(record);
      this.session.endedAt = record.startedAt;
      if (this.currentTurn === null) {
        // 等 turn_start 归属后再落盘 + 广播完整记录。
        this.pendingUserRecords.push(record);
      } else {
        this.attachToTurn(record);
        appendRecord(this.session, record);
        this.emit({ type: 'record', record });
      }
      return;
    }
    if (message.role === 'assistant') {
      const start = this.llmStarts.pop();
      const now = Date.now();
      const startedAt = start?.startedAt
        ?? (typeof message.timestamp === 'number' ? message.timestamp : now);
      const record: TraceRecord = {
        id: this.nextId(),
        kind: 'assistant',
        turn: this.currentTurn,
        startedAt,
        durationMs: null,
        text: oneLine(textFromContent(message.content)),
        isError: message.stopReason === 'error',
        model: start?.model ?? message.model,
        provider: start?.provider ?? message.provider,
        usage: usageFromMessage(message),
        ttftMs: start?.firstTokenAt !== null && start?.firstTokenAt !== undefined
          ? start.firstTokenAt - startedAt
          : null,
      };
      this.session.records.push(record);
      this.closeRecord(record, Math.max(0, now - startedAt));
      return;
    }
    // role=toolResult 的 message_end 忽略：tool 记录以 tool_execution_* 为准。
  }

  onToolExecutionStart(toolCallId: string, toolName: string, args: unknown): void {
    const record: TraceRecord = {
      id: this.nextId(),
      kind: 'tool',
      turn: this.currentTurn,
      startedAt: Date.now(),
      durationMs: null,
      text: `${toolName} ${oneLine(JSON.stringify(args ?? {}), 120)}`,
      isError: false,
      toolName,
      args: truncateField(args),
    };
    this.openTools.set(toolCallId, record);
    this.addRecord(record);
  }

  onToolResult(
    toolCallId: string,
    content: unknown,
    details: unknown,
    isError: boolean,
  ): void {
    const record = this.openTools.get(toolCallId);
    if (record === undefined) return;
    record.result = truncateField(textFromContent(content) || stringifyDetails(details));
    record.isError = isError;
    const exitCode = (details as { exitCode?: unknown } | null)?.exitCode;
    if (typeof exitCode === 'number') record.exitCode = exitCode;
    this.emit({ type: 'record', record });
  }

  onToolExecutionEnd(toolCallId: string, result: unknown, isError: boolean): void {
    const record = this.openTools.get(toolCallId);
    if (record === undefined) return;
    this.openTools.delete(toolCallId);
    if (record.result === undefined) record.result = truncateField(stringifyResult(result));
    record.isError = isError;
    this.closeRecord(record, Math.max(0, Date.now() - record.startedAt));
  }

  onTurnEnd(turnIndex: number): void {
    const bucket = this.session.turns.find(t => t.turn === turnIndex);
    const endedAt = Date.now();
    if (bucket) bucket.endedAt = endedAt;
    this.session.endedAt = endedAt;
    this.currentTurn = null;
    this.emit({ type: 'turn', turn: turnIndex, endedAt });
    this.emit({ type: 'stats', stats: computeStats(this.session) });
  }

  onSessionCompact(summary: string, tokensBefore?: number): void {
    const record: TraceRecord = {
      id: this.nextId(),
      kind: 'compaction',
      turn: this.currentTurn,
      startedAt: Date.now(),
      durationMs: null,
      text: oneLine(summary || `compaction (${tokensBefore ?? '?'} tokens before)`),
      isError: false,
    };
    this.session.records.push(record);
    this.attachToTurn(record);
    appendRecord(this.session, record);
    this.emit({ type: 'record', record });
  }

  onModelChange(provider: string, modelId: string): void {
    const record: TraceRecord = {
      id: this.nextId(),
      kind: 'system',
      turn: this.currentTurn,
      startedAt: Date.now(),
      durationMs: null,
      text: `model → ${provider}/${modelId}`,
      isError: false,
      model: modelId,
      provider,
    };
    this.session.records.push(record);
    this.attachToTurn(record);
    appendRecord(this.session, record);
    this.emit({ type: 'record', record });
  }

  /** 重新分组（sidecar 加载后修正 turn 桶）。 */
  regroup(): void {
    this.session.turns = groupRecordsByTurn(this.session.records);
  }
}

function stringifyDetails(details: unknown): string {
  if (details === undefined || details === null) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function stringifyResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

