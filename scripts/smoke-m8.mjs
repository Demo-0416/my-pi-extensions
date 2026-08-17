/**
 * M8 冒烟测试（不入仓）：
 *   1. 造一个假 session JSONL → reconstructFromSessionFile → 校验记录/turn/统计
 *   2. Collector 模拟一轮 pi 事件 → 校验 rich 记录 + sidecar 落盘
 *   3. TraceServer 起在 127.0.0.1 → 打 /api/sessions、/api/session、/api/from-file、SSE
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconstructFromSessionFile } from '../src/session-loader.ts';
import { emptySession } from '../src/model.ts';
import { Collector } from '../src/collector.ts';
import { computeStats, widgetLineParts } from '../src/stats.ts';
import { readSidecar, TRACES_DIR } from '../src/store.ts';
import { TraceServer } from '../src/server.ts';

const dir = mkdtempSync(join(tmpdir(), 'pi-trace-test-'));
const sessionFile = join(dir, 'test-session.jsonl');

const t0 = Date.parse('2025-08-17T12:00:00.000Z');
const lines = [
  JSON.stringify({ type: 'session', version: 3, id: 'test-session-id', timestamp: '2025-08-17T12:00:00.000Z', cwd: '/tmp/project' }),
  JSON.stringify({ type: 'message', id: 'a1', parentId: null, timestamp: '2025-08-17T12:00:01.000Z', message: { role: 'user', content: 'tell me about cli 设计', timestamp: t0 + 1000 } }),
  JSON.stringify({ type: 'message', id: 'a2', parentId: 'a1', timestamp: '2025-08-17T12:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls -la' } }], provider: 'anthropic', model: 'claude-sonnet-4', usage: { input: 1000, output: 50, cacheRead: 500, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: 'toolUse', timestamp: t0 + 5000 } }),
  JSON.stringify({ type: 'message', id: 'a3', parentId: 'a2', timestamp: '2025-08-17T12:00:06.000Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'total 0' }], details: { exitCode: 0 }, isError: false, timestamp: t0 + 6000 } }),
  JSON.stringify({ type: 'model_change', id: 'a4', parentId: 'a3', timestamp: '2025-08-17T12:01:00.000Z', provider: 'openai', modelId: 'gpt-4o' }),
  JSON.stringify({ type: 'message', id: 'a5', parentId: 'a4', timestamp: '2025-08-17T12:01:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], provider: 'openai', model: 'gpt-4o', usage: { input: 1200, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } }, stopReason: 'stop', timestamp: t0 + 65000 } }),
  JSON.stringify({ type: 'compaction', id: 'a6', parentId: 'a5', timestamp: '2025-08-17T12:02:00.000Z', summary: 'User discussed cli design', tokensBefore: 50000 }),
];
writeFileSync(sessionFile, lines.join('\n') + '\n');

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
collector.onMessageUpdate(); // 首 token
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
console.log('live stats:', computeStats(live));
// widget 行（防 theme 作用域类回归：纯函数可单测）
const widgetParts = widgetLineParts(computeStats(live));
console.log('widget parts:', widgetParts);
if (!widgetParts[0].startsWith('✻')) throw new Error('widget line missing ✻ prefix');
const sidecar = readSidecar('live-session-id');
console.log('sidecar records:', sidecar?.records.length, 'meta:', sidecar?.meta);

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

// 用真实 sessions 目录里的文件验证成功路径
const sessionsList = JSON.parse(sessions.body);
const realSession = sessionsList.find(s => s.sessionFile && s.precision === 'reconstructed');
if (realSession) {
  const ok = await get(`/api/from-file?path=${encodeURIComponent(realSession.sessionFile)}`);
  console.log('GET /api/from-file (real session):', ok.status, ok.status === 200 ? JSON.parse(ok.body).precision : '');
} else {
  console.log('GET /api/from-file (real session): skipped (no reconstructed session)');
}

const outside = await get(`/api/from-file?path=${encodeURIComponent('/etc/passwd')}`);
console.log('GET /api/from-file /etc/passwd:', outside.status, '(expect 403)');

const index = await get('/');
console.log('GET /:', index.status, index.body.includes('pi-trace') ? 'html ok' : 'html MISSING');
console.log('GET / (bundle ref):', index.body.includes('/dist/host.js') ? 'bundle ref ok' : 'bundle ref MISSING');

const bundle = await get('/dist/host.js');
console.log('GET /dist/host.js:', bundle.status, bundle.status === 200 ? 'bundle ok' : 'bundle MISSING');

// SSE：收 hello 后退出
const sseRes = await fetch(`${base}/api/events?session=live-session-id`);
const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
const { value } = await reader.read();
const text = decoder.decode(value);
console.log('SSE hello:', text.includes('event: hello') ? 'ok' : 'MISSING', text.includes('"precision":"rich"') ? 'rich ok' : '');
reader.cancel();

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
reader2.cancel();

rmSync(dir, { recursive: true, force: true });
// 清理测试 sidecar（真实 traces 目录里的测试产物）
rmSync(join(TRACES_DIR, 'live-session-id.jsonl'), { force: true });
rmSync(join(TRACES_DIR, 'test-session-id.jsonl'), { force: true });
console.log('SMOKE TEST DONE');
process.exit(0);
