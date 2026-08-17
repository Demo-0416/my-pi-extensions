/**
 * 4 泳道甘特图（DESIGN.md 3.4），交互模型对齐 dsh TrajectoryTimeline.tsx。
 *
 * 投影算法移植自 dsh timeline.ts：
 *   - deriveTimedTimeline：按真实时长比例 + 压缩空闲间隙（duration 模式），
 *     或真实墙钟（time 模式，span 退化为瞬时点）
 *   - trajectoryTimelineFocusIndexes：框选区间 → 记录 id 集合
 * 渲染交互移植自 dsh TrajectoryTimeline.tsx：
 *   - viewport 滚轮缩放（锚定光标）、右键拖拽平移、框选时边缘平移
 *   - hover 竖线、span 状态机（selected/current/hovered/search-match/error）
 *   - 双击/Escape 清除框选、单击空白居中最小选区并聚焦最近记录
 *
 * 与 dsh 的差异（DESIGN 3.4）：dsh 3 泳道（Input/Model/Tools），
 * 本实现 4 泳道：Duration / Turns / LLM Calls / Tools。
 */
import { formatClockMs, formatDurationMillis } from './format.js';

export const TIMELINE_MODES = ['duration', 'time'];

const MINIMUM_DRAG_PX = 3;
const MINIMUM_ZOOM_MS = 20;
const EDGE_PAN_ZONE_FRACTION = 0.08;
const EDGE_PAN_STEP_FRACTION = 0.025;
const MAXIMUM_EDGE_PAN_PX = 32;
const TIMELINE_TOOLTIP_DELAY_MS = 500;
const LANE_PITCH = 15;
const LANE_HEIGHT = 9;
const LANE_LABELS = ['Duration', 'Turns', 'LLM Calls', 'Tools'];

function finite(value) {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 投影：session.records + session.turns → 泳道 span 模型。
 * 移植自 dsh timeline.ts deriveTimedTimeline（空闲压缩逻辑逐行保留）。
 */
export function deriveTimeline(session, mode = 'duration') {
  const actualDuration = mode === 'duration';
  const compressIdle = mode === 'duration';

  const operationSpans = [];
  for (const turn of session.turns) {
    if (!finite(turn.startedAt)) continue;
    const end = finite(turn.endedAt) ? Math.max(turn.endedAt, turn.startedAt) : turn.startedAt;
    operationSpans.push({
      start: turn.startedAt, end, kind: 'turn', lane: 1,
      label: `Turn ${turn.turn + 1}`, id: `turn-${turn.turn}`, turn: turn.turn, isError: false,
    });
  }
  for (const record of session.records) {
    if (record.kind !== 'assistant' && record.kind !== 'tool') continue;
    if (!finite(record.startedAt)) continue;
    const durationMs = finite(record.durationMs) ? Math.max(0, record.durationMs) : 0;
    operationSpans.push({
      start: record.startedAt, end: record.startedAt + durationMs,
      kind: record.kind, lane: record.kind === 'assistant' ? 2 : 3,
      label: record.text, id: record.id, isError: record.isError === true,
      ttftMs: finite(record.ttftMs) ? record.ttftMs : null,
      durationMs: finite(record.durationMs) ? record.durationMs : null,
      startedAt: record.startedAt, model: record.model, toolName: record.toolName,
      exitCode: record.exitCode, usage: record.usage,
    });
  }
  if (operationSpans.length === 0) return null;

  // 空闲压缩（移植自 dsh deriveTimedTimeline）。
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
      end: (actualDuration ? span.end : span.start) - offset,
    };
  });

  // Duration 泳道：整个会话的总跨度（压缩后）。
  const sessionStart = finite(session.startedAt) ? session.startedAt : Math.min(...spans.map(s => s.start));
  const rawEnd = finite(session.endedAt) ? session.endedAt : Math.max(...operationSpans.map(s => s.end));
  spans.push({
    start: sessionStart, end: rawEnd - (compressIdle ? removedIdle : 0),
    kind: 'duration', lane: 0, label: 'Session', id: 'session-duration', isError: false,
  });

  const start = Math.min(...spans.map(s => s.start));
  const end = Math.max(...spans.map(s => s.end));

  const turnBoundaries = session.turns
    .filter(t => finite(t.startedAt))
    .map(t => {
      const turnSpan = operationSpans.find(s => s.kind === 'turn' && s.turn === t.turn);
      return { turn: t.turn, time: t.startedAt - (turnSpan ? removedIdleBySpan.get(turnSpan) ?? 0 : 0) };
    })
    .sort((a, b) => a.time - b.time);

  return { start, end: Math.max(end, start + 1), spans, turnBoundaries };
}

