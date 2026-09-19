/**
 * 端到端冒烟：静态文件 + fixture API（/api/sessions、/api/session/{id}、/api/events SSE）。
 * 用法：node smoke-e2e.mjs
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let port
const now = Date.now()

// fixture TraceSession（含 collector 补全后的新字段）
const session = {
  sessionId: 'fixture-session-001',
  sessionFile: '',
  cwd: '/Users/demo/project',
  startedAt: now - 120_000,
  endedAt: null,
  precision: 'rich',
  records: [
    {
      id: 'r0', kind: 'system', turn: 0, startedAt: now - 120_000, durationMs: null,
      text: 'system prompt · 12 tools · claude-sonnet-4', isError: false,
      model: 'claude-sonnet-4', provider: 'anthropic',
      prompt: 'You are a coding agent running on pi.',
      args: { tools: ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls', 'glob', 'webfetch', 'websearch', 'todowrite', 'task'] },
    },
    {
      id: 'r1', kind: 'user', turn: 0, startedAt: now - 119_000, durationMs: null,
      text: 'what can you do and what do you load for default',
      fullText: 'what can you do and what do you load for default',
      isError: false, source: { kind: 'interactive' },
    },
    {
      id: 'r1b', kind: 'context', turn: 0, startedAt: now - 118_500, durationMs: null,
      text: '\u003csystem-reminder\u003eSkills loaded: lark-markdown, lark-im\u003c/system-reminder\u003e',
      fullText: '\u003csystem-reminder\u003eSkills loaded: lark-markdown, lark-im\u003c/system-reminder\u003e',
      isError: false, source: { kind: 'extension' },
    },
    {
      id: 'r2', kind: 'assistant', turn: 0, startedAt: now - 118_000, durationMs: 8_000,
      text: "What I can do: I'm a coding agent. Here's my core capability set.",
      fullText: "What I can do: I'm a coding agent running on pi. Here's my core capability set:\n\n- File operations (read/write/edit)\n- Shell commands (bash)\n- Web search and fetch\n- Lark/Feishu operations\n\nAlways-available tools: File operations, Shell, Web search.",
      thinking: 'The user is asking about my capabilities and default loaded resources. I should give a concise overview.',
      isError: false, model: 'claude-sonnet-4', provider: 'anthropic',
      usage: { input: 1200, output: 320, cacheRead: 24000, cacheWrite: 0, costTotal: 0.012, reasoning: 80 },
      ttftMs: 2400,
      requestConfig: { provider: 'anthropic', model: 'claude-sonnet-4', thinking: 'medium', temperature: 1 },
      promptSnapshot: {
        system: 'You are a coding agent running on pi.',
        tools: [
          { name: 'bash', description: 'Execute a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
          { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        ],
      },
      toolSchemas: { bash: { type: 'object', properties: { command: { type: 'string' } } } },
      toolCalls: [{ callId: 'call_1', name: 'bash', argsRaw: '{"command":"ls /opt/homebrew/lib/node_modules"}' }],
    },
    {
      id: 'r3', kind: 'tool', turn: 0, startedAt: now - 110_000, durationMs: 300,
      text: 'bash {"command":"ls /opt/homebrew/lib/node_modules"}',
      isError: false, toolName: 'bash', callId: 'call_1',
      args: { command: 'ls /opt/homebrew/lib/node_modules' },
      result: 'config lib LICENSE node_modules package.json README.md',
      exitCode: 0,
    },
    {
      id: 'r4', kind: 'user', turn: 1, startedAt: now - 100_000, durationMs: null,
      text: 'tell me some random thing', fullText: 'tell me some random thing',
      isError: false, source: { kind: 'interactive' },
    },
    {
      id: 'r5', kind: 'assistant', turn: 1, startedAt: now - 99_000, durationMs: 6_500,
      text: 'Honey never spoils. Archaeologists have found 3,000-year-old honey.',
      fullText: "Here's one: honey never spoils. Archaeologists have found 3,000-year-old honey in ancient Egyptian tombs that's still perfectly edible. The low water content and acidity create an environment where bacteria cannot survive.",
      isError: false, model: 'claude-sonnet-4', provider: 'anthropic',
      usage: { input: 800, output: 180, cacheRead: 26000, cacheWrite: 0, costTotal: 0.008, reasoning: 0 },
      ttftMs: 1800,
      requestConfig: { provider: 'anthropic', model: 'claude-sonnet-4', thinking: 'medium' },
      toolCalls: [],
    },
    {
      id: 'r6', kind: 'user', turn: 2, startedAt: now - 80_000, durationMs: null,
      text: 'one more', fullText: 'one more',
      isError: false, source: { kind: 'interactive' },
    },
    {
      id: 'r7', kind: 'assistant', turn: 2, startedAt: now - 79_000, durationMs: 7_200,
      text: 'Octopuses have three hearts and blue blood.',
      fullText: 'Octopuses have three hearts and blue blood. Two hearts pump blood to the gills, and one to the rest of the body. The blood is blue because it uses hemocyanin instead of hemoglobin.',
      isError: false, model: 'claude-sonnet-4', provider: 'anthropic',
      usage: { input: 700, output: 160, cacheRead: 27000, cacheWrite: 0, costTotal: 0.007, reasoning: 0 },
      ttftMs: 2100,
      requestConfig: { provider: 'anthropic', model: 'claude-sonnet-4', thinking: 'medium' },
      toolCalls: [],
    },
  ],
  turns: [
    { turn: 0, startedAt: now - 119_000, endedAt: now - 109_000, records: [] },
    { turn: 1, startedAt: now - 100_000, endedAt: now - 92_000, records: [] },
    { turn: 2, startedAt: now - 80_000, endedAt: now - 71_000, records: [] },
  ],
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = url.pathname

  if (pathname === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([{
      sessionId: session.sessionId, cwd: session.cwd, precision: session.precision, turnCount: 3,
    }]))
    return
  }
  if (pathname.startsWith('/api/session/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(session))
    return
  }
  if (pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(`event: hello\ndata: ${JSON.stringify({ session })}\n\n`)
    return
  }
  // 静态
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const file = resolve(here, rel)
  if (!file.startsWith(here) || !existsSync(file)) {
    res.writeHead(404)
    res.end('not found: ' + rel)
    return
  }
  const ext = file.slice(file.lastIndexOf('.'))
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
port = server.address().port
console.log(`e2e server on http://127.0.0.1:${port}`)

let browser
try {
browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
})
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

await page.goto(`http://127.0.0.1:${port}/?session=${session.sessionId}`, { waitUntil: 'networkidle' })
await page.locator('.stats').waitFor()
assert.match(await page.locator('.stats').innerText(), /42\.9 tok\/s/)

mkdirSync(join(here, 'shots'), { recursive: true })
await page.screenshot({ path: join(here, 'shots/e2e.png'), fullPage: false })

// 结构检查
const checks = await page.evaluate(() => ({
  turnHeaders: document.querySelectorAll('[class*="turnHeader"], [class*="TurnHeader"]').length,
  kindTags: document.querySelectorAll('[class*="kindTag"]').length,
  timelineSpans: document.querySelectorAll('[data-timeline-record-index]').length,
  toolbar: document.querySelectorAll('[class*="toolbar"], [role="toolbar"]').length,
  rows: document.querySelectorAll('[class*="event"]').length,
}))

// 交互检查：点击行 → 详情面板打开
const detailChecks = {}
// assistant 行
await page.locator('tr').filter({ has: page.locator('.dsh-TrajectoryTable-assistantVioletBright') }).first().click()
await page.waitForTimeout(400)
detailChecks.assistantTabs = await page.getByRole('tab').allTextContents()
const throughputText = () => page.locator('dt').filter({ hasText: /^Throughput$/ }).locator('..').locator('dd').innerText()
assert.equal(await throughputText(), '57.1 tok/s')
await page.screenshot({ path: join(here, 'shots/detail-assistant.png') })
// tool 行
await page.locator('tr').filter({ has: page.locator('.dsh-TrajectoryTable-toolAmber') }).first().click()
await page.waitForTimeout(400)
detailChecks.toolTabs = await page.getByRole('tab').allTextContents()
await page.screenshot({ path: join(here, 'shots/detail-tool.png') })
// system 行
await page.locator('tr').filter({ has: page.locator('.dsh-TrajectoryTable-systemNeutral') }).first().click()
await page.waitForTimeout(400)
detailChecks.systemTabs = await page.getByRole('tab').allTextContents()
await page.screenshot({ path: join(here, 'shots/detail-system.png') })

// Regressions in the actual bundle: tool usage + untimed output + 1ms decode span.
session.records.find(r => r.id === 'r2').ttftMs = 7999
session.records.find(r => r.id === 'r3').usage = {
  input: 0, output: 500_000, cacheRead: 0, cacheWrite: 0, costTotal: 0,
}
session.records.push({
  id: 'untimed', kind: 'assistant', turn: 3, startedAt: now, durationMs: null,
  completed: true, text: 'Finished, timing unavailable', isError: false,
  usage: { input: 0, output: 300_000, cacheRead: 0, cacheWrite: 0, costTotal: 0 },
})
await page.reload({ waitUntil: 'networkidle' })
await page.locator('.stats').waitFor()
assert.match(await page.locator('.stats').innerText(), /34\.7 tok\/s/)
await page.locator('tr').filter({ has: page.locator('.dsh-TrajectoryTable-assistantVioletBright') }).first().click()
assert.equal(await throughputText(), 'Insufficient timing or usage')
console.log('TPS regression checks: aggregate and per-request panel OK')

console.log('checks:', JSON.stringify(checks))
console.log('detail tabs:', JSON.stringify(detailChecks))
if (errors.length > 0) {
  console.log('ERRORS:')
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`)
}
assert.deepEqual(errors, [])
assert.ok(checks.timelineSpans > 0)
assert.ok(checks.rows > 0)
console.log('e2e OK')
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
