/**
 * 格式化工具。
 *
 * formatDurationMillis / formatElapsedSeconds 移植自 dsh
 * trajectory-record.ts（同名函数，保留原语义：null → "—"）。
 */

/**
 * Format a duration in milliseconds with thousands separators.
 * Source: deepseek-harness/.../trajectory-record.ts formatDurationMillis
 * @param {number|null} milliseconds
 * @returns {string}
 */
export function formatDurationMillis(milliseconds) {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return '—';
  const integer = String(Math.round(milliseconds));
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ms`;
}

/**
 * Source: dsh trajectory-record.ts formatElapsedSeconds
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatElapsedSeconds(seconds) {
  return formatDurationMillis(seconds === null || seconds === undefined ? null : seconds * 1000);
}

/** 人类可读时长：3m09s / 0.5s / 12s / 1h02m。 */
export function formatElapsed(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m${String(restSeconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** 墙钟时间：12:03:22。 */
export function formatClock(timestamp) {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false });
}

/** 带毫秒的墙钟时间（tooltip 用）。 */
export function formatClockMs(timestamp) {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 3 });
}

/** token 数：244K / 6K / 1.2M。 */
export function formatTokens(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

/** 费用：$0.12。 */
export function formatCost(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  return `$${n.toFixed(2)}`;
}

/** 百分比：81%。 */
export function formatPercent(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(0)}%`;
}

/** 日期时间（会话列表用）：2025-08-17 16:13。 */
export function formatDateTime(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
