/**
 * pi-trace 前端主控制器。
 *
 * 数据通道：
 *   GET /api/session/{id}     全量快照
 *   GET /api/events?session=  SSE：hello → record/turn/stats 增量
 *
 * 视图：
 *   - 统计栏（DESIGN 3.6，与 src/stats.ts 同口径）
 *   - 4 泳道甘特图（timeline.js，DESIGN 3.4）
 *   - 按 Turn 分组流水账（ledger.js，DESIGN 3.5）
 *   - 详情抽屉（tool args/result、assistant 正文+usage+timing）
 */
import { Timeline, focusIds } from './timeline.js';
import { Ledger, SearchIndex, KIND_BADGE } from './ledger.js';
import {
  formatClock,
  formatCost,
  formatDurationMillis,
  formatElapsed,
  formatPercent,
  formatTokens,
} from './format.js';

const state = {
  session: null,
  mode: 'duration',
  range: null,       // 甘特框选（投影域内）
  searchQuery: '',
  searchIds: null,
  focusIds: null,
  selectedId: null,
  collapsedTurns: new Set(),
  eventSource: null,
};

let timeline = null;
let ledger = null;
let searchIndex = null;

// --- 统计（DESIGN.md 3.6，与 src/stats.ts 同口径） ------------------------

function computeStats(session) {
  let llmMs = 0;
  let toolMs = 0;
  let ttftSum = 0;
  let ttftCount = 0;
  let decodeMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costTotal = 0;
  for (const record of session.records) {
    if (record.kind === 'assistant') {
      if (record.durationMs !== null) llmMs += record.durationMs;
      if (record.ttftMs !== null && record.ttftMs !== undefined) {
        ttftSum += record.ttftMs;
        ttftCount += 1;
        if (record.durationMs !== null) decodeMs += Math.max(0, record.durationMs - record.ttftMs);
      } else if (record.durationMs !== null) {
        decodeMs += record.durationMs;
      }
    } else if (record.kind === 'tool' && record.durationMs !== null) {
      toolMs += record.durationMs;
    }
    const usage = record.usage;
    if (usage) {
      inputTokens += usage.input;
      outputTokens += usage.output;
      cacheReadTokens += usage.cacheRead;
      costTotal += usage.costTotal;
    }
  }
  const cacheDenom = inputTokens + cacheReadTokens;
  return {
    turns: session.turns.length,
    steps: session.records.length,
    llmMs,
    toolMs,
    avgTtftMs: ttftCount > 0 ? ttftSum / ttftCount : null,
    tokPerSec: decodeMs > 0 && outputTokens > 0 ? outputTokens / (decodeMs / 1000) : null,
    cacheHitRate: cacheDenom > 0 ? cacheReadTokens / cacheDenom : null,
    inputTokens,
    outputTokens,
    costTotal,
  };
}

// --- 渲染 -----------------------------------------------------------------

function renderStats(session) {
  const el = document.getElementById('stats');
  const s = computeStats(session);
  const parts = [
    `${s.turns} 轮`,
    `${s.steps} 步`,
    `LLM ${formatElapsed(s.llmMs)}`,
    `工具 ${formatElapsed(s.toolMs)}`,
  ];
  if (s.avgTtftMs !== null) parts.push(`首 token 平均 ${formatElapsed(s.avgTtftMs)}`);
  if (s.tokPerSec !== null) parts.push(`${s.tokPerSec.toFixed(1)} tok/s`);
  if (s.cacheHitRate !== null) parts.push(`缓存命中 ${formatPercent(s.cacheHitRate)}`);
  parts.push(`输入 ${formatTokens(s.inputTokens)} tok`);
  parts.push(`输出 ${formatTokens(s.outputTokens)} tok`);
  parts.push(formatCost(s.costTotal));
  el.textContent = parts.join(' · ');
}

