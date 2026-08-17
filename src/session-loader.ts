/**
 * 历史会话回放（DESIGN.md 3.7）。
 *
 * 两级精度：sidecar 存在 = rich（精确时长/TTFT）；
 * 不存在 = 从 session JSONL 重建（timestamp 精确，duration 用相邻记录间隔推断，
 * TTFT 不可得显示 `—`），精度标记 `reconstructed`。
 *
 * 重建启发式（无 sidecar 时）：
 * - user/assistant/toolResult 消息 → 对应记录，`startedAt = message.timestamp`
 * - `durationMs` = 下一条记录起点 − 本条起点（最后一条为 null）
 * - TTFT = null
 * - `model_change` entry → 记为 system 备注
 * - turn 切分：每条 assistant 消息开一个新 turn；其前的 user 消息归入该 turn；
 *   tool 记录归入调用它的 assistant 所在 turn（pi 语义：一个 turn = 一次 LLM 响应 + 其工具调用）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SessionSummary, TraceRecord, TraceSession, TraceUsage } from './model.ts';
import { groupRecordsByTurn } from './model.ts';
import { SESSIONS_DIR, readSidecar, scanSidecars, sidecarPath, truncateField } from './store.ts';

// --- session JSONL 最小结构（对齐 docs/session-format.md） ---

interface SessionHeader {
  type: 'session';
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface SessionMessage {
  role: 'user' | 'assistant' | 'toolResult' | string;
  content?: string | ContentBlock[];
  timestamp: number;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  details?: { exitCode?: number } & Record<string, unknown>;
  isError?: boolean;
}

interface SessionEntry {
  type: string;
  id?: string;
  timestamp: string;
  message?: SessionMessage;
  provider?: string;
  modelId?: string;
  summary?: string;
  tokensBefore?: number;
}

function textOf(content: string | ContentBlock[] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function thinkingOf(content: string | ContentBlock[] | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') parts.push(block.thinking);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function toolCallsOf(content: string | ContentBlock[] | undefined): Array<{ callId: string; name: string; argsRaw: string }> | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls: Array<{ callId: string; name: string; argsRaw: string }> = [];
  for (const block of content) {
    if (block.type === 'toolCall' && block.id && block.name) {
      let argsRaw = '{}';
      if (block.arguments !== undefined) {
        try { argsRaw = JSON.stringify(block.arguments); } catch { argsRaw = String(block.arguments); }
      }
      calls.push({ callId: block.id, name: block.name, argsRaw });
    }
  }
  return calls.length > 0 ? calls : undefined;
}

function oneLine(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function usageOf(message: SessionMessage): TraceUsage | undefined {
  const usage = message.usage;
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    costTotal: usage.cost?.total ?? 0,
  };
}

/** 从 session JSONL 重建 TraceSession（3.7 启发式）。 */
export function reconstructFromSessionFile(
  sessionFile: string,
  fallbackSessionId?: string,
): TraceSession | null {
  if (!existsSync(sessionFile)) return null;
  const lines = readFileSync(sessionFile, 'utf8').split('\n');
  let header: SessionHeader | null = null;
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = parsed as SessionEntry;
    if (entry.type === 'session' && header === null) {
      header = entry as unknown as SessionHeader;
      continue;
    }
    entries.push(entry);
  }
  if (header === null) return null;

  const sessionId = header.id ?? fallbackSessionId ?? 'unknown';
  const records: TraceRecord[] = [];
  // toolCallId → args（assistant 消息的 toolCall 块），供 toolResult 记录补全 args。
  const toolArgsById = new Map<string, Record<string, unknown>>();
  let seq = 0;
  let currentTurn = -1;
  let pendingUser: TraceRecord[] = [];

  const push = (record: Omit<TraceRecord, 'id' | 'durationMs'>): TraceRecord => {
    const full: TraceRecord = {
      ...record,
      id: `${sessionId}-r${seq++}`,
      durationMs: null,
    };
    records.push(full);
    return full;
  };

  for (const entry of entries) {
    if (entry.type === 'message' && entry.message) {
      const message = entry.message;
      const startedAt = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp);
      if (message.role === 'user') {
        const fullText = textOf(message.content);
        const record = push({
          kind: 'user',
          turn: null,
          startedAt,
          text: oneLine(fullText),
          fullText: fullText || undefined,
          isError: false,
        });
        pendingUser.push(record);
      } else if (message.role === 'assistant') {
        currentTurn += 1;
        const turn = currentTurn;
        for (const record of pendingUser) record.turn = turn;
        pendingUser = [];
        // 索引 toolCall 参数，供后续 toolResult 记录使用。
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const block of blocks) {
          if (block.type === 'toolCall' && block.id && block.arguments) {
            toolArgsById.set(block.id, block.arguments);
          }
        }
        const fullText = textOf(message.content);
        push({
          kind: 'assistant',
          turn,
          startedAt,
          text: oneLine(fullText),
          fullText: fullText || undefined,
          thinking: thinkingOf(message.content),
          toolCalls: toolCallsOf(message.content),
          isError: message.stopReason === 'error',
          model: message.model,
          provider: message.provider,
          usage: usageOf(message),
          ttftMs: null,
        });
      } else if (message.role === 'toolResult') {
        const turn = currentTurn < 0 ? null : currentTurn;
        const args = message.toolCallId ? toolArgsById.get(message.toolCallId) : undefined;
        push({
          kind: 'tool',
          turn,
          startedAt,
          text: `${message.toolName ?? 'tool'} ${oneLine(JSON.stringify(args ?? {}), 120)}`,
          isError: message.isError === true,
          toolName: message.toolName,
          callId: message.toolCallId,
          args: truncateField(args),
          result: truncateField(textOf(message.content)),
          exitCode: message.details?.exitCode,
        });
      }
      continue;
    }
    if (entry.type === 'model_change') {
      push({
        kind: 'system',
        turn: currentTurn < 0 ? null : currentTurn,
        startedAt: Date.parse(entry.timestamp),
        text: `model → ${entry.provider ?? '?'}/${entry.modelId ?? '?'}`,
        isError: false,
      });
      continue;
    }
    if (entry.type === 'compaction') {
      push({
        kind: 'compaction',
        turn: currentTurn < 0 ? null : currentTurn,
        startedAt: Date.parse(entry.timestamp),
        text: oneLine(entry.summary ?? `compaction (${entry.tokensBefore ?? '?'} tokens before)`),
        isError: false,
      });
      continue;
    }
  }
  // 悬挂的 user 消息（无后续 assistant）归入最后一个 turn 之后的 null 区。
  for (const record of pendingUser) record.turn = null;

  // durationMs = 下一条记录起点 − 本条起点（最后一条为 null）。
  for (const [index, record] of records.entries()) {
    const next = records[index + 1];
    if (next !== undefined) {
      record.durationMs = Math.max(0, next.startedAt - record.startedAt);
    }
  }

  const startedAt = Date.parse(header.timestamp) || records[0]?.startedAt || Date.now();
  const last = records[records.length - 1];
  return {
    sessionId,
    sessionFile,
    cwd: header.cwd ?? '',
    startedAt,
    endedAt: last ? last.startedAt + (last.durationMs ?? 0) : null,
    turns: groupRecordsByTurn(records),
    records,
    precision: 'reconstructed',
  };
}

