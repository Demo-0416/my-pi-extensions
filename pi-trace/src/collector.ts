/**
 * Collector：pi 事件流 → TraceRecord（DESIGN.md 3.3 事件映射表）。
 *
 * 一个 Collector 绑定一个会话，持有内存态 TraceSession，并把闭合后的记录
 * 追加到 sidecar JSONL。Web/TUI/SSE 都是它的消费者。
 *
 * 事件映射（3.3）：
 *   turn_start              开 turn；把先到的 user 记录归入该 turn
 *   before_provider_request 记 LLM 调用起点（payload 里取 model）
 *   message_update          首个 content delta 的时间 = 首 token 时间（算 TTFT）
 *   message_end(user)       追加 user 记录
 *   message_end(assistant)  闭合 LLM span：durationMs/ttftMs/usage
 *   tool_execution_start    开 tool 记录
 *   tool_result             取最终 content/details（截断后存入）
 *   tool_execution_end      闭合 tool 记录
 *   turn_end                闭合 turn；广播 SSE stats
 *   session_compact         追加 compaction 记录
 */
import type { TraceRecord, TraceSession, TraceUsage } from './model.ts';
import { groupRecordsByTurn } from './model.ts';
import { truncateField } from './store.ts';
import { computeStats, type TraceStats } from './stats.ts';

/** SSE 增量事件（DESIGN.md 3.8）。 */
export type LiveEvent =
  | { type: 'record'; record: TraceRecord }
  | { type: 'turn'; turn: number; endedAt: number }
  | { type: 'stats'; stats: TraceStats };

type Listener = (event: LiveEvent) => void;

interface LlmStart {
  startedAt: number;
  firstTokenAt: number | null;
  model?: string;
  provider?: string;
  /** 进行中的 assistant 记录 id（addRecord 广播但不落盘，闭合时 closeRecord）。 */
  recordId?: string;
  /** before_provider_request 提取的请求级元数据。 */
  requestConfig?: TraceRecord['requestConfig'];
  toolSchemas?: Record<string, unknown>;
  promptSnapshot?: TraceRecord['promptSnapshot'];
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const type = (block as { type?: unknown }).type;
    if (type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

function oneLine(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function usageFromMessage(message: { usage?: unknown }): TraceUsage | undefined {
  const usage = message.usage as
    | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost?: { total?: number } }
    | undefined;
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    costTotal: usage.cost?.total ?? 0,
    ...(typeof usage.reasoning === 'number' ? { reasoning: usage.reasoning } : {}),
  };
}

/** 提取 assistant 消息里的 tool_call 块（pi ToolCall: {type:'toolCall', id, name, arguments}）。 */
function toolCallsFromContent(content: unknown): Array<{ callId: string; name: string; argsRaw: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ callId: string; name: string; argsRaw: string }> = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    if ((block as { type?: unknown }).type !== 'toolCall') continue;
    const call = block as { id?: unknown; name?: unknown; arguments?: unknown };
    if (typeof call.id !== 'string' || typeof call.name !== 'string') continue;
    let argsRaw = '{}';
    try {
      argsRaw = JSON.stringify(call.arguments ?? {});
    } catch {
      argsRaw = String(call.arguments);
    }
    out.push({ callId: call.id, name: call.name, argsRaw });
  }
  return out;
}

/** 提取 reasoning/thinking 正文（pi ThinkingContent: {type:'thinking', thinking}）。 */
function thinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const type = (block as { type?: unknown }).type;
    if (type !== 'thinking' && type !== 'reasoning') continue;
    const text = (block as { thinking?: unknown; text?: unknown }).thinking
      ?? (block as { text?: unknown }).text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n\n');
}

/**
 * 从 provider 请求 payload 提取请求配置 / prompt 快照 / tool schemas。
 * payload 形状随 provider 不同（OpenAI function wrapper / Anthropic input_schema），防御式提取。
 */