function renderDetail(record) {
  const el = document.getElementById('detail');
  if (!record) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  const sections = [];
  sections.push(`<div class="detail-title">${KIND_BADGE[record.kind] ?? record.kind} · ${formatDurationMillis(record.durationMs)}</div>`);
  if (record.kind === 'tool') {
    sections.push(`<div class="detail-label">args</div><pre>${escapeHtml(JSON.stringify(record.args, null, 2))}</pre>`);
    sections.push(`<div class="detail-label">result</div><pre>${escapeHtml(typeof record.result === 'string' ? record.result : JSON.stringify(record.result, null, 2))}</pre>`);
    if (record.exitCode !== undefined) sections.push(`<div class="detail-label">exit code</div><pre>${record.exitCode}</pre>`);
  } else if (record.kind === 'system') {
    const args = record.args ?? {};
    if (typeof record.prompt === 'string') {
      const truncated = args.systemPromptTruncated && args.promptBlob;
      sections.push(`<div class="detail-label">system prompt（${formatBytes(args.systemPromptBytes)}${truncated ? ' → 截断 8KB' : ''}）</div><pre id="prompt-pre">${escapeHtml(record.prompt)}</pre>`);
      if (truncated) {
        sections.push(`<button class="load-full-prompt" data-record-id="${record.id}">加载完整 system prompt（${formatBytes(args.systemPromptBytes)}）</button>`);
      }
    }
    if (Array.isArray(args.tools) && args.tools.length > 0) {
      sections.push(`<div class="detail-label">tools（${args.tools.length}）</div><pre>${escapeHtml(args.tools.join('\n'))}</pre>`);
    }
    if (args.thinkingLevel) sections.push(`<div class="detail-label">thinking level</div><pre>${escapeHtml(String(args.thinkingLevel))}</pre>`);
    if (args.cwd) sections.push(`<div class="detail-label">cwd</div><pre>${escapeHtml(String(args.cwd))}</pre>`);
  } else if (record.kind === 'assistant') {
    sections.push(`<div class="detail-label">text</div><pre>${escapeHtml(record.text)}</pre>`);
    if (record.usage) {
      sections.push(`<div class="detail-label">usage</div><pre>${escapeHtml(JSON.stringify(record.usage, null, 2))}</pre>`);
    }
    sections.push(`<div class="detail-label">timing</div><pre>started   ${formatClock(record.startedAt)}\nduration  ${formatDurationMillis(record.durationMs)}\nTTFT      ${formatDurationMillis(record.ttftMs ?? null)}</pre>`);
  } else {
    sections.push(`<pre>${escapeHtml(record.text)}</pre>`);
  }
  el.innerHTML = sections.join('\n');
  // “加载完整 system prompt”按钮
  const btn = el.querySelector('.load-full-prompt');
  if (btn) {
    btn.addEventListener('click', async () => {
      const recordId = btn.dataset.recordId;
      btn.disabled = true;
      btn.textContent = '加载中…';
      try {
        const res = await fetch(`/api/prompt?session=${encodeURIComponent(state.session.sessionId)}&record=${encodeURIComponent(recordId)}`);
        if (!res.ok) {
          btn.textContent = `加载失败 (${res.status})`;
          return;
        }
        const full = await res.text();
        const pre = el.querySelector('#prompt-pre');
        if (pre) pre.textContent = full;
        btn.textContent = `已加载完整内容（${formatBytes(full.length)}）`;
      } catch (e) {
        btn.textContent = `加载失败: ${e.message}`;
      }
    });
  }
}

function renderAll() {
  const session = state.session;
  if (!session) return;
  document.getElementById('precision').textContent = session.precision;
  document.getElementById('precision').className = `precision precision-${session.precision}`;
  document.getElementById('session-title').textContent = `${session.cwd || '—'} · ${session.sessionId.slice(0, 8)}`;
  renderStats(session);
  timeline.update(session, {
    mode: state.mode,
    range: state.range,
    selectedId: state.selectedId,
    searchIds: state.searchIds,
  });
  ledger.update(session, {
    searchIds: state.searchIds,
    focusIds: state.focusIds,
    collapsedTurns: state.collapsedTurns,
    selectedId: state.selectedId,
  });
}

function recomputeFocus() {
  state.focusIds = focusIds(state.session, state.range, state.mode);
}

// --- 数据通道 ---------------------------------------------------------------

async function loadSession(id, retries = 5) {
  let res;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch(`/api/session/${encodeURIComponent(id)}`);
    if (res.ok) break;
    if (res.status === 404 && attempt < retries) {
      // server 可能刚拉起、collector 还没注册上，退避重试
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      continue;
    }
    break;
  }
  if (!res.ok) {
    document.getElementById('ledger').textContent = `failed to load session: ${res.status}`;
    return;
  }
  state.session = await res.json();
  state.selectedId = null;
  state.range = null;
  state.focusIds = null;
  state.collapsedTurns = new Set();
  searchIndex = new SearchIndex(state.session);
  renderDetail(null);
  renderAll();
  subscribe(id);
}