/** sidecar → 完整 TraceSession（rich）。 */
export function sessionFromSidecar(
  sessionId: string,
  sessionFile?: string,
): TraceSession | null {
  const loaded = readSidecar(sessionId);
  if (loaded === null) return null;
  const records = loaded.records;
  const startedAt = loaded.meta?.startedAt ?? records[0]?.startedAt ?? Date.now();
  const last = records[records.length - 1];
  return {
    sessionId,
    sessionFile: loaded.meta?.sessionFile ?? sessionFile ?? sidecarPath(sessionId),
    cwd: loaded.meta?.cwd ?? '',
    startedAt,
    endedAt: last ? last.startedAt + (last.durationMs ?? 0) : null,
    turns: groupRecordsByTurn(records),
    records,
    precision: 'rich',
  };
}

/**
 * 加载会话：sidecar 优先（rich），否则按 sessionFile 重建（reconstructed）。
 * 都没有则返回 null。
 */
export function loadSession(sessionId: string, sessionFile?: string): TraceSession | null {
  const rich = sessionFromSidecar(sessionId, sessionFile);
  if (rich !== null && rich.records.length > 0) return rich;
  const file = sessionFile ?? findSessionFileById(sessionId);
  if (file) {
    const reconstructed = reconstructFromSessionFile(file, sessionId);
    if (reconstructed !== null) return reconstructed;
  }
  return rich;
}

