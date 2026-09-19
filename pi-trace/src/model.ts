/**
 * pi-trace 数据模型（DESIGN.md 3.2 节）。
 *
 * 采集与展示分离：Collector 只认 pi 事件，输出统一 TraceRecord；
 * Web/TUI/历史回放都是 TraceRecord 的消费者。
 */

/** 记录种类（对齐 dsh TrajectoryCellKind）。 */
export type RecordKind = 'system' | 'user' | 'context' | 'assistant' | 'tool' | 'compacted';

/** 一次 LLM 调用的 token / 费用账（字段名对齐 pi session-format 的 Usage）。 */
export interface TraceUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
  /** reasoning/thinking tokens（output 的子集，provider 上报时才有）。 */
  reasoning?: number;
}

/** 一条轨迹记录 = dsh TrajectoryCellProps 的 pi 版投影。 */
export interface TraceRecord {
  /** 稳定身份：`<sessionId>-<seq>`，upsert 与 React key 都用它。 */
  id: string;
  kind: RecordKind;
  /** 所属 turn（pi turnIndex，0-based）；首条 user 记录在 turn_start 前到达，先为 null。 */
  turn: number | null;
  /** epoch ms。 */
  startedAt: number;
  /** rich 精确；重建为推断；user/system 为 null。 */
  durationMs: number | null;
  /** 完成状态独立于时长：历史记录可能已完成，但时间戳不足以计算时长。 */
  completed?: boolean;
  /** 单行摘要（CSS ellipsis）。 */
  text: string;
  /** 完整正文（user/assistant，8KB 截断；dsh previewMarkdown/outputDetail 用）。 */
  fullText?: string;
  isError: boolean;
  model?: string;
  provider?: string;
  usage?: TraceUsage;
  /** 仅 assistant、仅 rich。 */
  ttftMs?: number | null;
  toolName?: string;
  args?: unknown;
  /** 截断后的最终结果（tool_result content / details）。 */
  result?: unknown;
  /** system 记录：system prompt 快照（独立 8KB 截断预算，对齐 dsh promptDetail）。 */
  prompt?: string;
  exitCode?: number;
  /** assistant：reasoning/thinking 正文（与 text 分离，对齐 dsh thinkingDetail）。 */
  thinking?: string;
  /** tool：provider 调用 id（关联 assistant 的 tool-call block，对齐 dsh callId）。 */
  callId?: string;
  /** assistant：请求配置（对齐 dsh requestConfig / Options tab）。 */
  requestConfig?: {
    provider?: string;
    model?: string;
    thinking?: string;
    reasoningEffort?: string;
    temperature?: number;
    maxTokens?: number;
    stop?: readonly string[];
  };
  /** assistant：请求时的 model-visible prompt 快照（对齐 dsh promptDetail）。 */
  promptSnapshot?: {
    system: string;
    tools: Array<{ name: string; description?: string; parameters?: unknown }>;
  };
  /** assistant：toolName → schema（对齐 dsh callSchemas / Schema tab）。 */
  toolSchemas?: Record<string, unknown>;
  /** assistant：消息里的 tool_call 块（对齐 dsh AssistantBlock tool-call，比从 tool 记录反推更准）。 */
  toolCalls?: Array<{ callId: string; name: string; argsRaw: string }>;
  /** user：消息来源（对齐 dsh messageSource / Source tab）。 */
  source?: unknown;
  /** 该记录在 session JSONL 中的行号（历史会话按需读原文用）。 */
  sourceLine?: number;
}

/** 一个 turn = 一次 LLM 响应 + 其工具调用（DESIGN.md 3.3）。 */
export interface TraceTurn {
  turn: number;
  startedAt: number;
  endedAt: number | null;
  records: TraceRecord[];
}

/** 一次会话的完整轨迹。 */
export interface TraceSession {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  turns: TraceTurn[];
  records: TraceRecord[];
  /** rich = sidecar 精确时长/TTFT；reconstructed = 从 session JSONL 推断。 */
  precision: 'rich' | 'reconstructed';
}

/** 会话列表项（/api/sessions）。 */
export interface SessionSummary {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  turnCount: number;
  recordCount: number;
  precision: 'rich' | 'reconstructed' | 'live';
  name?: string;
}

/** 构造空会话（全新 session、无历史时）。 */
export function emptySession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  startedAt: number,
): TraceSession {
  return {
    sessionId,
    sessionFile,
    cwd,
    startedAt,
    endedAt: null,
    turns: [],
    records: [],
    precision: 'rich',
  };
}

/** 把记录归入 turn 桶（turn 为 null 的记录挂到 turns 之外，由调用方决定）。 */
export function groupRecordsByTurn(records: readonly TraceRecord[]): TraceTurn[] {
  const byTurn = new Map<number, TraceTurn>();
  for (const record of records) {
    if (record.turn === null) continue;
    let bucket = byTurn.get(record.turn);
    if (bucket === undefined) {
      bucket = { turn: record.turn, startedAt: record.startedAt, endedAt: null, records: [] };
      byTurn.set(record.turn, bucket);
    }
    bucket.records.push(record);
    bucket.startedAt = Math.min(bucket.startedAt, record.startedAt);
    const end = record.startedAt + (record.durationMs ?? 0);
    bucket.endedAt = bucket.endedAt === null ? end : Math.max(bucket.endedAt, end);
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}
