/**
 * adapter：pi TraceSession JSON → dsh layout 输入。
 *
 * 输出 { nodes, requests, partial, runningCalls, callSchemas }，
 * 喂给 vendor/layout.ts 的 deriveTrajectoryLayout。
 *
 * 映射要点：
 *   - seq：记录顺序 1-based
 *   - turn：pi turnIndex（0-based）→ dsh turn（1-based）；null 归到下一个 turn
 *   - step：pi 一个 turn 一次 LLM 调用，恒为 1
 *   - assistant 记录 → AssistantMessageNode（blocks: text/reasoning/tool-call）
 *     + AssistantRequestView（status/usage/provenance/requestConfig/prompt）
 *   - tool 记录 → ToolResultNode（callId 关联 assistant 的 tool-call block）
 *   - system 记录 → 合并进下一个 request 的 prompt/promptChange（dsh 无 system node）
 *   - 未闭合的 assistant/tool → partial / runningCalls（流式）
 */

// --- 结构类型（与 src/model.ts 同形，浏览器端不 import 服务端 TS） ---

interface UsageJson {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costTotal: number
  reasoning?: number
}

interface ToolCallJson {
  callId: string
  name: string
  argsRaw: string
}

interface PromptSnapshotJson {
  system: string
  tools: Array<{ name: string; description?: string; parameters?: unknown }>
}

interface RecordJson {
  id: string
  kind: 'system' | 'user' | 'assistant' | 'tool' | 'compaction'
  turn: number | null
  startedAt: number
  durationMs: number | null
  text: string
  fullText?: string
  isError: boolean
  model?: string
  provider?: string
  usage?: UsageJson
  ttftMs?: number | null
  toolName?: string
  args?: unknown
  result?: unknown
  exitCode?: number
  prompt?: string
  thinking?: string
  callId?: string
  requestConfig?: {
    provider?: string
    model?: string
    thinking?: string
    reasoningEffort?: string
    temperature?: number
    maxTokens?: number
    stop?: readonly string[]
  }
  promptSnapshot?: PromptSnapshotJson
  toolSchemas?: Record<string, unknown>
  toolCalls?: ToolCallJson[]
  source?: unknown
}

interface SessionJson {
  sessionId: string
  cwd: string
  startedAt: number
  endedAt: number | null
  records: RecordJson[]
  precision: 'rich' | 'reconstructed'
}

export interface AdapterResult {
  nodes: unknown[]
  requests: unknown[]
  partial: { turn: number; step: number; blocks: unknown[] } | null
  runningCalls: unknown[]
  callSchemas: Map<string, unknown>
}

function dshTurn(record: RecordJson, nextTurn: number): number {
  return record.turn === null ? nextTurn : record.turn + 1
}

function usageToDsh(usage: UsageJson | undefined) {
  if (!usage) return undefined
  return {
    inputTokens: usage.input,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    outputTokens: usage.output,
    ...(usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : {}),
  }
}

function argsRawOf(record: RecordJson): string {
  if (record.toolCalls?.length) {
    // tool 记录本身没有 toolCalls；assistant 才有。tool 记录用 args。
  }
  if (record.args === undefined || record.args === null) return '{}'
  if (typeof record.args === 'string') return record.args
  try {
    return JSON.stringify(record.args)
  } catch {
    return String(record.args)
  }
}

function resultTextOf(record: RecordJson): string {
  const r = record.result
  if (r === undefined || r === null) return ''
  if (typeof r === 'string') return r
  if (typeof r === 'object' && r !== null && '_truncated' in r) {
    return String((r as { preview?: unknown }).preview ?? '')
  }
  try {
    return JSON.stringify(r)
  } catch {
    return String(r)
  }
}

/**
 * 把一个 TraceSession 适配成 dsh layout 输入。
 * @param session - /api/session 返回的 JSON
 */
