/**
 * 流水账（DESIGN.md 3.5）：按 Turn 分组、虚拟滚动、搜索过滤。
 *
 * - 搜索索引移植自 dsh trajectory-search-index.ts（小写包含、多词 AND）
 * - 虚拟滚动移植自 dsh trajectory-virtual-rows.ts 的固定行高思路
 *   （CONTENT_ROW_HEIGHT / 分组头行高），窗口化渲染
 * - Turn 分组头可折叠（对齐 dsh TrajectoryTable 的 collapsedTurns）
 */
import { formatClock, formatDurationMillis, formatElapsed } from './format.js';

export const KIND_BADGE = {
  system: 'SYSTEM',
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
  compaction: 'COMPACTION',
};

const HEADER_HEIGHT = 24;
const ROW_HEIGHT = 22;
const OVERSCAN = 12;
const VIRTUAL_THRESHOLD = 200; // DESIGN.md 3.9：> 200 行窗口化

/**
 * 搜索索引（移植自 dsh TrajectorySearchIndex）。
 * 每条记录把可搜索源拼成一段小写文本；查询按空格分词、全部包含才算命中。
 */
export class SearchIndex {
  constructor(session) {
    this.entries = new Map();
    this.update(session);
  }

  static sources(record) {
    const sources = [
      record.kind,
      record.kind === 'assistant' ? 'assistant' : '',
      record.toolName ?? '',
      record.model ?? '',
      record.provider ?? '',
      record.text ?? '',
      SearchIndex.json(record.args),
      SearchIndex.json(record.result),
    ];
    return sources.filter(Boolean).join('\n').toLocaleLowerCase();
  }

  static json(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  update(session) {
    this.entries.clear();
    for (const record of session.records) {
      this.entries.set(record.id, SearchIndex.sources(record));
    }
  }

  /**
   * @param {string} query
   * @returns {Set<string>|null} 命中 id 集合；无查询词返回 null
   */
  search(query) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    const matches = new Set();
    for (const [id, text] of this.entries) {
      if (terms.every(term => text.includes(term))) matches.add(id);
    }
    return matches;
  }
}

/**
 * 把 session 投影成扁平行列表（turn 头 + 记录行），应用搜索/框选/折叠过滤。
 */
function buildRows(session, { searchIds, focusIds, collapsedTurns }) {
  const rows = [];
  const visible = (record) => {
    if (searchIds !== null && !searchIds.has(record.id)) return false;
    if (focusIds !== null && !focusIds.has(record.id)) return false;
    return true;
  };
  const turns = [...session.turns].sort((a, b) => a.turn - b.turn);
  for (const turn of turns) {
    const records = turn.records.filter(visible);
    if (records.length === 0) continue;
    const collapsed = collapsedTurns.has(turn.turn);
    rows.push({ type: 'header', turn: turn.turn, height: HEADER_HEIGHT, collapsed, count: records.length });
    if (!collapsed) {
      for (const record of records) {
        rows.push({ type: 'record', record, height: ROW_HEIGHT });
      }
    }
  }
  const orphans = session.records.filter(r => r.turn === null && visible(r));
  if (orphans.length > 0) {
    rows.push({ type: 'header', turn: null, height: HEADER_HEIGHT, collapsed: false, count: orphans.length });
    for (const record of orphans) {
      rows.push({ type: 'record', record, height: ROW_HEIGHT });
    }
  }
  return rows;
}

function recordSummary(record) {
  if (record.kind === 'assistant') {
    const bits = [];
    if (record.model) bits.push(record.model);
    if (record.ttftMs !== null && record.ttftMs !== undefined) {
      bits.push(`TTFT ${formatElapsed(record.ttftMs)}`);
    }
    if (record.usage) {
      const decodeMs = record.durationMs !== null && record.ttftMs !== null && record.ttftMs !== undefined
        ? Math.max(0, record.durationMs - record.ttftMs) : null;
      if (decodeMs !== null && decodeMs > 0 && record.usage.output > 0) {
        bits.push(`${(record.usage.output / (decodeMs / 1000)).toFixed(1)} tok/s`);
      }
    }
    return bits.join(' · ');
  }
  if (record.kind === 'tool' && record.toolName) {
    const args = typeof record.args === 'object' && record.args !== null
      ? ` ${JSON.stringify(record.args).slice(0, 120)}` : '';
    return `${record.toolName}${args}`;
  }
  return record.text;
}

/**
 * 流水账渲染器：虚拟滚动 + 折叠 + 选中。
 */
