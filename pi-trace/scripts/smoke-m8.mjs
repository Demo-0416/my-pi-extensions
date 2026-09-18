/**
 * M8 冒烟测试（隔离 HOME，不读写用户的会话或 .port）：
 *   1. 造一个假 session JSONL → reconstructFromSessionFile → 校验记录/turn/统计
 *   2. Collector 模拟一轮 pi 事件 → 校验 rich 记录（内存采集，不落盘）
 *   3. TraceServer 起在 127.0.0.1 → 打 /api/sessions、/api/session、/api/from-file、SSE
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pi-trace-test-'));
process.env.HOME = dir;
process.env.USERPROFILE = dir;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
// Import after isolating HOME: store.ts resolves session paths at module load.
const { reconstructFromSessionFile } = await import('../src/session-loader.ts');
const { emptySession } = await import('../src/model.ts');
const { Collector } = await import('../src/collector.ts');
const { computeStats, widgetLineParts } = await import('../src/stats.ts');
const { SESSIONS_DIR } = await import('../src/store.ts');
const { TraceServer } = await import('../src/server.ts');
const sessionFile = join(dir, 'test-session.jsonl');

const t0 = Date.parse('2025-08-17T12:00:00.000Z');
const lines = [
  JSON.stringify({ type: 'session', version: 3, id: 'test-session-id', timestamp: '2025-08-17T12:00:00.000Z', cwd: '/tmp/project' }),
  JSON.stringify({ type: 'message', id: 'a1', parentId: null, timestamp: '2025-08-17T12:00:01.000Z', message: { role: 'user', content: 'tell me about cli 设计', timestamp: t0 + 1000 } }),
  JSON.stringify({ type: 'message', id: 'a2', parentId: 'a1', timestamp: '2025-08-17T12:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls -la' } }], provider: 'anthropic', model: 'claude-sonnet-4', usage: { input: 1000, output: 50, cacheRead: 500, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: 'toolUse', timestamp: t0 + 2000 } }),
  JSON.stringify({ type: 'message', id: 'a3', parentId: 'a2', timestamp: '2025-08-17T12:00:06.000Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'total 0' }], details: { exitCode: 0 }, isError: false, timestamp: t0 + 6000 } }),
  JSON.stringify({ type: 'model_change', id: 'a4', parentId: 'a3', timestamp: '2025-08-17T12:01:00.000Z', provider: 'openai', modelId: 'gpt-4o' }),
  JSON.stringify({ type: 'message', id: 'a5', parentId: 'a4', timestamp: '2025-08-17T12:01:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], provider: 'openai', model: 'gpt-4o', usage: { input: 1200, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } }, stopReason: 'stop', timestamp: t0 + 61000 } }),
  JSON.stringify({ type: 'compaction', id: 'a6', parentId: 'a5', timestamp: '2025-08-17T12:02:00.000Z', summary: 'User discussed cli design', tokensBefore: 50000 }),
];
writeFileSync(sessionFile, lines.join('\n') + '\n');
mkdirSync(SESSIONS_DIR, { recursive: true });
const historyFile = join(SESSIONS_DIR, 'test-session.jsonl');
writeFileSync(historyFile, lines.join('\n') + '\n');

// --- 1. 重建 ---
const reconstructed = reconstructFromSessionFile(sessionFile);
console.log('reconstructed:', {
  precision: reconstructed.precision,
  records: reconstructed.records.length,
  turns: reconstructed.turns.length,
  kinds: reconstructed.records.map(r => r.kind),
  turnOfUser: reconstructed.records[0].turn,
  toolArgs: reconstructed.records.find(r => r.kind === 'tool')?.args,
  toolExit: reconstructed.records.find(r => r.kind === 'tool')?.exitCode,
  durationOfFirst: reconstructed.records[0].durationMs,
  ttft: reconstructed.records.find(r => r.kind === 'assistant')?.ttftMs,
});
const rStats = computeStats(reconstructed);
console.log('reconstructed stats:', rStats);
assert.equal(rStats.llmMs, 7000);
assert.equal(rStats.tokPerSec, 150 / 7);
assert.equal(rStats.toolMs, 1000);

// --- 2. Collector 模拟事件（含 M9 新字段）---
const live = emptySession('live-session-id', sessionFile, '/tmp/project', Date.now());
const collector = new Collector(live);
collector.onInput({ kind: 'interactive' });
collector.onMessageEnd({ role: 'user', content: 'hello', timestamp: Date.now() - 5000 });
collector.onTurnStart(0, Date.now());
collector.onBeforeProviderRequest(
  {
    model: 'claude-sonnet-4',
    system: 'You are a coding agent.',
    tools: [{ type: 'function', function: { name: 'bash', description: 'Run a command', parameters: { type: 'object' } } }],
    temperature: 1,
  },
  'claude-sonnet-4',
  'anthropic',
);
collector.onMessageUpdate({ type: 'text_delta', delta: 'hi' }); // 首 token
collector.onMessageEnd({
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'reasoning about the task' },
    { type: 'text', text: 'hi there' },
    { type: 'toolCall', id: 'call_9', name: 'bash', arguments: { command: 'ls' } },
  ],
  timestamp: Date.now(),
  provider: 'anthropic',
  model: 'claude-sonnet-4',
  usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 5, cost: { total: 0.005 } },
  stopReason: 'toolUse',
});
collector.onToolExecutionStart('call_9', 'bash', { command: 'ls' });
collector.onToolResult('call_9', [{ type: 'text', text: 'out' }], { exitCode: 0 }, false);
collector.onToolExecutionEnd('call_9', 'done', false);
collector.onTurnEnd(0);
console.log('live records:', live.records.map(r => ({ kind: r.kind, turn: r.turn, dur: r.durationMs, ttft: r.ttftMs, exit: r.exitCode })));
// M9 新字段校验
const liveAssistant = live.records.find(r => r.kind === 'assistant');
const liveTool = live.records.find(r => r.kind === 'tool');
const liveUser = live.records.find(r => r.kind === 'user');
console.log('M9 fields:', {
  thinking: liveAssistant?.thinking?.slice(0, 20),
  toolCalls: liveAssistant?.toolCalls?.length,
  requestConfig: liveAssistant?.requestConfig?.model,
  promptSnapshotTools: liveAssistant?.promptSnapshot?.tools?.length,
  toolSchemas: Object.keys(liveAssistant?.toolSchemas ?? {}).length,
  reasoning: liveAssistant?.usage?.reasoning,
  callId: liveTool?.callId,
  source: liveUser?.source,
  fullText: liveAssistant?.fullText?.slice(0, 15),
});
if (!liveAssistant?.thinking) throw new Error('M9: thinking not captured');
if (!liveAssistant?.toolCalls?.length) throw new Error('M9: toolCalls not captured');
if (!liveAssistant?.requestConfig) throw new Error('M9: requestConfig not captured');
if (!liveAssistant?.promptSnapshot) throw new Error('M9: promptSnapshot not captured');
if (!liveTool?.callId) throw new Error('M9: callId not captured');
if (liveAssistant?.usage?.reasoning !== 5) throw new Error('M9: reasoning tokens not captured');
console.log('M9 fields OK');

// context 分类校验：source !== 'interactive' 的 user 消息 → context kind
collector.onInput({ kind: 'extension' });
collector.onMessageEnd({ role: 'user', content: 'system-reminder: skill loaded', timestamp: Date.now() });
const contextRecord = live.records.find(r => r.kind === 'context');
if (!contextRecord) throw new Error('context: source=extension should classify as context kind');
if (!contextRecord.text.includes('system-reminder')) throw new Error('context: text mismatch');
console.log('context classification OK');

// source=interactive 的 user 消息仍然是 user kind
collector.onInput({ kind: 'interactive' });
collector.onMessageEnd({ role: 'user', content: 'second user message', timestamp: Date.now() });
const userRecords = live.records.filter(r => r.kind === 'user');
if (userRecords.length !== 2) throw new Error(`context: expected 2 user records, got ${userRecords.length}`);
console.log('user classification OK');
console.log('live stats:', computeStats(live));
// widget 行（防 theme 作用域类回归：纯函数可单测）
const widgetParts = widgetLineParts(computeStats(live));
console.log('widget parts:', widgetParts);
if (!widgetParts[0].startsWith('✻')) throw new Error('widget line missing ✻ prefix');
// 内存记录校验（插件不写 sidecar）
const liveRecords = live.records;
console.log('in-memory records:', liveRecords.length, 'meta:', { sessionId: live.sessionId, cwd: live.cwd });

// --- 3. Server ---
const server = new TraceServer(join(import.meta.dirname, '..', 'src', 'web'));
const port = await server.start();
console.log('server port:', port);
server.register(collector);

const base = `http://127.0.0.1:${port}`;
const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.text() };
};

const sessions = await get('/api/sessions');
console.log('GET /api/sessions:', sessions.status, JSON.parse(sessions.body).length, 'sessions');

const liveApi = await get('/api/session/live-session-id');
console.log('GET /api/session/live:', liveApi.status, JSON.parse(liveApi.body).records.length, 'records');

const reconApi = await get(`/api/from-file?path=${encodeURIComponent(sessionFile)}`);
console.log('GET /api/from-file (outside sessions dir):', reconApi.status, '(expect 403)');

assert.equal(sessions.status, 200);
assert.equal(liveApi.status, 200);
assert.equal(reconApi.status, 403);
const ok = await get(`/api/from-file?path=${encodeURIComponent(historyFile)}`);
assert.equal(ok.status, 200);
assert.equal(JSON.parse(ok.body).precision, 'reconstructed');
console.log('GET /api/from-file (fixture):', ok.status);

const outside = await get(`/api/from-file?path=${encodeURIComponent('/etc/passwd')}`);
console.log('GET /api/from-file /etc/passwd:', outside.status, '(expect 403)');
assert.equal(outside.status, 403);

const index = await get('/');
console.log('GET /:', index.status, index.body.includes('pi-trace') ? 'html ok' : 'html MISSING');
console.log('GET / (bundle ref):', index.body.includes('/dist/host.js') ? 'bundle ref ok' : 'bundle ref MISSING');

const bundle = await get('/dist/host.js');
console.log('GET /dist/host.js:', bundle.status, bundle.status === 200 ? 'bundle ok' : 'bundle MISSING');
assert.equal(index.status, 200);
assert.equal(bundle.status, 200);

// SSE：收 hello 后退出
const sseRes = await fetch(`${base}/api/events?session=live-session-id`);
const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
const { value } = await reader.read();
const text = decoder.decode(value);
console.log('SSE hello:', text.includes('event: hello') ? 'ok' : 'MISSING', text.includes('"precision":"rich"') ? 'rich ok' : '');
assert.ok(text.includes('event: hello'));
await reader.cancel();

// 增量广播：新开一个 SSE，然后触发一条记录
const sseRes2 = await fetch(`${base}/api/events?session=live-session-id`);
const reader2 = sseRes2.body.getReader();
await reader2.read(); // hello
const dec2 = new TextDecoder();
let got = '';
const waiter = (async () => {
  while (true) {
    const { value: v, done } = await reader2.read();
    if (done) break;
    got += dec2.decode(v);
    if (got.includes('event: record')) break;
  }
})();
collector.onModelChange('anthropic', 'claude-opus-4');
await waiter;
console.log('SSE record broadcast:', got.includes('event: record') ? 'ok' : 'MISSING');
assert.ok(got.includes('event: record'));
await reader2.cancel();

rmSync(dir, { recursive: true, force: true });
console.log('SMOKE TEST DONE');
process.exit(0);
