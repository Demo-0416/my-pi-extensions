/** Deterministic TPS regressions. No network, sleeps, or access to user sessions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeStats, outputTokensPerSecond, widgetLineParts } from '../src/stats.ts';
import { reconstructFromSessionFile } from '../src/session-loader.ts';
import { emptySession, groupRecordsByTurn } from '../src/model.ts';
import { Collector } from '../src/collector.ts';
import { adaptSession } from '../src/web/adapter.ts';

const T0 = Date.parse('2025-01-01T00:00:00.000Z');
const iso = ms => new Date(T0 + ms).toISOString();
const usage = output => ({ input: 10, output, cacheRead: 20, cacheWrite: 0, costTotal: 0.01 });
const messageUsage = output => ({ ...usage(output), cost: { total: 0.01 } });
const record = overrides => ({
  id: 'r', kind: 'assistant', turn: 0, startedAt: T0, durationMs: 2000,
  text: '', isError: false, ttftMs: null, usage: usage(100), ...overrides,
});
function session(records) {
  return { ...emptySession('test', '', '/tmp', T0), records, turns: groupRecordsByTurn(records) };
}
function reconstruct(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-trace-stats-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'test', timestamp: iso(0), cwd: '/tmp' },
    ...entries,
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const result = reconstructFromSessionFile(path);
  assert.ok(result);
  return result;
}
function assistant(start, end, output, extra = {}) {
  return {
    type: 'message', timestamp: iso(end),
    message: { role: 'assistant', timestamp: T0 + start, content: [], stopReason: 'stop', usage: messageUsage(output), ...extra },
  };
}
function toolResult(end, id, extra = {}) {
  return {
    type: 'message', timestamp: iso(end),
    message: { role: 'toolResult', timestamp: T0 + end, toolCallId: id, toolName: 'bash', content: [], ...extra },
  };
}
const call = id => ({ type: 'toolCall', id, name: 'bash', arguments: {} });

test('bash content and nested usage do not enter the model TPS numerator', () => {
  const stats = computeStats(session([
    record({}),
    record({ kind: 'tool', startedAt: T0 + 2000, durationMs: 100_000,
      result: 'bash output '.repeat(50_000), usage: usage(500_000) }),
    record({ kind: 'user', usage: usage(1_000_000) }),
  ]));
  assert.equal(stats.tokPerSec, 50);
  assert.equal(stats.tokPerSecSamples, 1);
  assert.equal(stats.nestedOutputTokens, 500_000);
  assert.equal(stats.outputTokens, 500_100);
});

test('tokens without a valid duration are excluded together with their time', () => {
  const bad = [null, 0, 1, 49, -1, NaN, Infinity];
  const stats = computeStats(session([
    record({}), ...bad.map(durationMs => record({ durationMs, usage: usage(263_437) })),
  ]));
  assert.equal(stats.tokPerSec, 50);
  assert.equal(stats.tokPerSecSamples, 1);
  assert.equal(computeStats(session([record({ durationMs: null })])).tokPerSec, null);
});

test('missing or invalid output and failed responses are not rate samples', () => {
  const stats = computeStats(session([
    record({}),
    record({ usage: undefined, durationMs: 20_000 }),
    ...[0, -10, NaN, Infinity].map(output => record({ usage: usage(output), durationMs: 20_000 })),
    record({ isError: true, durationMs: 20_000, usage: usage(50_000) }),
  ]));
  assert.equal(stats.tokPerSec, 50);
  assert.equal(stats.tokPerSecSamples, 1);
  assert.ok(Number.isFinite(stats.outputTokens));
});

test('TTFT is subtracted only when valid; rates are weighted by generation time', () => {
  const stats = computeStats(session([
    record({ durationMs: 5000, ttftMs: 1000, usage: usage(200) }),
    record({ durationMs: 1500, ttftMs: 500, usage: usage(100) }),
    ...[-1, NaN, Infinity, 6000].map(ttftMs => record({ durationMs: 5000, ttftMs, usage: usage(500_000) })),
  ]));
  assert.equal(stats.tokPerSec, 60); // (200 + 100) / (4 + 1)
  assert.equal(stats.tokPerSecSamples, 2);
  assert.equal(stats.avgTtftMs, 750);
  assert.equal(computeStats(session([record({ durationMs: 5000, ttftMs: 5000 })])).tokPerSec, null);
});

test('reasoning tokens that never streamed as deltas fall back to full duration (no TTFT subtraction)', () => {
  // 网关不把推理过程作为流式增量下发（thinking 正文为空、只有签名）时，
  // ttft 标记的是推理结束后第一个可见 token，decode 窗口不含推理时间，
  // 但 usage.output 含推理 token —— 扣 ttft 会虚高（5000/1s = 5000 tok/s），
  // 必须退回整段时长（5000/40s = 125 tok/s 端到端，与 reconstructed 口径一致）。
  const buffered = computeStats(session([
    record({ durationMs: 40_000, ttftMs: 39_000, usage: { ...usage(5000), reasoning: 4500 } }),
  ]));
  assert.equal(buffered.tokPerSec, 125);
  assert.equal(buffered.tokPerSecSamples, 1);
  // 推理随流下发的网关（thinking 正文非空）不受影响：正常扣 ttft 得纯解码速率。
  const streamed = computeStats(session([
    record({ durationMs: 40_000, ttftMs: 39_000, thinking: '推理正文', usage: { ...usage(5000), reasoning: 4500 } }),
  ]));
  assert.equal(streamed.tokPerSec, 5000);
  // 无 reasoning 的普通记录同样不受影响。
  const plain = computeStats(session([
    record({ durationMs: 40_000, ttftMs: 39_000, usage: usage(5000) }),
  ]));
  assert.equal(plain.tokPerSec, 5000);
});

test('reasoning reported separately (output ≤ reasoning) is added back to the numerator', () => {
  // gemini-3.8-flash-high 实测：微型工具调用请求 output=27、reasoning=73（分开上报），
  // 请求全长数秒静默窗口（服务端推理不随流下发）。分子只算 output 会压到个位数，
  // 必须归一成 generated = output + reasoning。
  const geminiMicro = computeStats(session([
    record({ durationMs: 4300, ttftMs: 4200, usage: { ...usage(27), reasoning: 73 } }),
  ]));
  assert.equal(geminiMicro.tokPerSec, 100 / 4.3); // (27+73) / 4.3s（unstreamed 用全长）
  // es1 型（output 已含 reasoning，output > reasoning）：绝不能加，双重计会虚高。
  const es1 = computeStats(session([
    record({ durationMs: 40_000, ttftMs: 39_000, usage: { ...usage(1279), reasoning: 644 } }),
  ]));
  assert.equal(es1.tokPerSec, 1279 / 40);
  // 推理随流下发（thinking 非空）且 output > reasoning：分子仍按 output（保守），
  // 分母正常扣 ttft。
  const streamed = computeStats(session([
    record({ durationMs: 8000, ttftMs: 500, thinking: '推理正文', usage: { ...usage(935), reasoning: 801 } }),
  ]));
  assert.equal(streamed.tokPerSec, 935 / 7.5);
  // output=0 的记录即使有 reasoning 也不是速率样本（没有可见输出）。
  const noOutput = computeStats(session([
    record({ durationMs: 5000, ttftMs: 100, usage: { ...usage(0), reasoning: 300 } }),
  ]));
  assert.equal(noOutput.tokPerSec, null);
  assert.equal(noOutput.tokPerSecSamples, 0);
});

test('the shared per-request guard rejects invalid and sub-50ms samples without capping valid rates', () => {
  for (const duration of [null, 0, 1, 49, -1, NaN, Infinity]) {
    assert.equal(outputTokensPerSecond(200, duration), null);
  }
  assert.equal(outputTokensPerSecond(5, 50), 100);
  assert.equal(outputTokensPerSecond(2000, 1000), 2000);
  assert.equal(outputTokensPerSecond(Infinity, 1000), null);
  assert.equal(outputTokensPerSecond(0, 1000), null);
});

test('tool wall-clock time is the union of finite spans', () => {
  for (const [spans, expected] of [
    [[], 0], [[[0, 100]], 100], [[[0, 100], [0, 100]], 100],
    [[[200, 50], [0, 100]], 150], [[[0, 100], [10, 10]], 100],
    [[[0, 50], [25, 50]], 75], [[[0, 100], [100, 100]], 200],
  ]) {
    const records = spans.map(([start, durationMs]) => record({ kind: 'tool', startedAt: T0 + start, durationMs }));
    records.push(record({ kind: 'tool', startedAt: NaN, durationMs: 1000 }));
    records.push(record({ kind: 'tool', durationMs: Infinity }));
    assert.equal(computeStats(session(records)).toolMs, expected);
  }
});

test('history includes the final long response, excluding tool runtime and later user idle time', t => {
  const s = reconstruct(t, [
    assistant(0, 2000, 200, { content: [call('c1')], stopReason: 'toolUse' }),
    toolResult(60_000, 'c1', { content: [{ type: 'text', text: 'output '.repeat(10_000) }], usage: messageUsage(500_000) }),
    assistant(60_000, 3_060_000, 300_000), // last message: 3000 seconds, not null
  ]);
  const assistants = s.records.filter(r => r.kind === 'assistant');
  assert.deepEqual(assistants.map(r => r.durationMs), [2000, 3_000_000]);
  assert.equal(computeStats(s).tokPerSec, 100);
  assert.equal(computeStats(s).tokPerSecSamples, 2);
  assert.equal(computeStats(s).nestedOutputTokens, 500_000);
  assert.equal(adaptSession(s).partial, null);

  const idle = reconstruct(t, [
    assistant(0, 2000, 200),
    { type: 'message', timestamp: iso(600_000), message: { role: 'user', timestamp: T0 + 600_000, content: 'next' } },
  ]);
  assert.equal(computeStats(idle).llmMs, 2000);
  assert.equal(computeStats(idle).tokPerSec, 100);
});

test('missing, reversed, or zero historical timing never borrows a following gap', t => {
  const missingEnd = assistant(3000, 4000, 100_000);
  delete missingEnd.timestamp;
  const missingStart = assistant(5000, 6000, 100_000);
  delete missingStart.message.timestamp;
  const s = reconstruct(t, [
    assistant(0, 2000, 100), missingEnd, missingStart,
    assistant(10_000, 9000, 100_000), assistant(11_000, 11_000, 100_000),
    { type: 'message', timestamp: iso(600_000), message: { role: 'user', timestamp: T0 + 600_000, content: 'later' } },
  ]);
  assert.deepEqual(s.records.filter(r => r.kind === 'assistant').map(r => r.durationMs), [2000, null, null, null, 0]);
  assert.equal(computeStats(s).tokPerSec, 50);
  const adapted = adaptSession(s);
  assert.equal(adapted.partial, null);
  assert.ok(adapted.requests.every(r => r.status === 'complete'));
  assert.equal(adapted.nodes.filter(n => n.kind === 'assistant')[1].timing.stepStartTime, null);
});

test('historical tool windows match call IDs, not an unrelated assistant', t => {
  const s = reconstruct(t, [
    assistant(0, 2000, 100, { content: [call('c1'), call('c2')], stopReason: 'toolUse' }),
    assistant(2100, 2200, 10),
    toolResult(2500, 'c1'), toolResult(3000, 'c2'), toolResult(3500, 'orphan'),
    { type: 'message', timestamp: iso(600_000), message: { role: 'user', timestamp: T0 + 600_000, content: 'later' } },
  ]);
  const tools = s.records.filter(r => r.kind === 'tool');
  assert.deepEqual(tools.map(r => r.durationMs), [500, 1000, null]);
  assert.deepEqual(tools.map(r => r.turn), [0, 0, null]);
  assert.equal(computeStats(s).toolMs, 1000);
  assert.equal(adaptSession(s).runningCalls.length, 0);
});

test('aborted historical requests keep totals but not TPS', t => {
  const s = reconstruct(t, [assistant(0, 2000, 100, { stopReason: 'aborted' })]);
  assert.equal(s.records[0].isError, true);
  assert.equal(computeStats(s).tokPerSec, null);
  assert.equal(computeStats(s).outputTokens, 100);
});

test('live collection counts only content deltas and isolates tool usage', t => {
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const s = emptySession('live', '', '/tmp', T0);
  const collector = new Collector(s);
  collector.onTurnStart(0, now);
  collector.onBeforeProviderRequest({ model: 'test' });
  assert.ok(adaptSession(s).partial);
  now += 100;
  collector.onMessageUpdate({ type: 'start' });
  collector.onMessageUpdate({ type: 'text_start' });
  collector.onMessageUpdate({ type: 'text_delta', delta: '' });
  now = T0 + 1000;
  collector.onMessageUpdate({ type: 'thinking_delta', delta: 'thinking' });
  now = T0 + 2000;
  collector.onMessageUpdate({ type: 'toolcall_delta', delta: '{' });
  now = T0 + 3000;
  collector.onMessageEnd({ role: 'assistant', stopReason: 'toolUse', usage: messageUsage(100), content: [call('live-call')] });
  assert.equal(s.records[0].ttftMs, 1000);
  assert.equal(computeStats(s).tokPerSec, 50);
  collector.onToolExecutionStart('live-call', 'bash', {});
  now += 500;
  collector.onToolResult('live-call', [{ type: 'text', text: 'output '.repeat(10_000) }], {}, false, messageUsage(500_000));
  collector.onToolExecutionEnd('live-call', {}, false);
  collector.onMessageEnd({ role: 'toolResult', toolCallId: 'live-call', usage: messageUsage(600_000) });
  assert.equal(computeStats(s).nestedOutputTokens, 600_000);
  assert.equal(computeStats(s).tokPerSec, 50);
  assert.equal(s.records.length, 2);
  assert.equal(adaptSession(s).partial, null);
  assert.equal(adaptSession(s).runningCalls.length, 0);
});

test('TUI hides unavailable rates and shares the browser-compatible statistics input', () => {
  const s = session([record({ durationMs: null })]);
  assert.ok(!widgetLineParts(computeStats(s)).some(p => p.includes('tok/s')));
  const { turns, ...browserPayload } = session([record({ turn: 4 })]);
  assert.deepEqual(computeStats(browserPayload), computeStats({ ...browserPayload, turns }));
});
