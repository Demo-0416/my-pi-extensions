/**
 * 4 泳道甘特图（DESIGN.md 3.4）。
 *
 * 投影算法移植自 dsh timeline.ts：
 *   - deriveTimedTimeline：按真实时长比例 + 压缩空闲间隙（duration 模式），
 *     或真实墙钟（time 模式，span 退化为瞬时点）
 *   - trajectoryTimelineFocusIndexes：框选区间 → 记录 id 集合
 * 渲染交互移植自 dsh TrajectoryTimeline.tsx：拖拽框选、hover tooltip、
 * 点击选中、TTFT 渐变刻度。
 *
 * 与 dsh 的差异（DESIGN 3.4）：dsh 3 泳道（Input/Model/Tools），
 * 本实现 4 泳道：Duration / Turns / LLM Calls / Tools。
 */
import { formatClockMs, formatDurationMillis, formatElapsed } from './format.js';

export const TIMELINE_MODES = ['duration', 'time'];

const MINIMUM_DRAG_PX = 3;
const TIMELINE_TOOLTIP_DELAY_MS = 500;
const LANE_PITCH = 15;
const LANE_HEIGHT = 9;
const LANE_LABELS = ['Duration', 'Turns', 'LLM Calls', 'Tools'];

function finite(value) {
  return value !== null && value !== undefined && Number.isFinite(value);
}

/**
 * 投影：session.records + session.turns → 泳道 span 模型。
 * 移植自 dsh timeline.ts deriveTimedTimeline（原算法作用于 turns→groups→cells，
 * 这里作用于扁平 records + turns，空闲压缩逻辑逐行保留）。
 *
 * @param {object} session TraceSession
 * @param {'duration'|'time'} mode
 * @returns {{start:number,end:number,spans:object[],turnBoundaries:object[]}|null}
 */