/** 框选区间 → 落在区间内的记录 id（移植自 dsh trajectoryTimelineFocusIndexes）。 */
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
 * 甘特图渲染器。交互模型移植自 dsh TrajectoryTimeline.tsx：
 * viewport 缩放/平移、拖拽框选、hover、span 状态机。
 */
export class Timeline {
  constructor(container, { onRangeChange, onSelect }) {
    this.container = container;
    this.onRangeChange = onRangeChange;
    this.onSelect = onSelect;
    this.session = null;
    this.mode = 'duration';
    this.range = null;       // 提交的框选（投影域）
    this.draft = null;       // 拖拽中的框选
    this.viewport = null;    // 缩放窗口（null = 全域）
    this.selectedId = null;
    this.searchIds = null;
    this.hover = null;
    this.drag = null;
    this.pan = null;
    this.panning = false;
    this.hoverTimer = null;
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
    this.track.addEventListener('pointercancel', () => this.onPointerCancel());
    this.track.addEventListener('pointerleave', () => {
      if (this.drag === null && this.pan === null) this.setHover(null);
    });
    this.track.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.range = null;
      this.draft = null;
      this.onRangeChange(null);
      this.render();
    });
    this.track.addEventListener('contextmenu', (e) => e.preventDefault());
    this.track.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.track.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.range !== null) {
        e.preventDefault();
        this.range = null;
        this.draft = null;
        this.onRangeChange(null);
        this.render();
      }
    });
  }

  update(session, state = {}) {
    this.session = session;
    if (state.mode !== undefined) this.mode = state.mode;
    if (state.range !== undefined) this.range = state.range;
    if (state.selectedId !== undefined) this.selectedId = state.selectedId;
    if (state.searchIds !== undefined) this.searchIds = state.searchIds;
    this.model = deriveTimeline(session, this.mode);
    // viewport 越界则重置（移植自 dsh useEffect）。
    if (this.viewport !== null && this.model !== null
      && (this.viewport.end < this.model.start || this.viewport.start > this.model.end)) {
      this.viewport = null;
    }
    this.render();
  }

  // --- 视口计算（移植自 dsh TrajectoryTimeline） ---

  fullDuration() {
    return this.model ? Math.max(1, this.model.end - this.model.start) : 1;
  }

  domainStart() {
    if (this.model === null) return 0;
    if (this.viewport === null) return this.model.start;
    const duration = this.viewportDuration();
    return clamp(this.viewport.start, this.model.start, this.model.end - duration);
  }

  viewportDuration() {
    if (this.model === null) return 1;
    const full = this.fullDuration();
    if (this.viewport === null) return full;
    return Math.min(full, Math.max(1, this.viewport.end - this.viewport.start));
  }

  domainDuration() {
    return this.viewportDuration();
  }

  fractionAt(event) {
    const rect = this.track.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  }

  timeAt(event) {
    return this.domainStart() + this.fractionAt(event) * this.domainDuration();
  }

  spanIdAt(event) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    return target?.closest('[data-span-id]')?.dataset.spanId ?? null;
  }

  // --- 渲染 ---

  render() {
    const model = this.model;
    this.lanes.innerHTML = '';
    this.boundaries.innerHTML = '';
    if (!model) {
      this.emptyEl.hidden = false;
      this.selectionEl.hidden = true;
      this.hoverLine.hidden = true;
      return;
    }
    this.emptyEl.hidden = true;
    const full = this.fullDuration();
    const domainStart = this.domainStart();
    const domainDuration = this.domainDuration();

    // 滑动窗口：lanes 容器相对全域定位（移植自 dsh projectedDomainStyle）。
    this.lanes.style.left = `${-(domainStart - model.start) / domainDuration * 100}%`;
    this.lanes.style.width = `${full / domainDuration * 100}%`;
    this.boundaries.style.left = this.lanes.style.left;
    this.boundaries.style.width = this.lanes.style.width;

    const activeRange = this.draft ?? this.range;
    for (const span of model.spans) {
      const isRecord = span.kind === 'assistant' || span.kind === 'tool';
      const el = document.createElement('div');
      el.className = `tl-span tl-${span.kind}${span.isError ? ' tl-error' : ''}`;
      const left = (span.start - model.start) / full * 100;
      const width = (span.end - span.start) / full * 100;
      el.style.left = `${left}%`;
      el.style.width = `${width}%`;
      el.style.top = `${span.lane * LANE_PITCH}px`;
      el.style.height = `${LANE_HEIGHT}px`;
      if (span.kind === 'turn') {
        el.classList.add(span.turn % 2 === 0 ? 'tl-turn-even' : 'tl-turn-odd');
      }
      if (isRecord) {
        el.dataset.spanId = span.id;
        if (this.selectedId === span.id) el.classList.add('tl-current');
        if (this.hover?.spanId === span.id) el.classList.add('tl-hovered');
        if (this.searchIds !== null) {
          el.classList.add(this.searchIds.has(span.id) ? 'tl-search-match' : 'tl-search-off');
        }
        if (activeRange !== null) {
          const inRange = span.start <= activeRange.end && span.end >= activeRange.start;
          el.classList.add(inRange ? 'tl-selected' : 'tl-dim');
        }
        if (this.mode === 'time') el.classList.add('tl-equal-duration');
        // TTFT 渐变刻度（移植自 dsh [data-assistant-timing] gradient）。
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

    for (const boundary of model.turnBoundaries) {
      if (boundary.time <= model.start) continue;
      const line = document.createElement('div');
      line.className = 'tl-boundary';
      line.style.left = `${(boundary.time - model.start) / full * 100}%`;
      this.boundaries.appendChild(line);
    }
    this.renderSelection();
    this.renderHoverLine();
  }

  renderSelection() {
    const model = this.model;
    const range = this.draft ?? this.range;
    if (!model || !range) {
      this.selectionEl.hidden = true;
      return;
    }
    const domainStart = this.domainStart();
    const domainDuration = this.domainDuration();
    const start = clamp(range.start, domainStart, domainStart + domainDuration);
    const end = clamp(range.end, domainStart, domainStart + domainDuration);
    const left = (Math.min(start, end) - domainStart) / domainDuration * 100;
    const width = Math.max(0.5, Math.abs(end - start) / domainDuration * 100);
    this.selectionEl.hidden = false;
    this.selectionEl.style.left = `${left}%`;
    this.selectionEl.style.width = `${width}%`;
    this.selectionEl.dataset.dragging = this.draft !== null ? 'true' : undefined;
  }

  renderHoverLine() {
    if (this.hover === null || this.drag !== null || this.draft !== null) {
      this.hoverLine.hidden = true;
      return;
    }
    this.hoverLine.hidden = false;
    this.hoverLine.style.left = `${clamp(this.hover.fraction * 100, 0, 100)}%`;
  }

  // --- 交互（移植自 dsh TrajectoryTimeline.tsx） ---

  onWheel(event) {
    event.preventDefault();
    if (this.model === null) return;
    const full = this.fullDuration();
    const anchorFraction = this.fractionAt(event);
    const current = this.domainDuration();
    const nextDuration = Math.min(
      full,
      Math.max(Math.min(MINIMUM_ZOOM_MS, full), current * Math.exp(event.deltaY * 0.0015)),
    );
    if (nextDuration >= full * 0.999) {
      this.viewport = null;
    } else {
      const anchorTime = this.domainStart() + anchorFraction * current;
      const nextStart = clamp(
        anchorTime - anchorFraction * nextDuration,
        this.model.start,
        this.model.end - nextDuration,
      );
      this.viewport = { start: nextStart, end: nextStart + nextDuration };
    }
    this.render();
  }

  onPointerDown(event) {
    this.hideTooltip();
    if (event.button === 2) {
      // 右键拖拽平移（移植自 dsh PanGesture）。
      this.pan = {
        anchorClientX: event.clientX,
        anchorStart: this.domainStart(),
        moved: false,
        pannable: this.viewport !== null,
        pointerId: event.pointerId,
      };
      this.panning = true;
      this.track.dataset.panning = 'true';
      this.capturePointer(event);
      return;
    }
    if (event.button !== 0) return;
    const anchorTime = this.timeAt(event);
    this.drag = {
      pointerId: event.pointerId,
      anchorTime,
      anchorClientX: event.clientX,
      spanId: this.spanIdAt(event),
      moved: false,
    };
    this.draft = { start: anchorTime, end: anchorTime };
    this.capturePointer(event);
    this.render();
  }

  onPointerMove(event) {
    const fraction = this.fractionAt(event);
    this.setHover({ fraction, spanId: this.spanIdAt(event) });

    // 右键平移
    const pan = this.pan;
    if (pan !== null && pan.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) pan.moved = true;
      if (!pan.pannable) return;
      const rect = this.track.getBoundingClientRect();
      const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width);
      const duration = this.domainDuration();
      const nextStart = clamp(
        pan.anchorStart - delta * duration,
        this.model.start,
        this.model.end - duration,
      );
      this.viewport = { start: nextStart, end: nextStart + duration };
      this.render();
      return;
    }

    // 左键框选（含边缘平移，移植自 dsh edge pan）
    const drag = this.drag;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.anchorClientX) >= MINIMUM_DRAG_PX) drag.moved = true;
    let domainStart = this.domainStart();
    if (this.viewport !== null) {
      const rect = this.track.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const edgeWidth = Math.min(MAXIMUM_EDGE_PAN_PX, Math.max(1, rect.width * EDGE_PAN_ZONE_FRACTION));
      const direction = localX < edgeWidth ? -1 : localX > rect.width - edgeWidth ? 1 : 0;
      if (direction !== 0) {
        const edgeDistance = direction < 0 ? edgeWidth - localX : localX - (rect.width - edgeWidth);
        const strength = clamp(edgeDistance / edgeWidth, 0, 1);
        const desired = domainStart + direction * this.domainDuration() * EDGE_PAN_STEP_FRACTION * Math.max(0.2, strength);
        const nextStart = clamp(desired, this.model.start, this.model.end - this.domainDuration());
        if (nextStart !== domainStart) {
          this.viewport = { start: nextStart, end: nextStart + this.domainDuration() };
          domainStart = nextStart;
          this.render();
        }
      }
    }
    const pointTime = domainStart + fraction * this.domainDuration();
    this.draft = {
      start: Math.min(drag.anchorTime, pointTime),
      end: Math.max(drag.anchorTime, pointTime),
    };
    this.renderSelection();
  }

  onPointerUp(event) {
    // 右键平移结束
    const pan = this.pan;
    if (pan !== null && pan.pointerId === event.pointerId) {
      const moved = pan.moved || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX;
      this.pan = null;
      this.panning = false;
      delete this.track.dataset.panning;
      if (!moved) {
        // 右键单击：清除框选（移植自 dsh）。
        this.range = null;
        this.draft = null;
        this.onRangeChange(null);
        this.render();
      }
      return;
    }
    const drag = this.drag;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const pointTime = this.timeAt(event);
    const selected = {
      start: Math.min(drag.anchorTime, pointTime),
      end: Math.max(drag.anchorTime, pointTime),
    };
    this.setHover({ fraction: this.fractionAt(event), spanId: this.spanIdAt(event) });
    this.drag = null;
    this.draft = null;
    const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
    if (click && drag.spanId !== null) {
      // 单击 span：选中记录（移植自 dsh onRecordSelect）。
      this.range = null;
      this.onRangeChange(null);
      this.onSelect(drag.spanId);
      this.render();
      return;
    }
    if (click) {
      // 单击空白：居中最小选区并聚焦最近记录（移植自 dsh centeredRange + nearest）。
      const minimum = Math.min(this.domainDuration(), this.fullDuration() / Math.max(1, this.model.spans.length));
      const center = selected.start;
      const width = minimum;
      const start = clamp(center - width / 2, this.model.start, this.model.end - width);
      this.range = { start, end: start + width };
      this.onRangeChange(this.range);
      const nearest = this.model.spans.reduce((candidate, span) => {
        const cDist = center < candidate.start ? candidate.start - center : center > candidate.end ? center - candidate.end : 0;
        const sDist = center < span.start ? span.start - center : center > span.end ? center - span.end : 0;
        return sDist < cDist ? span : candidate;
      });
      if (nearest?.id !== undefined && !nearest.id.startsWith('turn-') && nearest.id !== 'session-duration') {
        this.onSelect(nearest.id);
      }
      this.render();
      return;
    }
    this.range = selected;
    this.onRangeChange(selected);
    this.render();
  }

  onPointerCancel() {
    this.drag = null;
    this.pan = null;
    this.draft = null;
    this.panning = false;
    delete this.track.dataset.panning;
    this.setHover(null);
    this.render();
  }

  capturePointer(event) {
    try { this.track.setPointerCapture?.(event.pointerId); } catch { /* 合成事件兜底 */ }
  }

  setHover(hover) {
    this.hover = hover;
    this.renderHoverLine();
    // span hover 状态
    for (const el of this.lanes.querySelectorAll('.tl-span')) {
      el.classList.toggle('tl-hovered', el.dataset.spanId === hover?.spanId);
    }
  }

  scheduleTooltip(span) {
    this.hideTooltip();
    this.hoverTimer = setTimeout(() => {
      this.tooltipEl.textContent = tooltipLabel(span);
      this.tooltipEl.hidden = false;
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
