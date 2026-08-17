/**
 * Sidecar JSONL 存储（DESIGN.md 3.1/3.11）。
 *
 * 富时序数据（TTFT、精确时长）写 `~/.pi/agent/traces/<sessionId>.jsonl`，
 * 不污染 session JSONL，不进 LLM 上下文。
 *
 * 文件格式：
 *   第 1 行：meta 信封 `{"type":"pi-trace-meta","version":1,...}`
 *   其余行：TraceRecord JSON（一行一条）
 *
 * 安全边界：文件权限 0600；单字段落盘前截断到 ≤ 8KB。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TraceRecord, TraceSession } from './model.ts';

export const TRACES_DIR = join(homedir(), '.pi', 'agent', 'traces');
export const SESSIONS_DIR = join(homedir(), '.pi', 'agent', 'sessions');

/** 单字段截断阈值（DESIGN.md 3.11）。 */
export const MAX_FIELD_BYTES = 8192;

const META_TYPE = 'pi-trace-meta';

interface SidecarMeta {
  type: typeof META_TYPE;
  version: 1;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  startedAt: number;
}

export function sidecarPath(sessionId: string): string {
  return join(TRACES_DIR, `${sessionId}.jsonl`);
}

export function portFilePath(): string {
  return join(TRACES_DIR, '.port');
}

export function ensureTracesDir(): void {
  mkdirSync(TRACES_DIR, { recursive: true });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateString(value: string): string {
  if (byteLength(value) <= MAX_FIELD_BYTES) return value;
  // 按 UTF-8 字节截断，避免切断多字节字符。
  const sliced = Buffer.from(value, 'utf8').subarray(0, MAX_FIELD_BYTES).toString('utf8');
  return `${sliced}…<truncated>`;
}

/**
 * 单字段截断（DESIGN.md 3.11）：字符串直接截；对象先 JSON 序列化，
 * 超限时降级为 `{ _truncated, preview }` 信封，保证前端永远拿到可渲染内容。
 */
export function truncateField(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return truncateString(value);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return truncateString(String(value));
  }
  if (byteLength(json) <= MAX_FIELD_BYTES) return value;
  return { _truncated: true, preview: truncateString(json) };
}

/** 落盘前对一条记录的所有大字段做截断。 */
export function truncateRecord(record: TraceRecord): TraceRecord {
  return {
    ...record,
    text: truncateString(record.text),
    args: truncateField(record.args),
    result: truncateField(record.result),
    ...(record.prompt === undefined ? {} : { prompt: truncateString(record.prompt) }),
    ...(record.fullText === undefined ? {} : { fullText: truncateString(record.fullText) }),
    ...(record.thinking === undefined ? {} : { thinking: truncateString(record.thinking) }),
  };
}

/** 写 meta 信封（仅在文件不存在时）。 */
export function writeMeta(session: TraceSession): void {
  ensureTracesDir();
  const path = sidecarPath(session.sessionId);
  if (existsSync(path)) return;
  const meta: SidecarMeta = {
    type: META_TYPE,
    version: 1,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    cwd: session.cwd,
    startedAt: session.startedAt,
  };
  writeFileSync(path, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  // writeFileSync 的 mode 受 umask 影响，显式 chmod 兜底。
  chmodSync(path, 0o600);
}

/** 追加一条完整记录（调用方负责只在记录闭合后调用）。 */
export function appendRecord(session: TraceSession, record: TraceRecord): void {
  ensureTracesDir();
  writeMeta(session);
  appendFileSync(sidecarPath(session.sessionId), `${JSON.stringify(truncateRecord(record))}\n`, {
    mode: 0o600,
  });
}

export interface LoadedSidecar {
  meta: Omit<SidecarMeta, 'type' | 'version'> | null;
  records: TraceRecord[];
}

/** 读 sidecar；文件不存在或损坏时返回 null / 部分结果。 */
export function readSidecar(sessionId: string): LoadedSidecar | null {
  const path = sidecarPath(sessionId);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  let meta: LoadedSidecar['meta'] = null;
  const records: TraceRecord[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (index === 0 && typeof parsed === 'object' && parsed !== null
      && (parsed as { type?: unknown }).type === META_TYPE) {
      const m = parsed as SidecarMeta;
      meta = {
        sessionId: m.sessionId,
        sessionFile: m.sessionFile,
        cwd: m.cwd,
        startedAt: m.startedAt,
      };
      continue;
    }
    records.push(parsed as TraceRecord);
  }
  return { meta, records };
}

/** 扫描 traces 目录下全部 sidecar（只读 meta + 行数，供会话列表用）。 */
export function scanSidecars(): Array<{
  sessionId: string;
  path: string;
  cwd: string | null;
  startedAt: number | null;
  recordCount: number;
  lastStartedAt: number | null;
}> {
  if (!existsSync(TRACES_DIR)) return [];
  const out: Array<{
    sessionId: string;
    path: string;
    cwd: string | null;
    startedAt: number | null;
    recordCount: number;
    lastStartedAt: number | null;
  }> = [];
  for (const entry of readdirSync(TRACES_DIR)) {
    if (!entry.endsWith('.jsonl')) continue;
    const path = join(TRACES_DIR, entry);
    if (!statSync(path).isFile()) continue;
    const sessionId = entry.slice(0, -'.jsonl'.length);
    const loaded = readSidecar(sessionId);
    if (loaded === null) continue;
    const records = loaded.records;
    let lastStartedAt: number | null = null;
    for (const record of records) {
      if (typeof record.startedAt === 'number') {
        lastStartedAt = lastStartedAt === null ? record.startedAt : Math.max(lastStartedAt, record.startedAt);
      }
    }
    out.push({
      sessionId,
      path,
      cwd: loaded.meta?.cwd ?? null,
      startedAt: loaded.meta?.startedAt ?? (records[0]?.startedAt ?? null),
      recordCount: records.length,
      lastStartedAt,
    });
  }
  return out;
}

/** 供 server 定位 web 静态资源：扩展 src 目录。 */
export function extensionSrcDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

// --- 大字段 blob 存储（system prompt 等超 8KB 的完整内容） --- //

/** blob 存储目录：~/.pi/agent/traces/blobs/<sessionId>/<recordId>.txt */
export function blobDir(sessionId: string): string {
  return join(TRACES_DIR, 'blobs', sessionId);
}

export function blobPath(sessionId: string, recordId: string): string {
  return join(blobDir(sessionId), `${recordId}.txt`);
}

/** 写完整大字段（如 system prompt），返回是否写入。 */
export function writeBlob(sessionId: string, recordId: string, content: string): boolean {
  try {
    mkdirSync(blobDir(sessionId), { recursive: true });
    writeFileSync(blobPath(sessionId, recordId), content, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** 读完整大字段；不存在返回 null。 */
export function readBlob(sessionId: string, recordId: string): string | null {
  try {
    const path = blobPath(sessionId, recordId);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
