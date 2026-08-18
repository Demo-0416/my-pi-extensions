/**
 * pi-trace 前端入口（React 版）。
 *
 * 数据通道：GET /api/session/{id} 全量 + GET /api/events SSE 增量。
 * 视图：vendor/ 下的 dsh Trajectory 组件（Toolbar + Timeline + Table），
 *       状态管理逻辑移植自 dsh TrajectoryView.tsx。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TrajectoryTable } from './vendor/TrajectoryTable.tsx'
import type { TrajectoryRequestNumber, TrajectoryUsage } from './vendor/TrajectoryTable.tsx'
import { TrajectoryTimeline } from './vendor/TrajectoryTimeline.tsx'
import { TrajectoryToolbar } from './vendor/TrajectoryToolbar.tsx'
import {
  appendTrajectoryPartialLayout,
  deriveTrajectoryLayout,
  type TrajectoryTurnModel,
} from './vendor/layout.ts'
import {
  trajectoryTimelineFocusIndexes,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
} from './vendor/timeline.ts'
import { trajectoryRecordId } from './vendor/trajectory-record.ts'
import { TrajectorySearchIndex } from './vendor/trajectory-search-index.ts'
import { en, zh } from './vendor/locales.ts'
import { adaptSession, type SessionJson } from './adapter.ts'
import './theme.css'

const EMPTY_TURN_IDS: ReadonlySet<number> = new Set()
const EMPTY_RECORD_IDS: ReadonlySet<string> = new Set()
const SEARCH_INDEX_THROTTLE_MS = 3_000

// --- 类型（vendor 组件需要的形状，adapter 已保证） ---

interface AssistantBlockLike { kind: string; text?: string; callId?: string; name?: string; argsRaw?: string }
interface AssistantNodeLike {
  kind: 'assistant'
  seq: number
  turn: number
  step: number
  blocks: readonly AssistantBlockLike[]
  usage?: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number; reasoningTokens?: number }
  provenance?: { provider: string; model: string }
}
interface RequestLike {
  purpose: 'assistant' | 'compaction'
  turn: number | null
  step: number
  startSeq: number
  status: 'running' | 'complete' | 'error'
  startedAt: number
  completedAt: number | null
  error?: string
  resultSeq?: number
  retry?: number
  maxRetries?: number
  retryDelayMs?: number
  provenance?: { provider: string; model: string }
  requestConfig?: unknown
  usage?: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number; reasoningTokens?: number }
}

function lastCellIndex(turns: readonly TrajectoryTurnModel[]): number {
  let last = 0
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) last = Math.max(last, cell.index)
    }
  }
  return last
}

function requestUsage(value: unknown): TrajectoryUsage | undefined {
  const usage = value as RequestLike['usage']
  if (!usage) return undefined
  return {
    ...(usage.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
    ...(usage.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
  }
}

function addUsage(total: TrajectoryUsage | undefined, usage: TrajectoryUsage | undefined): TrajectoryUsage | undefined {
  if (!usage) return total
  return {
    ...(total?.input === undefined && usage.input === undefined ? {} : { input: (total?.input ?? 0) + (usage.input ?? 0) }),
    ...(total?.cacheRead === undefined && usage.cacheRead === undefined ? {} : { cacheRead: (total?.cacheRead ?? 0) + (usage.cacheRead ?? 0) }),
    ...(total?.cacheWrite === undefined && usage.cacheWrite === undefined ? {} : { cacheWrite: (total?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0) }),
    ...(total?.output === undefined && usage.output === undefined ? {} : { output: (total?.output ?? 0) + (usage.output ?? 0) }),
    ...(total?.reasoning === undefined && usage.reasoning === undefined ? {} : { reasoning: (total?.reasoning ?? 0) + (usage.reasoning ?? 0) }),
  }
}

/** LLM 请求编号 + 累计 usage（移植自 dsh TrajectoryView.requestNumbers）。 */
function computeRequestNumbers(nodes: unknown[], requests: unknown[]): readonly TrajectoryRequestNumber[] {
  const assistantsByStep = new Map<string, AssistantNodeLike>()
  for (const node of nodes) {
    const n = node as AssistantNodeLike
    if (n.kind !== 'assistant' || n.step <= 0) continue
    assistantsByStep.set(`${n.turn}\u0000${n.step}`, n)
  }
  const requestsByStep = new Map(
    (requests as RequestLike[])
      .filter((r) => r.purpose === 'assistant')
      .map((r) => [`${r.turn}\u0000${r.step}`, r] as const),
  )
  const ordered = [
    ...(requests as RequestLike[]).map((request) => ({
      seq: request.startSeq,
      request,
      node: request.purpose === 'assistant'
        ? assistantsByStep.get(`${request.turn}\u0000${request.step}`)
        : undefined,
    })),
    ...[...assistantsByStep.entries()].flatMap(([key, node]) =>
      requestsByStep.has(key)
        ? []
        : [{ seq: node.seq, request: undefined as RequestLike | undefined, node }],
    ),
  ].sort((l, r) => l.seq - r.seq)

  const numbered: TrajectoryRequestNumber[] = []
  let cumulative: TrajectoryUsage | undefined
  for (const [index, entry] of ordered.entries()) {
    const usage = requestUsage(entry.request?.usage ?? entry.node?.usage)
    cumulative = addUsage(cumulative, usage)
    if (entry.request?.purpose !== 'compaction') {
      const request = entry.request
      const node = entry.node
      const turn = request?.turn ?? node?.turn
      const step = request?.step ?? node?.step
      if (turn === undefined || step === undefined) continue
      const provider = request?.provenance?.provider ?? node?.provenance?.provider
      const model = request?.provenance?.model ?? node?.provenance?.model
      numbered.push({
        seq: entry.seq,
        turn,
        step,
        group: `Step ${step}`,
        number: index + 1,
        ...(request?.status === undefined ? {} : { status: request.status }),
        ...(request?.startedAt === undefined ? {} : { startedAt: request.startedAt }),
        ...(request?.completedAt === undefined ? {} : { completedAt: request.completedAt }),
        ...(request?.error === undefined ? {} : { error: request.error }),
        ...(request?.resultSeq === undefined ? {} : { resultSeq: request.resultSeq }),
        ...(request?.retry === undefined ? {} : { retry: request.retry }),
        ...(request?.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
        ...(request?.retryDelayMs === undefined ? {} : { retryDelayMs: request.retryDelayMs }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(request?.requestConfig === undefined ? {} : { requestConfig: request.requestConfig }),
        ...(usage === undefined ? {} : { usage }),
        ...(cumulative === undefined ? {} : { cumulativeUsage: cumulative }),
      })
      continue
    }
    const request = entry.request
    numbered.push({
      seq: request.startSeq,
      turn: request.turn,
      step: 0,
      group: `Compaction ${request.startSeq}`,
      number: index + 1,
      purpose: 'compaction',
      status: request.status,
      startedAt: request.startedAt,
      completedAt: request.completedAt,
      ...(request.error === undefined ? {} : { error: request.error }),
      resultSeq: request.startSeq,
      ...(request.provenance?.provider === undefined ? {} : { provider: request.provenance.provider }),
      ...(request.provenance?.model === undefined ? {} : { model: request.provenance.model }),
      ...(request.requestConfig === undefined ? {} : { requestConfig: request.requestConfig }),
      ...(usage === undefined ? {} : { usage }),
      ...(cumulative === undefined ? {} : { cumulativeUsage: cumulative }),
    })
  }
  return numbered
}

// --- 统计栏（与 src/stats.ts 同口径） ---

function computeStats(session: SessionJson) {
  let llmMs = 0, toolMs = 0, ttftSum = 0, ttftCount = 0, decodeMs = 0
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, costTotal = 0
  let turns = 0
  for (const record of session.records) {
    if (record.kind === 'assistant') {
      turns = Math.max(turns, (record.turn ?? 0) + 1)
      if (record.durationMs !== null) llmMs += record.durationMs
      if (record.ttftMs !== null && record.ttftMs !== undefined) {
        ttftSum += record.ttftMs
        ttftCount += 1
        if (record.durationMs !== null) decodeMs += Math.max(0, record.durationMs - record.ttftMs)
      } else if (record.durationMs !== null) {
        decodeMs += record.durationMs
      }
    } else if (record.kind === 'tool' && record.durationMs !== null) {
      toolMs += record.durationMs
    }
    const usage = record.usage
    if (usage) {
      inputTokens += usage.input
      outputTokens += usage.output
      cacheReadTokens += usage.cacheRead
      costTotal += usage.costTotal
    }
  }
  const cacheDenom = inputTokens + cacheReadTokens
  return {
    turns,
    steps: session.records.length,
    llmMs,
    toolMs,
    avgTtftMs: ttftCount > 0 ? ttftSum / ttftCount : null,
    tokPerSec: decodeMs > 0 && outputTokens > 0 ? outputTokens / (decodeMs / 1000) : null,
    cacheHitRate: cacheDenom > 0 ? cacheReadTokens / cacheDenom : null,
    inputTokens,
    outputTokens,
    costTotal,
  }
}

function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s % 60)}s`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`
}