function extractRequestInfo(payload: unknown, fallbackModel?: string, fallbackProvider?: string) {
  const p = typeof payload === 'object' && payload !== null
    ? payload as Record<string, unknown>
    : {};
  const model = typeof p.model === 'string' ? p.model : fallbackModel;
  const requestConfig: NonNullable<TraceRecord['requestConfig']> = {
    ...(fallbackProvider !== undefined ? { provider: fallbackProvider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(typeof p.thinking === 'string' ? { thinking: p.thinking } : {}),
    ...(typeof p.reasoningEffort === 'string' ? { reasoningEffort: p.reasoningEffort } : {}),
    ...(typeof p.reasoning_effort === 'string' ? { reasoningEffort: p.reasoning_effort } : {}),
    ...(typeof p.temperature === 'number' ? { temperature: p.temperature } : {}),
    ...(typeof p.maxTokens === 'number' ? { maxTokens: p.maxTokens } : {}),
    ...(typeof p.max_tokens === 'number' ? { maxTokens: p.max_tokens } : {}),
    ...(Array.isArray(p.stop) ? { stop: p.stop.filter((s): s is string => typeof s === 'string') } : {}),
  };
  const toolSchemas: Record<string, unknown> = {};
  const toolList: NonNullable<TraceRecord['promptSnapshot']>['tools'] = [];
  if (Array.isArray(p.tools)) {
    for (const t of p.tools) {
      if (typeof t !== 'object' || t === null) continue;
      const tool = t as Record<string, unknown>;
      // OpenAI: {type:'function', function:{name, description, parameters}}；其他：平铺。
      const fn = typeof tool.function === 'object' && tool.function !== null
        ? tool.function as Record<string, unknown>
        : tool;
      const name = typeof fn.name === 'string' ? fn.name : undefined;
      if (name === undefined) continue;
      const schema = fn.parameters ?? fn.input_schema ?? fn.inputSchema;
      if (schema !== undefined) toolSchemas[name] = schema;
      toolList.push({
        name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        ...(schema !== undefined ? { parameters: schema } : {}),
      });
    }
  }
  let system = '';
  if (typeof p.system === 'string') {
    system = p.system;
  } else if (Array.isArray(p.system)) {
    system = p.system
      .map((b) => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string'
        ? (b as { text: string }).text
        : ''))
      .join('\n');
  } else if (Array.isArray(p.messages)) {
    const first = p.messages[0];
    if (typeof first === 'object' && first !== null) {
      const role = (first as { role?: unknown }).role;
      if (role === 'system' || role === 'developer') {
        const content = (first as { content?: unknown }).content;
        system = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((b) => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string'
              ? (b as { text: string }).text
              : '')).join('\n')
            : '';
      }
    }
  }
  const promptSnapshot = system !== '' || toolList.length > 0
    ? { system: truncateField(system) as string, tools: toolList }
    : undefined;
  return {
    requestConfig,
    toolSchemas: Object.keys(toolSchemas).length > 0 ? toolSchemas : undefined,
    promptSnapshot,
  };
}

export class Collector {
  readonly session: TraceSession;
  private readonly listeners = new Set<Listener>();
  /** LIFO 栈：compaction 等非 turn 的 provider 请求也会入栈，assistant 闭合时取最近一个。 */
  private readonly llmStarts: LlmStart[] = [];
  /** toolCallId → 进行中的 tool 记录。 */
  private readonly openTools = new Map<string, TraceRecord>();
  /** turn_start 前到达的记录（user 消息、system prompt 快照），等 turn_start 归属。 */
  private pendingTurnRecords: TraceRecord[] = [];
  private currentTurn: number | null = null;
  private seq = 0;
  /** turn 偏移：重建记录的最大 turn + 1，live 事件接续编号。 */
  private turnOffset = 0;
  /** 最近一次 input 事件的来源（归因到下一条 user 记录）。 */
  private lastInputSource: unknown = null;
  /** 被截断字段的原文（recordId:field → 原文），供前端 Show full 展开。 */
  private readonly fullContent = new Map<string, string>();

  /** 截断字符串并存原文，返回截断后的值。 */
  private truncateAndStore(recordId: string, field: string, content: string): string {
    const truncated = truncateField(content) as string;
    if (content !== truncated) {
      this.fullContent.set(`${recordId}:${field}`, content);
    }
    return truncated;
  }

  /** 取被截断字段的原文（live 会话）。 */
  getFullContent(recordId: string, field: string): string | null {
    return this.fullContent.get(`${recordId}:${field}`) ?? null;
  }

