/**
 * 流水账（DESIGN.md 3.5），视觉对齐 dsh TrajectoryTable：
 * - 彩色 pill 徽章（对齐 dsh kindTag：背景晕染 + 圆角 + 650 字重）
 * - turn rail 竖向连接线 + 小角标（对齐 dsh turnLabel/turnRail）
 * - 行内 model/TTFT/tok-s（对齐 dsh assistant cell 指标）
 * - 运行中记录脉冲（对齐 dsh runningCalls/partial cell）
 * - 搜索索引移植自 dsh trajectory-search-index.ts
 * - 虚拟滚动移植自 dsh trajectory-virtual-rows.ts 固定行高思路
 */
import { formatClock, formatDurationMillis, formatElapsed, formatTokens } from './format.js';

export const KIND_BADGE = {
  system: 'System',
  user: 'User',
  assistant: 'Message',
  tool: 'Tool',
  compaction: 'Compacted',
};

/** 工具图标（对齐 dsh toolCatalogIcon 的视觉占位，用等宽 glyph）。 */
const TOOL_ICONS = {
  bash: '❯', read: '≡', write: '✎', edit: '✎', grep: '⌕', find: '⌕',
  ls: '≡', glob: '⌕', webfetch: '◉', websearch: '⌕', todowrite: '☑',
  task: '☑', mcp: '⬡',
};

const HEADER_HEIGHT = 22;
const ROW_HEIGHT = 24;
const OVERSCAN = 12;
const VIRTUAL_THRESHOLD = 200;

/**
 * 搜索索引（移植自 dsh TrajectorySearchIndex）。
 */
export class SearchIndex {
  constructor(session) {
    this.entries = new Map();
    this.update(session);
  }

  static sources(record) {
    return [
      record.kind,
      record.kind === 'assistant' ? 'assistant message' : '',
      record.toolName ?? '',
      record.model ?? '',
      record.provider ?? '',
      record.text ?? '',
      SearchIndex.json(record.args),
      SearchIndex.json(record.result),
    ].filter(Boolean).join('\n').toLocaleLowerCase();
  }

  static json(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return ''; }
  }

  update(session) {
    this.entries.clear();
    for (const record of session.records) {
      this.entries.set(record.id, SearchIndex.sources(record));
    }
  }

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
        rows.push({ type: 'record', record, height: ROW_HEIGHT, turn: turn.turn });
      }
    }
  }
  const orphans = session.records.filter(r => r.turn === null && visible(r));
  if (orphans.length > 0) {
    rows.push({ type: 'header', turn: null, height: HEADER_HEIGHT, collapsed: false, count: orphans.length });
    for (const record of orphans) {
      rows.push({ type: 'record', record, height: ROW_HEIGHT, turn: null });
    }
  }
  return rows;
}

/** 行内指标（对齐 dsh assistant cell 的 model/timing/usage 内联展示）。 */
function recordMetrics(record) {
  const bits = [];
  if (record.kind === 'assistant') {
    if (record.model) bits.push({ cls: 'metric-model', text: record.model });
    if (record.ttftMs !== null && record.ttftMs !== undefined) {
      bits.push({ cls: 'metric-ttft', text: `TTFT ${formatElapsed(record.ttftMs)}` });
    }
    if (record.usage) {
      const decodeMs = record.durationMs !== null && record.ttftMs !== null && record.ttftMs !== undefined
        ? Math.max(0, record.durationMs - record.ttftMs) : null;
      if (decodeMs !== null && decodeMs > 0 && record.usage.output > 0) {
        bits.push({ cls: 'metric-rate', text: `${(record.usage.output / (decodeMs / 1000)).toFixed(1)} tok/s` });
      }
    }
  } else if (record.kind === 'tool') {
    if (record.toolName) {
      bits.push({ cls: 'metric-tool', text: `${TOOL_ICONS[record.toolName] ?? '⚙'} ${record.toolName}` });
    }
  }
  return bits;
}

function argsPreview(record) {
  if (record.kind !== 'tool' || record.args === undefined || record.args === null) return '';
  if (typeof record.args === 'string') return record.args;
  try {
    const json = JSON.stringify(record.args);
    return json.length > 100 ? `${json.slice(0, 100)}…` : json;
  } catch { return ''; }
}

export class Ledger {
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
    let acc = offset;
    for (let i = startIndex; i < rows.length; i++) {
      acc += rows[i].height;
      if (acc > endOffset) { endIndex = i + 1; break; }
    }
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
      el.innerHTML = `<span class="turn-label">${label}</span><span class="turn-count">${row.count}</span><span class="turn-caret">${row.collapsed ? '▸' : '▾'}</span>`;
      if (row.turn !== null) {
        el.addEventListener('click', () => this.onToggleTurn(row.turn));
      }
      return el;
    }
    const record = row.record;
    // 运行中 = 进行中的 tool/assistant（user/system 的 durationMs 本来就是 null）。
    const running = record.durationMs === null
      && (record.kind === 'tool' || record.kind === 'assistant');
    const el = document.createElement('div');
    el.className = `record record-${record.kind}${record.isError ? ' record-error' : ''}${record.id === this.selectedId ? ' selected' : ''}${running ? ' running' : ''}`;
    el.style.height = `${row.height}px`;

    // turn rail（对齐 dsh turnRail 竖向连接线）
    const rail = document.createElement('span');
    rail.className = 'turn-rail';
    el.appendChild(rail);

    // pill 徽章（对齐 dsh kindTag）
    const badge = document.createElement('span');
    badge.className = `kind-tag tag-${record.kind}`;
    badge.textContent = KIND_BADGE[record.kind] ?? record.kind;
    el.appendChild(badge);

    // 内容
    const content = document.createElement('span');
    content.className = 'content';
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = record.kind === 'tool' ? argsPreview(record) : record.text;
    content.appendChild(text);
    for (const metric of recordMetrics(record)) {
      const m = document.createElement('span');
      m.className = `metric ${metric.cls}`;
      m.textContent = metric.text;
      content.appendChild(m);
    }
    if (running) {
      const pulse = document.createElement('span');
      pulse.className = 'running-dot';
      pulse.textContent = '●';
      content.appendChild(pulse);
    }
    el.appendChild(content);

    // 右侧时间
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

export { formatDurationMillis as _formatDurationMillis, formatTokens as _formatTokens };
