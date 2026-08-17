/**
 * pi-trace 数据模型（DESIGN.md 3.2 节）。
 *
 * 采集与展示分离：Collector 只认 pi 事件，输出统一 TraceRecord；
 * Web/TUI/历史回放都是 TraceRecord 的消费者。
 */

/** 记录种类（对齐 dsh trajectory-record.ts 的 TrajectoryCellKind 闭集）。 */
export type RecordKind = 'system' | 'user' | 'assistant' | 'tool' | 'compaction';

/** 一次 LLM 调用的 token / 费用账（字段名对齐 pi session-format 的 Usage）。 */
export interface TraceUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
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
  /** 单行摘要（CSS ellipsis）。 */
  text: string;
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