export function adaptSession(session: SessionJson): AdapterResult {
  const records = [...session.records].sort((a, b) => a.startedAt - b.startedAt)
  const nodes: unknown[] = []
  const requests: unknown[] = []
  const callSchemas = new Map<string, unknown>()
  let partial: AdapterResult['partial'] = null
  const runningCalls: unknown[] = []

  let seq = 0
  let lastTurn = 0
  let firstRequest = true
  let lastPromptSnapshot: PromptSnapshotJson | undefined
  let pendingSystemSnapshot: PromptSnapshotJson | undefined

  for (const record of records) {
    const turn = dshTurn(record, lastTurn + 1)
    lastTurn = Math.max(lastTurn, turn)

    if (record.kind === 'system') {
      // system 记录 → 快照，合并进下一个 assistant request。
      // collector 存的 args.tools 是字符串数组；reconstructed 可能没有。
      const args = record.args as { tools?: unknown } | undefined
      const rawTools = Array.isArray(args?.tools) ? args.tools : []
      const tools = rawTools.map((t) => (typeof t === 'string' ? { name: t } : { name: String(t) }))
      pendingSystemSnapshot = {
        system: record.prompt ?? '',
        tools,
      }
      continue
    }

    if (record.kind === 'user') {
      nodes.push({
        kind: 'user',
        seq: ++seq,
        time: record.startedAt,
        content: [{ type: 'text', text: record.fullText ?? record.text }],
        ...(record.source !== undefined ? { source: record.source } : {}),
      })
      continue
    }

    if (record.kind === 'assistant') {
      const completed = record.durationMs !== null
      const stepStartTime = record.startedAt
      const firstTokenTime = record.ttftMs !== null && record.ttftMs !== undefined
        ? record.startedAt + record.ttftMs
        : null
      const completedTime = completed ? record.startedAt + record.durationMs! : record.startedAt

      const blocks: unknown[] = []
      const text = record.fullText ?? record.text
      if (text) blocks.push({ kind: 'text', text })
      if (record.thinking) blocks.push({ kind: 'reasoning', text: record.thinking })
      for (const call of record.toolCalls ?? []) {
        blocks.push({ kind: 'tool-call', callId: call.callId, name: call.name, argsRaw: call.argsRaw })
      }

      const usage = usageToDsh(record.usage)
      const provenance = record.model || record.provider
        ? { provider: record.provider ?? 'unknown', model: record.model ?? 'unknown' }
        : undefined

      // prompt 快照：优先 assistant 自带（payload 提取，含 schema），否则用 system 记录的。
      const promptSnapshot = record.promptSnapshot ?? pendingSystemSnapshot ?? lastPromptSnapshot
      const hadSystemSinceLast = pendingSystemSnapshot !== undefined
      pendingSystemSnapshot = undefined
      // promptChange 只在首次或快照实际变化时发（dsh 靠它生成 SYSTEM cell）。
      const snapshotKey = promptSnapshot ? JSON.stringify(promptSnapshot) : null
      const lastKey = lastPromptSnapshot ? JSON.stringify(lastPromptSnapshot) : null
      const previousSnapshot = lastPromptSnapshot
      const promptChanged = promptSnapshot !== undefined && (firstRequest || (hadSystemSinceLast && snapshotKey !== lastKey))
      if (promptSnapshot) lastPromptSnapshot = promptSnapshot

      const node = {
        kind: 'assistant',
        seq: ++seq,
        time: completedTime,
        turn,
        step: 1,
        blocks,
        ...(usage ? { usage } : {}),
        ...(provenance ? { provenance } : {}),
        ...(record.requestConfig ? { requestConfig: record.requestConfig } : {}),
        timing: { stepStartTime, firstTokenTime, completedTime },
      }
      nodes.push(node)

      const request = {
        purpose: 'assistant' as const,
        turn,
        step: 1,
        startSeq: seq,
        startedAt: record.startedAt,
        completedAt: completed ? completedTime : null,
        status: completed ? (record.isError ? 'error' : 'complete') : 'running',
        ...(record.isError ? { error: record.text || 'error' } : {}),
        ...(provenance ? { provenance } : {}),
        ...(record.requestConfig ? { requestConfig: record.requestConfig } : {}),
        ...(usage ? { usage } : {}),
        ...(promptSnapshot
          ? { prompt: promptSnapshot }
          : {}),
        ...(promptChanged
          ? {
              promptChange: {
                kind: firstRequest ? ('initial' as const) : ('system-and-tools' as const),
                seq,
                time: record.startedAt,
                ...(!firstRequest && previousSnapshot
                  ? { previous: previousSnapshot }
                  : {}),
              },
            }
          : {}),
        resultSeq: seq,
      }
      requests.push(request)
      firstRequest = false

      // tool schemas：callId → schema（按 toolCalls 顺序关联）。
      if (record.toolSchemas) {
        for (const call of record.toolCalls ?? []) {
          const schema = record.toolSchemas[call.name]
          if (schema !== undefined) callSchemas.set(call.callId, schema)
        }
      }

      if (!completed) {
        // 流式中的 assistant → partial
        partial = { turn, step: 1, blocks }
      }
      continue
    }

    if (record.kind === 'tool') {
      const completed = record.durationMs !== null
      const callId = record.callId ?? `syn-${record.id}`
      const name = record.toolName ?? 'tool'
      const endTime = completed ? record.startedAt + record.durationMs! : record.startedAt
      const resultText = resultTextOf(record)
      if (completed) {
        nodes.push({
          kind: 'tool-result',
          seq: ++seq,
          time: endTime,
          callId,
          call: { name, argsRaw: argsRawOf(record) },
          callTime: record.startedAt,
          content: resultText ? [{ type: 'text', text: resultText }] : [],
          isError: record.isError,
          ...(record.isError ? { error: { name: 'ToolError', code: String(record.exitCode ?? 'error') } } : {}),
          subCalls: [],
        })
      } else {
        runningCalls.push({
          callId,
          name,
          argsRaw: argsRawOf(record),
          turn,
          step: 1,
          time: record.startedAt,
          subCalls: [],
        })
      }
      continue
    }

    if (record.kind === 'compaction') {
      const completed = record.durationMs !== null
      const endTime = completed ? record.startedAt + record.durationMs! : null
      requests.push({
        purpose: 'compaction' as const,
        turn: null,
        step: 0,
        startSeq: ++seq,
        startedAt: record.startedAt,
        completedAt: endTime,
        status: completed ? (record.isError ? 'error' : 'complete') : 'running',
        ...(record.isError ? { error: record.text } : {}),
        summary: [{ type: 'text', text: record.fullText ?? record.text }],
      })
      continue
    }
  }

  return { nodes, requests, partial, runningCalls, callSchemas }
}