function formatPercent(n: number | null): string {
  return n === null ? '—' : `${(n * 100).toFixed(1)}%`
}

// --- 主组件 ---

const t = (key: keyof typeof en): string => (navigator.language.startsWith('zh') ? zh[key] : en[key])

function TraceApp() {
  const [sessions, setSessions] = useState<Array<{ sessionId: string; cwd: string; precision: string; turnCount: number }>>([])
  const [session, setSession] = useState<SessionJson | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(EMPTY_TURN_IDS)
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(EMPTY_RECORD_IDS)
  const [timelineSelection, setTimelineSelection] = useState<TrajectoryTimeRange | null>(null)
  const [actualDuration, setActualDuration] = useState(true)
  const [actualTime, setActualTime] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex] = useState(() => new TrajectorySearchIndex())
  const [searchIndexRevision, setSearchIndexRevision] = useState(0)
  const searchIndexTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchIndexInitialized = useRef(false)
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState<number | null>(null)
  const [timelineRecordSelection, setTimelineRecordSelection] = useState<{ readonly index: number } | null>(null)
  const [timelineRecordFocus, setTimelineRecordFocus] = useState<{ readonly index: number } | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const sessionRef = useRef<SessionJson | null>(null)
  sessionRef.current = session

  // 会话列表
  useEffect(() => {
    fetch('/api/sessions').then((r) => r.json()).then((list) => {
      setSessions(list)
      const urlId = new URLSearchParams(location.search).get('session')
      if (urlId) {
        setSessionId(urlId)
      } else if (list.length > 0) {
        setSessionId(list[0].sessionId)
        history.replaceState(null, '', `?session=${encodeURIComponent(list[0].sessionId)}`)
      }
    }).catch(() => {})
  }, [])

  // 加载会话 + SSE
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    fetch(`/api/session/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setSession(data)
      })
      .catch(() => {})
    const es = new EventSource(`/api/events?session=${encodeURIComponent(sessionId)}`)
    eventSourceRef.current = es
    es.addEventListener('hello', (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      if (data.session) setSession(data.session)
    })
    es.addEventListener('record', (e) => {
      const { record } = JSON.parse((e as MessageEvent).data)
      setSession((current) => {
        if (!current) return current
        const records = [...current.records]
        const idx = records.findIndex((r) => r.id === record.id)
        if (idx >= 0) records[idx] = record
        else records.push(record)
        return { ...current, records }
      })
    })
    es.addEventListener('turn', () => { /* turn 闭合信息已在 record 里 */ })
    return () => {
      cancelled = true
      es.close()
    }
  }, [sessionId])

  // 适配 + layout
  const adapted = useMemo(() => (session ? adaptSession(session) : null), [session])
  const partialTurn = adapted?.partial?.turn ?? null
  const partialStep = adapted?.partial?.step ?? null
  const finalized = useMemo(() => {
    if (!adapted) return { turns: [] as readonly TrajectoryTurnModel[], lastIndex: 0 }
    const turns = deriveTrajectoryLayout({
      nodes: adapted.nodes as never[],
      eventLocations: new Map(),
      partial: partialTurn === null || partialStep === null
        ? null
        : { turn: partialTurn, step: partialStep, blocks: [] },
      runningCalls: adapted.runningCalls as never[],
      requests: adapted.requests as never[],
      callSchemas: adapted.callSchemas as never,
    })
    return { turns, lastIndex: lastCellIndex(turns) }
  }, [adapted, partialTurn, partialStep])

  const timelinePartial = useMemo(() => {
    const p = adapted?.partial
    if (!p) return null
    return { turn: p.turn, step: p.step, blocks: p.blocks as AssistantBlockLike[] }
  }, [adapted])

  const timelineTurns = useMemo(
    () => appendTrajectoryPartialLayout(finalized.turns, timelinePartial, finalized.lastIndex),
    [finalized, timelinePartial],
  )

  const timelineMode: TrajectoryTimelineMode = actualDuration
    ? actualTime ? 'actual' : 'duration'
    : actualTime ? 'time' : 'sequence'

  // 搜索（移植自 dsh TrajectoryView：节流索引 + id → index 映射）
  const partialSearchTurns = useMemo(
    () => appendTrajectoryPartialLayout([], timelinePartial, finalized.lastIndex),
    [finalized.lastIndex, timelinePartial],
  )
  const searchLayouts = useMemo(
    () => [finalized.turns, partialSearchTurns] as const,
    [finalized, partialSearchTurns],
  )
  const latestSearchLayouts = useRef(searchLayouts)
  latestSearchLayouts.current = searchLayouts
  useEffect(() => {
    if (!searchIndexInitialized.current) {
      searchIndexInitialized.current = true
      if (searchIndex.update(searchLayouts)) setSearchIndexRevision((r) => r + 1)
      return
    }
    if (searchIndexTimer.current !== null) return
    searchIndexTimer.current = setTimeout(() => {
      searchIndexTimer.current = null
      if (searchIndex.update(latestSearchLayouts.current)) setSearchIndexRevision((r) => r + 1)
    }, SEARCH_INDEX_THROTTLE_MS)
  }, [searchIndex, searchLayouts])
  useEffect(() => () => {
    if (searchIndexTimer.current) clearTimeout(searchIndexTimer.current)
  }, [])

  const searchMatchRecordIds = useMemo(
    () => searchIndex.search(searchQuery),
    [searchIndex, searchIndexRevision, searchQuery],
  )
  const searchMatchIndexes = useMemo(() => {
    if (searchMatchRecordIds === null) return null
    const indexes = new Set<number>()
    for (const turns of searchLayouts) {
      for (const turn of turns) {
        for (const group of turn.groups) {
          for (const cell of group.cells) {
            if (searchMatchRecordIds.has(trajectoryRecordId(cell))) indexes.add(cell.index)
          }
        }
      }
    }
    return indexes
  }, [searchLayouts, searchMatchRecordIds])

  const timelineFocusIndexes = useMemo(
    () => (timelineSelection === null
      ? null
      : trajectoryTimelineFocusIndexes(timelineTurns, timelineSelection, timelineMode)),
    [timelineMode, timelineSelection, timelineTurns],
  )

  const requestNumbers = useMemo(
    () => (adapted ? computeRequestNumbers(adapted.nodes, adapted.requests) : []),
    [adapted],
  )

  // 折叠（移植自 dsh TrajectoryView）
  const collapsibleTurnIds = useMemo(
    () => timelineTurns
      .filter((turn) =>
        turn.turn !== null
        && turn.groups.reduce(
          (count, group) =>
            count + group.cells.filter((cell) =>
              cell.requestOnly !== true && cell.kind !== 'system').length,
          0,
        ) > 1)
      .flatMap((turn) => (turn.turn === null ? [] : [turn.turn])),
    [timelineTurns],
  )
  const allTurnsCollapsed = collapsibleTurnIds.length > 0
    && collapsibleTurnIds.every((turn) => collapsedTurns.has(turn))
  const collapsibleAssistantIds = useMemo(() => {
    const ids: string[] = []
    for (const turn of timelineTurns) {
      const cells = turn.groups.flatMap((group) => group.cells)
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]
        if (cell?.kind !== 'message') continue
        const next = cells[i + 1]
        if (next?.kind === 'tool' || next?.kind === 'subtool') {
          ids.push(trajectoryRecordId(cell))
        }
      }
    }
    return ids
  }, [timelineTurns])
  const allAssistantsCollapsed = collapsibleAssistantIds.length > 0
    && collapsibleAssistantIds.every((id) => collapsedAssistants.has(id))

  const toggleTurn = useCallback((turn: number) => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current)
      if (collapsed.has(turn)) collapsed.delete(turn)
      else collapsed.add(turn)
      return collapsed
    })
  }, [])
  const toggleAllTurns = useCallback(() => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current)
      if (allTurnsCollapsed) {
        for (const turn of collapsibleTurnIds) collapsed.delete(turn)
      } else {
        for (const turn of collapsibleTurnIds) collapsed.add(turn)
      }
      return collapsed
    })
  }, [allTurnsCollapsed, collapsibleTurnIds])
  const toggleAssistant = useCallback((id: string) => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current)
      if (collapsed.has(id)) collapsed.delete(id)
      else collapsed.add(id)
      return collapsed
    })
  }, [])
  const toggleAllAssistants = useCallback(() => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current)
      if (allAssistantsCollapsed) {
        for (const id of collapsibleAssistantIds) collapsed.delete(id)
      } else {
        for (const id of collapsibleAssistantIds) collapsed.add(id)
      }
      return collapsed
    })
  }, [allAssistantsCollapsed, collapsibleAssistantIds])

  const handleRecordSelect = useCallback((index: number) => {
    if (timelineFocusIndexes !== null && !timelineFocusIndexes.has(index)) {
      setTimelineSelection(null)
    }
  }, [timelineFocusIndexes])
  const handleTimelineRecordSelect = useCallback((index: number) => {
    setTimelineSelection(null)
    setTimelineRecordSelection({ index })
    setSelectedTimelineIndex(index)
  }, [])

  const stats = session ? computeStats(session) : null

  return (
    <div className="pi-trace-root">
      <header className="topbar">
        <div className="brand">✻ pi-trace</div>
        <select
          className="session-picker"
          value={sessionId ?? ''}
          onChange={(e) => {
            setSessionId(e.target.value)
            history.replaceState(null, '', `?session=${encodeURIComponent(e.target.value)}`)
          }}
        >
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.cwd || '?'} · {s.sessionId.slice(0, 8)} · {s.precision} · {s.turnCount} 轮
            </option>
          ))}
        </select>
        <span className={`precision precision-${session?.precision ?? 'rich'}`}>{session?.precision ?? ''}</span>
        {stats && (
          <span className="stats">
            {[
              `${stats.turns} 轮`,
              `${stats.steps} 步`,
              `LLM ${formatElapsed(stats.llmMs)}`,
              `工具 ${formatElapsed(stats.toolMs)}`,
              stats.avgTtftMs !== null ? `TTFT ${formatElapsed(stats.avgTtftMs)}` : '',
              stats.tokPerSec !== null ? `${stats.tokPerSec.toFixed(1)} tok/s` : '',
              stats.cacheHitRate !== null ? `缓存 ${formatPercent(stats.cacheHitRate)}` : '',
              `入 ${formatTokens(stats.inputTokens)}`,
              `出 ${formatTokens(stats.outputTokens)}`,
              formatCost(stats.costTotal),
            ].filter(Boolean).join(' · ')}
          </span>
        )}
      </header>
      {timelineTurns.length > 0 && (
        <>
          <TrajectoryToolbar
            actualDuration={actualDuration}
            onActualDurationChange={(v) => { setActualDuration(v); setTimelineSelection(null) }}
            actualTime={actualTime}
            onActualTimeChange={(v) => { setActualTime(v); setTimelineSelection(null) }}
            allTurnsCollapsed={allTurnsCollapsed}
            onToggleAllTurns={toggleAllTurns}
            allAssistantsCollapsed={allAssistantsCollapsed}
            onToggleAllAssistants={toggleAllAssistants}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            t={t}
          />
          <TrajectoryTimeline
            turns={timelineTurns}
            mode={timelineMode}
            range={timelineSelection}
            hasEarlierRecords={false}
            selectedIndex={selectedTimelineIndex}
            searchMatchIndexes={searchMatchIndexes}
            onRangeChange={setTimelineSelection}
            onRecordSelect={handleTimelineRecordSelect}
            onRecordFocus={setTimelineRecordFocus}
          />
          <div className="ledger">
            <TrajectoryTable
              requestNumbers={requestNumbers}
              turns={timelineTurns}
              streamingCells={partialSearchTurns.flatMap((turn) => turn.groups.flatMap((g) => g.cells))}
              timelineFocusIndexes={timelineFocusIndexes}
              searchMatchIndexes={searchMatchIndexes}
              onSelectedIndexChange={setSelectedTimelineIndex}
              onRecordSelect={handleRecordSelect}
              recordSelection={timelineRecordSelection}
              recordFocus={timelineRecordFocus}
              historyLoading={false}
              olderHistoryLoading={false}
              hasOlderRecords={false}
              onClearSelection={() => setTimelineSelection(null)}
              collapsedTurns={collapsedTurns}
              onToggleTurn={toggleTurn}
              collapsedAssistants={collapsedAssistants}
              onToggleAssistant={toggleAssistant}
              sessionId={sessionId ?? undefined}
            />
          </div>
        </>
      )}
      {session && timelineTurns.length === 0 && (
        <div className="empty">会话无轨迹记录</div>
      )}
      {!session && <div className="empty">加载中…</div>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<TraceApp />)