  constructor(session: TraceSession) {
    this.session = session;
    this.seq = session.records.length;
    for (const record of session.records) {
      const match = /-r(\d+)$/.exec(record.id);
      if (match) this.seq = Math.max(this.seq, Number(match[1]) + 1);
      if (record.turn !== null) this.turnOffset = Math.max(this.turnOffset, record.turn + 1);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: LiveEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个消费者失败不影响采集。
      }
    }
  }

  private nextId(): string {
    return `${this.session.sessionId}-r${this.seq++}`;
  }

  /** 内存追加 + 广播（不落盘；落盘在 closeRecord）。 */
  private addRecord(record: TraceRecord): void {
    this.session.records.push(record);
    this.attachToTurn(record);
    this.session.endedAt = record.startedAt + (record.durationMs ?? 0);
    this.emit({ type: 'record', record });
  }

  private attachToTurn(record: TraceRecord): void {
    if (record.turn === null) return;
    let bucket = this.session.turns.find(t => t.turn === record.turn);
    if (bucket === undefined) {
      bucket = { turn: record.turn, startedAt: record.startedAt, endedAt: null, records: [] };
      this.session.turns.push(bucket);
      this.session.turns.sort((a, b) => a.turn - b.turn);
    }
    bucket.records.push(record);
    bucket.startedAt = Math.min(bucket.startedAt, record.startedAt);
  }

  /** 记录闭合：算 durationMs、广播 upsert。纯内存，不落盘。 */
  private closeRecord(record: TraceRecord, durationMs: number | null): void {
    record.durationMs = durationMs;
    this.attachToTurn(record);
    const end = record.startedAt + (durationMs ?? 0);
    const bucket = record.turn === null
      ? undefined
      : this.session.turns.find(t => t.turn === record.turn);
    if (bucket) bucket.endedAt = bucket.endedAt === null ? end : Math.max(bucket.endedAt, end);
    this.session.endedAt = this.session.endedAt === null ? end : Math.max(this.session.endedAt, end);
    this.emit({ type: 'record', record });
  }

  // --- 3.3 事件映射 -------------------------------------------------------

  onTurnStart(turnIndex: number, timestamp: number): void {
    this.currentTurn = turnIndex + this.turnOffset;
    // user 消息和 system prompt 快照先于 turn_start 到达，归入本 turn。
    for (const record of this.pendingTurnRecords) {
      record.turn = this.currentTurn;
      this.attachToTurn(record);
      this.emit({ type: 'record', record });
    }
    this.pendingTurnRecords = [];
    if (!this.session.turns.some(t => t.turn === this.currentTurn)) {
      this.session.turns.push({ turn: this.currentTurn, startedAt: timestamp, endedAt: null, records: [] });
      this.session.turns.sort((a, b) => a.turn - b.turn);
    }
  }

  onBeforeProviderRequest(payload: unknown, fallbackModel?: string, fallbackProvider?: string): void {
    const payloadModel = typeof payload === 'object' && payload !== null
      ? (payload as { model?: unknown }).model
      : undefined;
    const model = typeof payloadModel === 'string' ? payloadModel : fallbackModel;
    const info = extractRequestInfo(payload, fallbackModel, fallbackProvider);
    const start: LlmStart = {
      startedAt: Date.now(),
      firstTokenAt: null,
      model,
      provider: fallbackProvider,
      requestConfig: info.requestConfig,
      toolSchemas: info.toolSchemas,
      promptSnapshot: info.promptSnapshot,
    };
    // 进行中的 assistant 记录：广播但不落盘（对齐 dsh runningCalls/partial cell）。
    const record: TraceRecord = {
      id: this.nextId(),
      kind: 'assistant',
      turn: this.currentTurn,
      startedAt: start.startedAt,
      durationMs: null,
      text: model ? `${model} …` : '…',
      isError: false,
      model,
      provider: fallbackProvider,
      ttftMs: null,
    };
    start.recordId = record.id;
    this.llmStarts.push(start);
    // 防止未闭合的 LLM 请求堆积（error/interruption 时 onMessageEnd 不会触发）。
    if (this.llmStarts.length > 10) this.llmStarts.shift();
    this.addRecord(record);
  }

  onMessageUpdate(): void {
    // 首个 content delta 的时间 = 首 token 时间。
    const start = this.llmStarts[this.llmStarts.length - 1];
    if (start !== undefined && start.firstTokenAt === null) {
      start.firstTokenAt = Date.now();
    }
  }

  onMessageEnd(message: {
    role?: string;
    content?: unknown;
    timestamp?: number;
    provider?: string;
    model?: string;
    stopReason?: string;
    usage?: unknown;
  }): void {
    if (message.role === 'user') {
      // source 不是 interactive 的 user 消息 → context（系统注入的上下文/提醒）。
      const sourceKind = (this.lastInputSource as { kind?: string } | null)?.kind;
      const isContext = sourceKind !== undefined && sourceKind !== 'interactive';
      const record: TraceRecord = {
        id: this.nextId(),
        kind: isContext ? 'context' : 'user',
        turn: this.currentTurn,
        startedAt: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
        durationMs: null,
        text: oneLine(textFromContent(message.content)),
        fullText: textFromContent(message.content),
        isError: false,
        source: this.lastInputSource ?? undefined,
      };
      this.session.records.push(record);
      this.session.endedAt = record.startedAt;
      if (this.currentTurn === null) {
        // 等 turn_start 归属后再广播完整记录。
        this.pendingTurnRecords.push(record);
      } else {
        this.attachToTurn(record);
        this.emit({ type: 'record', record });
      }
      return;
    }
    if (message.role === 'assistant') {
      const start = this.llmStarts.pop();
      const now = Date.now();
      const startedAt = start?.startedAt
        ?? (typeof message.timestamp === 'number' ? message.timestamp : now);
      const existing = start?.recordId !== undefined
        ? this.session.records.find(r => r.id === start.recordId)
        : undefined;
      const ttftMs = start?.firstTokenAt !== null && start?.firstTokenAt !== undefined
        ? start.firstTokenAt - startedAt
        : null;
      if (existing !== undefined) {
        // 闭合进行中的记录：补全字段后落盘 + 广播。
        existing.text = oneLine(textFromContent(message.content));
        existing.fullText = this.truncateAndStore(existing.id, 'fullText', textFromContent(message.content));
        existing.thinking = this.truncateAndStore(existing.id, 'thinking', thinkingFromContent(message.content)) || undefined;
        existing.toolCalls = toolCallsFromContent(message.content);
        existing.isError = message.stopReason === 'error';
        existing.model = start?.model ?? message.model;
        existing.provider = start?.provider ?? message.provider;
        existing.usage = usageFromMessage(message);
        existing.ttftMs = ttftMs;
        existing.requestConfig = start?.requestConfig;
        existing.toolSchemas = start?.toolSchemas;
        existing.promptSnapshot = start?.promptSnapshot;
        this.closeRecord(existing, Math.max(0, now - startedAt));
        return;
      }
      const newId = this.nextId();
      const record: TraceRecord = {
        id: newId,
        kind: 'assistant',
        turn: this.currentTurn,
        startedAt,
        durationMs: null,
        text: oneLine(textFromContent(message.content)),
        fullText: this.truncateAndStore(newId, 'fullText', textFromContent(message.content)),
        thinking: this.truncateAndStore(newId, 'thinking', thinkingFromContent(message.content)) || undefined,
        toolCalls: toolCallsFromContent(message.content),
        isError: message.stopReason === 'error',
        model: start?.model ?? message.model,
        provider: start?.provider ?? message.provider,
        usage: usageFromMessage(message),
        ttftMs,
        requestConfig: start?.requestConfig,
        toolSchemas: start?.toolSchemas,
        promptSnapshot: start?.promptSnapshot,
      };
      this.session.records.push(record);
      this.closeRecord(record, Math.max(0, now - startedAt));
      return;
    }
    // role=toolResult 的 message_end 忽略：tool 记录以 tool_execution_* 为准。
  }

  onToolExecutionStart(toolCallId: string, toolName: string, args: unknown): void {
    const record: TraceRecord = {
      id: this.nextId(),
      kind: 'tool',
      turn: this.currentTurn,
      startedAt: Date.now(),
      durationMs: null,
      text: `${toolName} ${oneLine(JSON.stringify(args ?? {}), 120)}`,
      isError: false,
      toolName,
      callId: toolCallId,
      args: truncateField(args),
    };
    this.openTools.set(toolCallId, record);
    this.addRecord(record);
  }

  /** input 事件：记录来源，归因到下一条 user 记录。 */
  onInput(source: unknown): void {
    this.lastInputSource = source;
  }

  onToolResult(
    toolCallId: string,
    content: unknown,
    details: unknown,
    isError: boolean,
  ): void {
    const record = this.openTools.get(toolCallId);
    if (record === undefined) return;
    record.result = this.truncateAndStore(record.id, 'result', textFromContent(content) || stringifyDetails(details));
    record.isError = isError;
    const exitCode = (details as { exitCode?: unknown } | null)?.exitCode;
    if (typeof exitCode === 'number') record.exitCode = exitCode;
    this.emit({ type: 'record', record });
  }

  onToolExecutionEnd(toolCallId: string, result: unknown, isError: boolean): void {
    const record = this.openTools.get(toolCallId);
    if (record === undefined) return;
    this.openTools.delete(toolCallId);
    if (record.result === undefined) record.result = this.truncateAndStore(record.id, 'result', stringifyResult(result));
    record.isError = isError;
    this.closeRecord(record, Math.max(0, Date.now() - record.startedAt));
  }

  onTurnEnd(turnIndex: number): void {
    const bucket = this.session.turns.find(t => t.turn === turnIndex);
    const endedAt = Date.now();
    if (bucket) bucket.endedAt = endedAt;
    this.session.endedAt = endedAt;
    this.currentTurn = null;
    this.emit({ type: 'turn', turn: turnIndex, endedAt });
    this.emit({ type: 'stats', stats: computeStats(this.session) });
  }

  onSessionCompact(summary: string, tokensBefore?: number): void {
    const record: TraceRecord = {
      id: this.nextId(),
      kind: 'compacted',
      turn: this.currentTurn,
      startedAt: Date.now(),
      durationMs: null,
      text: oneLine(summary || `compaction (${tokensBefore ?? '?'} tokens before)`),
      isError: false,
    };
    this.session.records.push(record);
    this.attachToTurn(record);
    this.emit({ type: 'record', record });
  }

  onModelChange(provider: string, modelId: string): void {
    const record: TraceRecord = {
      id: this.nextId(),
      kind: 'system',
      turn: this.currentTurn,
      startedAt: Date.now(),
      durationMs: null,
      text: `model → ${provider}/${modelId}`,
      isError: false,
      model: modelId,
      provider,
    };
    this.session.records.push(record);
    this.attachToTurn(record);
    this.emit({ type: 'record', record });
  }

  /**
   * system prompt + 工具目录快照（对齐 dsh SYSTEM 记录的 promptDetail）。
   * 在 before_agent_start 采集：每次用户发起 agent run 一条。
   * systemPrompt 单字段截断 8KB（DESIGN 3.11），超出部分前端标注 truncated。
   */
  onBeforeAgentStart(input: {
    systemPrompt: string;
    toolSnippets?: readonly string[];
    selectedTools?: readonly string[];
    model?: string;
    provider?: string;
    cwd?: string;
    thinkingLevel?: string;
    customPrompt?: string;
  }): void {
    const promptBytes = Buffer.byteLength(input.systemPrompt, 'utf8');
    const sysId = this.nextId();
    const record: TraceRecord = {
      id: sysId,
      kind: 'system',
      turn: this.currentTurn,
      startedAt: Date.now(),
      durationMs: null,
      text: `system prompt · ${input.selectedTools?.length ?? input.toolSnippets?.length ?? 0} tools · ${input.model ?? '?'}`,
      isError: false,
      model: input.model,
      provider: input.provider,
      // system prompt 截断到 8KB，原文存 fullContent 供前端 Show full 展开。
      prompt: this.truncateAndStore(sysId, 'prompt', input.systemPrompt),
      args: {
        systemPromptBytes: promptBytes,
        systemPromptTruncated: promptBytes > 8192,
        tools: input.selectedTools ?? input.toolSnippets ?? [],
        toolSnippets: input.toolSnippets ?? [],
        cwd: input.cwd,
        thinkingLevel: input.thinkingLevel,
        customPrompt: input.customPrompt,
      },
    };
    // system prompt 截断到 8KB 存在记录里（不写 blob 文件）。
    this.session.records.push(record);
    if (this.currentTurn === null) {
      // before_agent_start 先于 turn_start，缓冲到 turn_start 归属。
      this.pendingTurnRecords.push(record);
    } else {
      this.attachToTurn(record);
      this.emit({ type: 'record', record });
    }
  }

  /** 重新分组（重建后修正 turn 桶）。 */
  regroup(): void {
    this.session.turns = groupRecordsByTurn(this.session.records);
  }
}

function stringifyDetails(details: unknown): string {
  if (details === undefined || details === null) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function stringifyResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

