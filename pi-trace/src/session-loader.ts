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
import { closeSync, existsSync, openSync, readSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SessionSummary, TraceRecord, TraceSession, TraceUsage } from './model.ts';
import { groupRecordsByTurn } from './model.ts';
import { SESSIONS_DIR, truncateField } from './store.ts';

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
  const content = readFileSync(sessionFile, 'utf8');

  let header: SessionHeader | null = null;
  let sessionId = fallbackSessionId ?? 'unknown';
  const records: TraceRecord[] = [];
  // toolCallId → args（assistant 消息的 toolCall 块），供 toolResult 记录补全 args。
  const toolArgsById = new Map<string, Record<string, unknown>>();
  let seq = 0;
  let currentTurn = -1;
  let pendingUser: TraceRecord[] = [];
  let sourceLine = 0;

  const push = (record: Omit<TraceRecord, 'id' | 'durationMs'>): TraceRecord => {
    const full: TraceRecord = {
      ...record,
      id: `${sessionId}-r${seq++}`,
      durationMs: null,
      ...(sourceLine > 0 ? { sourceLine } : {}),
    };
    records.push(full);
    return full;
  };

  // 逐行处理：indexOf('\n') 避免 split 产生大字符串数组，entries 不留存。
  let lineStart = 0;
  let lineIndex = 0;
  while (lineStart < content.length) {
    lineIndex++;
    sourceLine = lineIndex;
    const lineEnd = content.indexOf('\n', lineStart);
    const line = lineEnd === -1 ? content.slice(lineStart) : content.slice(lineStart, lineEnd);
    lineStart = lineEnd === -1 ? content.length : lineEnd + 1;
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
      sessionId = header.id ?? fallbackSessionId ?? 'unknown';
      continue;
    }
    if (header === null) continue;
    {
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
        kind: 'compacted',
        turn: currentTurn < 0 ? null : currentTurn,
        startedAt: Date.parse(entry.timestamp),
        text: oneLine(entry.summary ?? `compaction (${entry.tokensBefore ?? '?'} tokens before)`),
        isError: false,
      });
      continue;
    }
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

/**
 * 加载会话：从 pi session JSONL 重建。不读 sidecar（插件不写数据）。
 */
export function loadSession(sessionId: string, sessionFile?: string): TraceSession | null {
  const file = sessionFile ?? findSessionFileById(sessionId);
  if (file) {
    const reconstructed = reconstructFromSessionFile(file, sessionId);
    if (reconstructed !== null) return reconstructed;
  }
  return null;
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

/** 读 session 文件头（第一行）。只读前 8KB，不加载整个文件。 */
function readHeader(path: string): SessionHeader | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const bytesRead = readSync(fd, buf, 0, 8192, 0);
      const firstLine = buf.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '';
      const parsed = JSON.parse(firstLine) as SessionHeader;
      return parsed.type === 'session' ? parsed : null;
    } finally {
      closeSync(fd);
    }
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
      turnCount: countAssistantMessages(file),
      recordCount: 0,
      precision: liveIds.has(header.id) ? 'live' : 'reconstructed',
    });
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** 统计 session 文件里的 assistant 消息数（近似值，供会话列表用）。
 *  用 indexOf 计数而非 split+JSON.parse，避免大文件 OOM。 */
function countAssistantMessages(sessionFile: string): number {
  try {
    const content = readFileSync(sessionFile, 'utf8');
    const pattern = '"role":"assistant"';
    let count = 0;
    let idx = content.indexOf(pattern);
    while (idx !== -1) {
      count++;
      idx = content.indexOf(pattern, idx + pattern.length);
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * /api/from-file 用：任意 session 文件即时重建。
 * 调用方（server）必须先做路径安全校验（resolve 后位于 SESSIONS_DIR 内）。
 */
export function reconstructFromPath(path: string): TraceSession | null {
  return reconstructFromSessionFile(resolve(path));
}

/** 从 JSONL 行提取完整字段内容（历史会话 Show full 用）。 */
export function extractFullContent(line: string, field: string): string | null {
  try {
    const entry = JSON.parse(line) as SessionEntry;
    if (entry.type !== 'message' || !entry.message) return null;
    const message = entry.message;
    if (field === 'fullText') return textOf(message.content);
    if (field === 'thinking') return thinkingOf(message.content) || null;
    if (field === 'result' && message.role === 'toolResult') return textOf(message.content);
    return null;
  } catch {
    return null;
  }
}

/** 读文件的第 N 行（1-based），返回 null 如果行号超出范围。 */
export function readLineFromFile(filePath: string, lineNumber: number): string | null {
  try {
    const content = readFileSync(filePath, 'utf8');
    let current = 1;
    let lineStart = 0;
    while (lineStart < content.length) {
      const lineEnd = content.indexOf('\n', lineStart);
      if (current === lineNumber) {
        return lineEnd === -1 ? content.slice(lineStart) : content.slice(lineStart, lineEnd);
      }
      lineStart = lineEnd === -1 ? content.length : lineEnd + 1;
      current++;
    }
    return null;
  } catch {
    return null;
  }
}
