/**
 * pi-trace 前端主控制器（M8 最小版：统计栏 + 按 Turn 分组流水账）。
 *
 * M9 将加入 timeline.js（4 泳道甘特）与 ledger.js（虚拟滚动 + 搜索）。
 *
 * 数据通道：
 *   GET /api/session/{id}     全量快照
 *   GET /api/events?session=  SSE：hello → record/turn/stats 增量
 */
import {
  formatClock,
  formatCost,
  formatDurationMillis,
  formatElapsed,
  formatPercent,
  formatTokens,
} from './format.js';

const KIND_BADGE = {
  system: 'SYSTEM',
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
  compaction: 'COMPACTION',
};

const state = {
  session: null,
  selectedId: null,
  eventSource: null,
};

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

function recordSummary(record) {
  if (record.kind === 'assistant') {
    const bits = [];
    if (record.model) bits.push(record.model);
    if (record.ttftMs !== null && record.ttftMs !== undefined) {
      const s = computeStats(state.session);
      if (s.tokPerSec !== null) bits.push(`${s.tokPerSec.toFixed(1)} tok/s`);
      bits.push(`TTFT ${formatElapsed(record.ttftMs)}`);
    }
    return bits.join(' · ');
  }
  return record.text;
}

function renderLedger(session) {
  const el = document.getElementById('ledger');
  el.innerHTML = '';
  const turns = [...session.turns].sort((a, b) => a.turn - b.turn);
  const orphans = session.records.filter(r => r.turn === null);
  for (const turn of turns) {
    const header = document.createElement('div');
    header.className = 'turn-header';
    header.textContent = `Turn ${turn.turn + 1}`;
    el.appendChild(header);
    for (const record of turn.records) {
      el.appendChild(rowFor(record));
    }
  }
  if (orphans.length > 0) {
    const header = document.createElement('div');
    header.className = 'turn-header';
    header.textContent = '—';
    el.appendChild(header);
    for (const record of orphans) el.appendChild(rowFor(record));
  }
}

function rowFor(record) {
  const row = document.createElement('div');
  row.className = `record record-${record.kind}${record.isError ? ' record-error' : ''}`;
  if (record.id === state.selectedId) row.classList.add('selected');

  const badge = document.createElement('span');
  badge.className = `badge badge-${record.kind}`;
  badge.textContent = KIND_BADGE[record.kind] ?? record.kind;
  row.appendChild(badge);

  const summary = document.createElement('span');
  summary.className = 'summary';
  summary.textContent = recordSummary(record);
  row.appendChild(summary);

  const meta = document.createElement('span');
  meta.className = 'meta';
  const time = formatClock(record.startedAt);
  const duration = record.durationMs !== null ? ` · ${formatElapsed(record.durationMs)}` : '';
  const exit = record.kind === 'tool' && record.exitCode !== undefined ? `  [${record.exitCode}]` : '';
  meta.textContent = `${time}${duration}${exit}`;
  row.appendChild(meta);

  row.addEventListener('click', () => {
    state.selectedId = record.id;
    renderDetail(record);
    renderLedger(state.session);
  });
  return row;
}

function renderDetail(record) {
  const el = document.getElementById('detail');
  if (!record) {
    el.innerHTML = '';
    return;
  }
  const sections = [];
  sections.push(`<div class="detail-title">${KIND_BADGE[record.kind] ?? record.kind} · ${formatDurationMillis(record.durationMs)}</div>`);
  if (record.kind === 'tool') {
    sections.push(`<div class="detail-label">args</div><pre>${escapeHtml(JSON.stringify(record.args, null, 2))}</pre>`);
    sections.push(`<div class="detail-label">result</div><pre>${escapeHtml(typeof record.result === 'string' ? record.result : JSON.stringify(record.result, null, 2))}</pre>`);
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
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderAll() {
  const session = state.session;
  if (!session) return;
  document.getElementById('precision').textContent = session.precision;
  document.getElementById('precision').className = `precision precision-${session.precision}`;
  document.getElementById('session-title').textContent = `${session.cwd || '—'} · ${session.sessionId.slice(0, 8)}`;
  renderStats(session);
  renderLedger(session);
}

// --- 数据通道 ---------------------------------------------------------------

async function loadSession(id) {
  const res = await fetch(`/api/session/${encodeURIComponent(id)}`);
  if (!res.ok) {
    document.getElementById('ledger').textContent = `failed to load session: ${res.status}`;
    return;
  }
  state.session = await res.json();
  state.selectedId = null;
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
      renderAll();
    }
  });
  es.addEventListener('record', (e) => {
    const { record } = JSON.parse(e.data);
    upsertRecord(record);
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
  }
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

document.getElementById('session-picker').addEventListener('change', async (e) => {
  const id = e.target.value;
  history.replaceState(null, '', `?session=${encodeURIComponent(id)}`);
  await loadSession(id);
});

loadSessionList();