export function deriveTimeline(session, mode = 'duration') {
  const actualDuration = mode === 'duration';
  const compressIdle = mode === 'duration';

  const operationSpans = [];
  for (const turn of session.turns) {
    if (!finite(turn.startedAt)) continue;
    const end = finite(turn.endedAt) ? Math.max(turn.endedAt, turn.startedAt) : turn.startedAt;
    operationSpans.push({
      start: turn.startedAt,
      end,
      kind: 'turn',
      lane: 1,
      label: `Turn ${turn.turn + 1}`,
      id: `turn-${turn.turn}`,
      turn: turn.turn,
      isError: false,
    });
  }
  for (const record of session.records) {
    if (record.kind !== 'assistant' && record.kind !== 'tool') continue;
    if (!finite(record.startedAt)) continue;
    const durationMs = finite(record.durationMs) ? Math.max(0, record.durationMs) : 0;
    operationSpans.push({
      start: record.startedAt,
      end: record.startedAt + durationMs,
      kind: record.kind,
      lane: record.kind === 'assistant' ? 2 : 3,
      label: record.text,
      id: record.id,
      isError: record.isError === true,
      ttftMs: finite(record.ttftMs) ? record.ttftMs : null,
      durationMs: finite(record.durationMs) ? record.durationMs : null,
      startedAt: record.startedAt,
      model: record.model,
      toolName: record.toolName,
      exitCode: record.exitCode,
      usage: record.usage,
    });
  }
  if (operationSpans.length === 0) return null;

  // 空闲压缩（移植自 dsh deriveTimedTimeline）：
  // 按 start 排序，累计被覆盖区间之外的空闲，每个 span 记录自己被压缩掉的偏移。
  const removedIdleBySpan = new Map();
  let removedIdle = 0;
  let coveredUntil = null;
  for (const span of [...operationSpans].sort((l, r) => l.start - r.start || l.end - r.end)) {
    if (compressIdle && coveredUntil !== null && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans = operationSpans.map((span) => {
    const offset = removedIdleBySpan.get(span) ?? 0;
    return {
      ...span,
      start: span.start - offset,
      // dsh 语义：duration 模式 end=start+duration；time 模式 end=start（瞬时点）。
      end: (actualDuration ? span.end : span.start) - offset,
    };
  });

  // Duration 泳道：整个会话的总跨度（压缩后）。
  const sessionStart = finite(session.startedAt) ? session.startedAt : Math.min(...spans.map(s => s.start));
  const rawEnd = finite(session.endedAt)
    ? session.endedAt
    : Math.max(...operationSpans.map(s => s.end));
  spans.push({
    start: sessionStart,
    end: rawEnd - (compressIdle ? removedIdle : 0),
    kind: 'duration',
    lane: 0,
    label: 'Session',
    id: 'session-duration',
    isError: false,
  });

  const start = Math.min(...spans.map(s => s.start));
  const end = Math.max(...spans.map(s => s.end));

  // turn 边界竖线（所有泳道贯通）。
  const turnBoundaries = session.turns
    .filter(t => finite(t.startedAt))
    .map(t => ({ turn: t.turn, time: t.startedAt - (removedIdleBySpan.get(operationSpans.find(s => s.kind === 'turn' && s.turn === t.turn)) ?? 0) }))
    .sort((a, b) => a.time - b.time);

  return { start, end: Math.max(end, start + 1), spans, turnBoundaries };
}

/**
 * 框选区间 → 落在区间内的记录 id（移植自 dsh trajectoryTimelineFocusIndexes）。
 * @returns {Set<string>|null} null 表示无框选
 */
export function focusIds(session, range, mode) {
  if (!range) return null;
  const model = deriveTimeline(session, mode);
  if (!model) return new Set();
  return new Set(
    model.spans
      .filter(span => span.start <= range.end && span.end >= range.start)
      .map(span => span.id)
      .filter(id => id !== undefined && !id.startsWith('turn-') && id !== 'session-duration'),
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** tooltip 文案（移植自 dsh timelineTooltipLabel）。 */
function tooltipLabel(span) {
  const kindLabel = { duration: 'DURATION', turn: 'TURN', assistant: 'ASSISTANT', tool: 'TOOL' }[span.kind] ?? span.kind;
  const lines = [kindLabel];
  if (span.kind === 'turn') {
    lines.push(span.label);
    if (span.durationMs !== null) lines.push(`Total ${formatDurationMillis(span.durationMs)}`);
    return lines.join('\n');
  }
  if (span.kind === 'duration') {
    lines.push(formatClockMs(span.startedAt ?? span.start));
    lines.push(`Total ${formatDurationMillis(span.durationMs ?? (span.end - span.start))}`);
    return lines.join('\n');
  }
  if (finite(span.startedAt)) {
    const range = span.durationMs !== null
      ? `${formatClockMs(span.startedAt)} → ${formatClockMs(span.startedAt + span.durationMs)}`
      : `Started ${formatClockMs(span.startedAt)}`;
    lines.push(range);
  }
  if (span.durationMs !== null) lines.push(`Total ${formatDurationMillis(span.durationMs)}`);
  if (span.ttftMs !== null) {
    const decoding = span.durationMs !== null ? span.durationMs - span.ttftMs : null;
    lines.push(`TTFT ${formatDurationMillis(span.ttftMs)}${decoding !== null ? ` · Decoding ${formatDurationMillis(decoding)}` : ''}`);
  }
  if (span.usage) {
    const u = span.usage;
    lines.push(`in ${u.input} · out ${u.output} · cache ${u.cacheRead} · $${u.costTotal.toFixed(4)}`);
  }
  if (span.kind === 'tool') {
    if (span.toolName) lines.push(span.toolName);
    if (span.exitCode !== undefined) lines.push(`exit ${span.exitCode}`);
  }
  if (span.model) lines.push(span.model);
  return lines.join('\n');
}

/**
 * 甘特图渲染器。绝对定位 div，无依赖。
 * 交互移植自 dsh TrajectoryTimeline.tsx：左键拖拽框选、单击选中、hover tooltip。
 */
export class Timeline {
  /**
   * @param {HTMLElement} container
   * @param {{onRangeChange:(range|null)=>void, onSelect:(id:string)=>void}} handlers
   */
  constructor(container, { onRangeChange, onSelect }) {
    this.container = container;
    this.onRangeChange = onRangeChange;
    this.onSelect = onSelect;
    this.session = null;
    this.mode = 'duration';
    this.range = null;
    this.selectedId = null;
    this.dimIds = null; // 搜索不匹配时压暗
    this.drag = null;
    this.hoverTimer = null;
    this.tooltip = null;
    this.model = null;

    this.container.innerHTML = `
      <div class="tl-plot">
        <div class="tl-labels">${LANE_LABELS.map((label, i) =>
          `<span style="top:${7 + i * LANE_PITCH}px">${label}</span>`).join('')}</div>
        <div class="tl-track" tabindex="0">
          <div class="tl-lanes"></div>
          <div class="tl-boundaries"></div>
          <div class="tl-selection" hidden></div>
          <div class="tl-hoverline" hidden></div>
          <div class="tl-empty">No timing data</div>
        </div>
      </div>
      <div class="tl-tooltip" hidden></div>`;
    this.track = this.container.querySelector('.tl-track');
    this.lanes = this.container.querySelector('.tl-lanes');
    this.boundaries = this.container.querySelector('.tl-boundaries');
    this.selectionEl = this.container.querySelector('.tl-selection');
    this.hoverLine = this.container.querySelector('.tl-hoverline');
    this.emptyEl = this.container.querySelector('.tl-empty');
    this.tooltipEl = this.container.querySelector('.tl-tooltip');

    this.track.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.track.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.track.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.track.addEventListener('pointerleave', () => this.hideTooltip());
    this.track.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.range = null;
        this.onRangeChange(null);
        this.renderSelection();
      }
    });
  }

  /**
   * @param {object} session
   * @param {{mode?:string, range?:{start:number,end:number}|null, selectedId?:string|null, dimIds?:Set<string>|null}} state
   */
  update(session, state = {}) {
    this.session = session;
    if (state.mode !== undefined) this.mode = state.mode;
    if (state.range !== undefined) this.range = state.range;
    if (state.selectedId !== undefined) this.selectedId = state.selectedId;
    if (state.dimIds !== undefined) this.dimIds = state.dimIds;
    this.model = deriveTimeline(session, this.mode);
    this.render();
  }

  render() {
    const model = this.model;
    this.lanes.innerHTML = '';
    this.boundaries.innerHTML = '';
    if (!model) {
      this.emptyEl.hidden = false;
      this.selectionEl.hidden = true;
      return;
    }
    this.emptyEl.hidden = true;
    const duration = Math.max(1, model.end - model.start);

    for (const span of model.spans) {
      const el = document.createElement('div');
      const isRecord = span.kind === 'assistant' || span.kind === 'tool';
      el.className = `tl-span tl-${span.kind}${span.isError ? ' tl-error' : ''}`;
      const left = ((span.start - model.start) / duration) * 100;
      const width = Math.max(0.5, ((span.end - span.start) / duration) * 100);
      el.style.left = `${left}%`;
      el.style.width = `${width}%`;
      el.style.top = `${span.lane * LANE_PITCH}px`;
      el.style.height = `${LANE_HEIGHT}px`;
      if (span.kind === 'turn') {
        el.classList.add(span.turn % 2 === 0 ? 'tl-turn-even' : 'tl-turn-odd');
      }
      if (isRecord) {
        el.dataset.spanId = span.id;
        if (this.selectedId === span.id) el.classList.add('tl-selected');
        if (this.dimIds !== null && !this.dimIds.has(span.id)) el.classList.add('tl-dim');
        // TTFT 渐变刻度（移植自 dsh TrajectoryTimeline.module.css 的
        // [data-assistant-timing] linear-gradient 方案）。
        if (span.kind === 'assistant' && span.ttftMs !== null && span.durationMs !== null && span.durationMs > 0) {
          const frac = clamp(span.ttftMs / span.durationMs, 0, 1);
          el.style.setProperty('--ttft-frac', `${frac * 100}%`);
          el.classList.add('tl-ttft');
        }
      }
      el.addEventListener('mouseenter', () => this.scheduleTooltip(span));
      el.addEventListener('mouseleave', () => this.hideTooltip());
      this.lanes.appendChild(el);
    }

    // turn 边界竖线
    for (const boundary of model.turnBoundaries) {
      const line = document.createElement('div');
      line.className = 'tl-boundary';
      line.style.left = `${((boundary.time - model.start) / duration) * 100}%`;
      this.boundaries.appendChild(line);
    }
    this.renderSelection();
  }

  renderSelection() {
    const model = this.model;
    if (!model || !this.range) {
      this.selectionEl.hidden = true;
      return;
    }
    const duration = Math.max(1, model.end - model.start);
    const start = clamp(this.range.start, model.start, model.end);
    const end = clamp(this.range.end, model.start, model.end);
    const left = (Math.min(start, end) - model.start) / duration * 100;
    const width = Math.max(0.5, Math.abs(end - start) / duration * 100);
    this.selectionEl.hidden = false;
    this.selectionEl.style.left = `${left}%`;
    this.selectionEl.style.width = `${width}%`;
  }

  fractionAt(event) {
    const rect = this.track.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  }

  timeAt(event) {
    const model = this.model;
    if (!model) return 0;
    const duration = Math.max(1, model.end - model.start);
    return model.start + this.fractionAt(event) * duration;
  }

  spanIdAt(event) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    return target?.closest('[data-span-id]')?.dataset.spanId ?? null;
  }

  onPointerDown(event) {
    if (event.button !== 0) return;
    const time = this.timeAt(event);
    this.drag = {
      pointerId: event.pointerId,
      anchorTime: time,
      anchorClientX: event.clientX,
      spanId: this.spanIdAt(event),
      moved: false,
    };
    // 合成事件/部分浏览器下 setPointerCapture 会抛 NotFoundError，不影响拖拽逻辑。
    try { this.track.setPointerCapture?.(event.pointerId); } catch { /* ignore */ }
    this.hideTooltip();
  }

  onPointerMove(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - this.drag.anchorClientX) >= MINIMUM_DRAG_PX) {
      this.drag.moved = true;
    }
    if (this.drag.moved) {
      const time = this.timeAt(event);
      this.range = {
        start: Math.min(this.drag.anchorTime, time),
        end: Math.max(this.drag.anchorTime, time),
      };
      this.renderSelection();
    }
  }

  onPointerUp(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    const drag = this.drag;
    this.drag = null;
    if (!drag.moved) {
      // 单击：选中 span 或清除框选。
      if (drag.spanId) {
        this.onSelect(drag.spanId);
      } else {
        this.range = null;
        this.onRangeChange(null);
        this.renderSelection();
      }
      return;
    }
    this.onRangeChange(this.range);
  }

  scheduleTooltip(span) {
    this.hideTooltip();
    this.hoverTimer = setTimeout(() => {
      this.tooltipEl.textContent = tooltipLabel(span);
      this.tooltipEl.hidden = false;
      const rect = this.track.getBoundingClientRect();
      this.tooltipEl.style.left = `${rect.width * this.fractionAt({ clientX: rect.left + rect.width / 2 })}px`;
    }, TIMELINE_TOOLTIP_DELAY_MS);
  }

  hideTooltip() {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if (this.tooltipEl) this.tooltipEl.hidden = true;
  }
}

export { formatElapsed as _formatElapsed };