function subscribe(id) {
  state.eventSource?.close();
  const es = new EventSource(`/api/events?session=${encodeURIComponent(id)}`);
  state.eventSource = es;
  es.addEventListener('hello', (e) => {
    const data = JSON.parse(e.data);
    if (data.session) {
      state.session = data.session;
      searchIndex = new SearchIndex(state.session);
      state.searchIds = searchIndex.search(state.searchQuery);
      recomputeFocus();
      renderAll();
    }
  });
  es.addEventListener('record', (e) => {
    const { record } = JSON.parse(e.data);
    upsertRecord(record);
    searchIndex?.update(state.session);
    state.searchIds = searchIndex.search(state.searchQuery);
    recomputeFocus();
    renderAll();
  });
  es.addEventListener('turn', (e) => {
    const { turn, endedAt } = JSON.parse(e.data);
    const bucket = state.session?.turns.find(t => t.turn === turn);
    if (bucket) bucket.endedAt = endedAt;
    renderAll();
  });
  es.addEventListener('stats', () => {
    renderAll();
  });
}

function upsertRecord(record) {
  const session = state.session;
  if (!session) return;
  const index = session.records.findIndex(r => r.id === record.id);
  if (index >= 0) {
    session.records[index] = record;
  } else {
    session.records.push(record);
  }
  if (record.turn !== null) {
    let bucket = session.turns.find(t => t.turn === record.turn);
    if (!bucket) {
      bucket = { turn: record.turn, startedAt: record.startedAt, endedAt: null, records: [] };
      session.turns.push(bucket);
      session.turns.sort((a, b) => a.turn - b.turn);
    }
    const bIndex = bucket.records.findIndex(r => r.id === record.id);
    if (bIndex >= 0) bucket.records[bIndex] = record;
    else bucket.records.push(record);
    bucket.startedAt = Math.min(bucket.startedAt, record.startedAt);
    const end = record.startedAt + (record.durationMs ?? 0);
    bucket.endedAt = bucket.endedAt === null ? end : Math.max(bucket.endedAt, end);
  }
  session.endedAt = record.startedAt + (record.durationMs ?? 0);
}

// --- 会话选择 ---------------------------------------------------------------

async function loadSessionList() {
  const res = await fetch('/api/sessions');
  if (!res.ok) return;
  const sessions = await res.json();
  const select = document.getElementById('session-picker');
  select.innerHTML = '';
  for (const s of sessions) {
    const option = document.createElement('option');
    option.value = s.sessionId;
    option.textContent = `${s.cwd || '?'} · ${s.sessionId.slice(0, 8)} · ${s.precision} · ${s.turnCount} 轮`;
    select.appendChild(option);
  }
  const current = new URLSearchParams(location.search).get('session');
  if (current) {
    select.value = current;
    await loadSession(current);
  } else if (sessions.length > 0) {
    select.value = sessions[0].sessionId;
    history.replaceState(null, '', `?session=${encodeURIComponent(sessions[0].sessionId)}`);
    await loadSession(sessions[0].sessionId);
  }
}

// --- 初始化 -----------------------------------------------------------------

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

document.getElementById('session-picker').addEventListener('change', async (e) => {
  const id = e.target.value;
  history.replaceState(null, '', `?session=${encodeURIComponent(id)}`);
  await loadSession(id);
});

document.getElementById('search').addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  state.searchIds = searchIndex?.search(state.searchQuery) ?? null;
  renderAll();
});

document.getElementById('mode-duration').addEventListener('click', () => {
  state.mode = 'duration';
  state.range = null;
  recomputeFocus();
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.id === 'mode-duration'));
  renderAll();
});

document.getElementById('mode-time').addEventListener('click', () => {
  state.mode = 'time';
  state.range = null;
  recomputeFocus();
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.id === 'mode-time'));
  renderAll();
});

timeline = new Timeline(document.getElementById('timeline'), {
  onRangeChange: (range) => {
    state.range = range;
    recomputeFocus();
    renderAll();
  },
  onSelect: (id) => {
    state.selectedId = id;
    const record = state.session?.records.find(r => r.id === id);
    renderDetail(record ?? null);
    renderAll();
  },
});

ledger = new Ledger(document.getElementById('ledger'), {
  onSelect: (id) => {
    state.selectedId = id;
    const record = state.session?.records.find(r => r.id === id);
    renderDetail(record ?? null);
    renderAll();
  },
  onToggleTurn: (turn) => {
    if (state.collapsedTurns.has(turn)) state.collapsedTurns.delete(turn);
    else state.collapsedTurns.add(turn);
    renderAll();
  },
});

document.getElementById('timeline').hidden = false;
document.getElementById('search').disabled = false;

loadSessionList();