/** 递归收集 sessions 目录下全部 .jsonl 文件。 */
function listSessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listSessionFiles(path));
    } else if (entry.endsWith('.jsonl')) {
      out.push(path);
    }
  }
  return out;
}

/** id → session 文件路径缓存（mtime 失效）。 */
let sessionFileIndex: { builtAt: number; byId: Map<string, string> } | null = null;
const INDEX_TTL_MS = 10_000;

/** 按 session id 查 session 文件路径（扫 sessions 目录，10s 缓存）。 */
export function findSessionFileById(sessionId: string): string | null {
  const now = Date.now();
  if (sessionFileIndex === null || now - sessionFileIndex.builtAt > INDEX_TTL_MS) {
    const byId = new Map<string, string>();
    for (const file of listSessionFiles(SESSIONS_DIR)) {
      const header = readHeader(file);
      if (header !== null) byId.set(header.id, file);
    }
    sessionFileIndex = { builtAt: now, byId };
  }
  return sessionFileIndex.byId.get(sessionId) ?? null;
}

/** 读 session 文件头（第一行）。 */
function readHeader(path: string): SessionHeader | null {
  let firstLine: string;
  try {
    firstLine = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine) as SessionHeader;
    return parsed.type === 'session' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 会话列表（DESIGN.md 3.7）：扫 sessions 目录（元信息）+ traces 目录（rich 标记）合并。
 * @param liveIds 当前进程内活跃采集的会话 id（标记 precision=live）。
 */
export function listSessions(liveIds: ReadonlySet<string> = new Set()): SessionSummary[] {
  const byId = new Map<string, SessionSummary>();
  for (const file of listSessionFiles(SESSIONS_DIR)) {
    const header = readHeader(file);
    if (header === null) continue;
    const startedAt = Date.parse(header.timestamp);
    byId.set(header.id, {
      sessionId: header.id,
      sessionFile: file,
      cwd: header.cwd ?? '',
      startedAt: Number.isFinite(startedAt) ? startedAt : 0,
      endedAt: null,
      turnCount: 0,
      recordCount: 0,
      precision: liveIds.has(header.id) ? 'live' : 'reconstructed',
    });
  }
  // sidecar 覆盖：rich 精度 + 记录数。
  for (const sidecar of scanSidecars()) {
    const existing = byId.get(sidecar.sessionId);
    const precision = liveIds.has(sidecar.sessionId) ? 'live' : 'rich';
    if (existing !== undefined) {
      existing.precision = precision;
      existing.recordCount = sidecar.recordCount;
      if (sidecar.lastStartedAt !== null) existing.endedAt = sidecar.lastStartedAt;
      if (sidecar.startedAt !== null) existing.startedAt = sidecar.startedAt;
    } else {
      byId.set(sidecar.sessionId, {
        sessionId: sidecar.sessionId,
        sessionFile: '',
        cwd: sidecar.cwd ?? '',
        startedAt: sidecar.startedAt ?? 0,
        endedAt: sidecar.lastStartedAt,
        turnCount: 0,
        recordCount: sidecar.recordCount,
        precision,
      });
    }
  }
  // turn 数：rich 会话从 sidecar 记录算；reconstructed 会话从 assistant 消息数算。
  for (const summary of byId.values()) {
    if (summary.precision === 'reconstructed' && summary.sessionFile) {
      summary.turnCount = countAssistantMessages(summary.sessionFile);
    } else {
      const loaded = readSidecar(summary.sessionId);
      const turns = new Set<number>();
      for (const record of loaded?.records ?? []) {
        if (record.turn !== null) turns.add(record.turn);
      }
      summary.turnCount = turns.size;
    }
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** 统计 session 文件里的 assistant 消息数（重建会话的 turn 数近似）。 */
function countAssistantMessages(sessionFile: string): number {
  let count = 0;
  try {
    for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || !trimmed.includes('"assistant"')) continue;
      try {
        const entry = JSON.parse(trimmed) as SessionEntry;
        if (entry.type === 'message' && entry.message?.role === 'assistant') count += 1;
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return count;
}

/**
 * /api/from-file 用：任意 session 文件即时重建。
 * 调用方（server）必须先做路径安全校验（resolve 后位于 SESSIONS_DIR 内）。
 */
export function reconstructFromPath(path: string): TraceSession | null {
  return reconstructFromSessionFile(resolve(path));
}
