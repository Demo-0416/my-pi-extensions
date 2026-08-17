/**
 * 路径常量 + 字段截断工具。
 *
 * 插件是纯只读的：不写 trace 数据，只从 pi session JSONL 重建 + 内存采集 live 事件。
 * 唯一的文件写入是 server 启动时写 ~/.pi/agent/traces/.port（端口号）。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRACES_DIR = join(homedir(), '.pi', 'agent', 'traces');
export const SESSIONS_DIR = join(homedir(), '.pi', 'agent', 'sessions');

/** 单字段截断阈值。 */
export const MAX_FIELD_BYTES = 8192;

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
 * 单字段截断：字符串直接截；对象先 JSON 序列化，
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

/** 供 server 定位 web 静态资源：扩展 src 目录。 */
export function extensionSrcDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}