export class Ledger {
  /**
   * @param {HTMLElement} container
   * @param {{onSelect:(id:string|null)=>void, onToggleTurn:(turn:number)=>void}} handlers
   */
  constructor(container, { onSelect, onToggleTurn }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onToggleTurn = onToggleTurn;
    this.session = null;
    this.rows = [];
    this.selectedId = null;
    this.virtual = false;

    this.container.innerHTML = '<div class="ledger-scroll"><div class="ledger-canvas"></div></div>';
    this.scroll = this.container.querySelector('.ledger-scroll');
    this.canvas = this.container.querySelector('.ledger-canvas');
    this.scroll.addEventListener('scroll', () => this.renderViewport());
  }

  /**
   * @param {object} session
   * @param {{searchIds?:Set<string>|null, focusIds?:Set<string>|null, collapsedTurns?:Set<number>, selectedId?:string|null}} state
   */
  update(session, state = {}) {
    this.session = session;
    if (state.selectedId !== undefined) this.selectedId = state.selectedId;
    this.rows = buildRows(session, {
      searchIds: state.searchIds ?? null,
      focusIds: state.focusIds ?? null,
      collapsedTurns: state.collapsedTurns ?? new Set(),
    });
    const recordCount = this.rows.filter(r => r.type === 'record').length;
    this.virtual = recordCount > VIRTUAL_THRESHOLD;
    this.renderViewport();
  }

  renderViewport() {
    const rows = this.rows;
    if (rows.length === 0) {
      this.canvas.innerHTML = '<div class="ledger-empty">无匹配记录</div>';
      this.canvas.style.height = 'auto';
      this.canvas.style.paddingTop = '0';
      return;
    }
    if (!this.virtual) {
      this.canvas.style.height = 'auto';
      this.canvas.style.paddingTop = '0';
      this.canvas.innerHTML = '';
      for (const row of rows) this.canvas.appendChild(this.rowEl(row));
      return;
    }
    // 虚拟滚动：固定行高，按 scrollTop 算可见窗口。
    const scrollTop = this.scroll.scrollTop;
    const viewport = this.scroll.clientHeight;
    let offset = 0;
    let startIndex = 0;
    let startOffset = 0;
    for (let i = 0; i < rows.length; i++) {
      if (offset + rows[i].height >= scrollTop - OVERSCAN * ROW_HEIGHT) {
        startIndex = i;
        startOffset = offset;
        break;
      }
      offset += rows[i].height;
    }
    const endOffset = scrollTop + viewport + OVERSCAN * ROW_HEIGHT;
    let endIndex = rows.length;
    let totalHeight = offset;
    for (let i = startIndex; i < rows.length; i++) {
      totalHeight += rows[i].height;
      if (totalHeight > endOffset) {
        endIndex = i + 1;
        break;
      }
    }
    // 兜底：尾部行总高
    let fullHeight = 0;
    for (const row of rows) fullHeight += row.height;
    this.canvas.style.height = `${fullHeight}px`;
    this.canvas.style.paddingTop = `${startOffset}px`;
    this.canvas.innerHTML = '';
    for (let i = startIndex; i < endIndex; i++) {
      this.canvas.appendChild(this.rowEl(rows[i]));
    }
  }

  rowEl(row) {
    if (row.type === 'header') {
      const el = document.createElement('div');
      el.className = 'turn-header';
      el.style.height = `${row.height}px`;
      const label = row.turn === null ? '—' : `Turn ${row.turn + 1}`;
      el.textContent = row.collapsed ? `${label} (${row.count}) ▸` : `${label} ▾`;
      if (row.turn !== null) {
        el.addEventListener('click', () => this.onToggleTurn(row.turn));
      }
      return el;
    }
    const record = row.record;
    const el = document.createElement('div');
    el.className = `record record-${record.kind}${record.isError ? ' record-error' : ''}${record.id === this.selectedId ? ' selected' : ''}`;
    el.style.height = `${row.height}px`;

    const badge = document.createElement('span');
    badge.className = `badge badge-${record.kind}`;
    badge.textContent = KIND_BADGE[record.kind] ?? record.kind;
    el.appendChild(badge);

    const summary = document.createElement('span');
    summary.className = 'summary';
    summary.textContent = recordSummary(record);
    el.appendChild(summary);

    const meta = document.createElement('span');
    meta.className = 'meta';
    const time = formatClock(record.startedAt);
    const duration = record.durationMs !== null ? ` · ${formatElapsed(record.durationMs)}` : '';
    const exit = record.kind === 'tool' && record.exitCode !== undefined ? `  [${record.exitCode}]` : '';
    meta.textContent = `${time}${duration}${exit}`;
    el.appendChild(meta);

    el.addEventListener('click', () => this.onSelect(record.id));
    return el;
  }
}

export { formatDurationMillis as _formatDurationMillis };
