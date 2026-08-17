/**
 * HTTP + SSE server（DESIGN.md 3.8）。
 *
 * 路由：
 *   GET /                        前端文件（从扩展 src/web 目录 serve）
 *   GET /api/sessions            会话列表（含 cwd/时间/turn 数/精度）
 *   GET /api/session/{id}        全量 TraceSession
 *   GET /api/events?session={id} SSE：hello（全量快照）→ record/turn/stats 增量
 *   GET /api/from-file?path=...  任意 session 文件即时重建（路径限制在 sessions 目录内）
 *
 * 安全边界（3.11）：只绑 127.0.0.1；/api/from-file 的 path 必须 resolve 后位于
 * ~/.pi/agent/sessions/ 内，否则 403。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TraceSession } from './model.ts';
import { SESSIONS_DIR, portFilePath, ensureTracesDir } from './store.ts';
import { listSessions, loadSession, reconstructFromPath } from './session-loader.ts';
import { computeStats } from './stats.ts';
import type { Collector, LiveEvent } from './collector.ts';

const DEFAULT_PORT = 43110;
const PORT_ATTEMPTS = 10;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

interface SseClient {
  response: ServerResponse;
  sessionId: string;
}

export class TraceServer {
  private server: Server | null = null;
  private port = 0;
  private readonly collectors = new Map<string, Collector>();
  private readonly sseClients = new Set<SseClient>();
  private readonly webDir: string;

  constructor(webDir?: string) {
    this.webDir = webDir ?? join(dirname(fileURLToPath(import.meta.url)), 'web');
  }

  /**
   * 惰性启动：默认 43110，占用则向后试 10 个；实际端口写 ~/.pi/agent/traces/.port。
   * listen 的 EADDRINUSE 是异步 'error' 事件，用 Promise 包 'listening'/'error'。
   */
  async start(): Promise<number> {
    if (this.server !== null) return this.port;
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
      const port = DEFAULT_PORT + attempt;
      const server = createServer((req, res) => {
        this.handle(req, res).catch((error: unknown) => {
          sendJson(res, 500, { error: String(error) });
        });
      });
      const bound = await new Promise<boolean>((resolve) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          resolve(err.code === 'EADDRINUSE' ? false : false);
        });
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (!bound) {
        server.close();
        continue;
      }
      this.server = server;
      this.port = port;
      // unref：server 不阻止进程退出（print 模式答完即走；TUI 模式由 TUI 保活）。
      server.unref();
      ensureTracesDir();
      writeFileSync(portFilePath(), `${port}\n`, { mode: 0o600 });
      return port;
    }
    throw new Error(`pi-trace: no free port in ${DEFAULT_PORT}..${DEFAULT_PORT + PORT_ATTEMPTS - 1}`);
  }

  getPort(): number {
    return this.port;
  }

  /** 当前进程内活跃采集的会话 id（/trace pick 列表标记 live 用）。 */
  liveSessionIds(): string[] {
    return [...this.collectors.keys()];
  }

  /** 注册活跃采集会话（/api/session 与 SSE 优先用内存态）。 */
  register(collector: Collector): void {
    this.collectors.set(collector.session.sessionId, collector);
    collector.subscribe((event) => this.broadcast(collector.session.sessionId, event));
  }

  private broadcast(sessionId: string, event: LiveEvent): void {
    for (const client of this.sseClients) {
      if (client.sessionId !== sessionId) continue;
      sendSse(client.response, event.type, event);
    }
  }

  // --- 路由 ---------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    if (pathname === '/api/sessions') {
      sendJson(res, 200, listSessions(new Set(this.collectors.keys())));
      return;
    }

    if (pathname.startsWith('/api/session/')) {
      const id = decodeURIComponent(pathname.slice('/api/session/'.length));
      const session = this.resolveSession(id);
      if (session === null) {
        sendJson(res, 404, { error: 'session not found' });
        return;
      }
      sendJson(res, 200, session);
      return;
    }

    if (pathname === '/api/events') {
      const id = url.searchParams.get('session');
      if (!id) {
        sendJson(res, 400, { error: 'missing session param' });
        return;
      }
      this.handleSse(id, res);
      return;
    }

    if (pathname === '/api/from-file') {
      const path = url.searchParams.get('path');
      if (!path) {
        sendJson(res, 400, { error: 'missing path param' });
        return;
      }
      // 安全边界（3.11）：resolve 后必须位于 sessions 目录内。
      const resolved = resolve(path);
      const sessionsRoot = resolve(SESSIONS_DIR);
      if (!isInside(resolved, sessionsRoot)) {
        sendJson(res, 403, { error: 'path outside sessions directory' });
        return;
      }
      const session = reconstructFromPath(resolved);
      if (session === null) {
        sendJson(res, 404, { error: 'session file not found or invalid' });
        return;
      }
      sendJson(res, 200, session);
      return;
    }

    // 静态资源
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (relative.includes('..')) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    const filePath = join(this.webDir, relative);
    if (!isInside(filePath, this.webDir) || !existsSync(filePath)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(readFileSync(filePath));
  }

  private resolveSession(id: string): TraceSession | null {
    const collector = this.collectors.get(id);
    if (collector !== undefined) return collector.session;
    return loadSession(id);
  }

  private handleSse(sessionId: string, res: ServerResponse): void {
    const session = this.resolveSession(sessionId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    if (session !== null) {
      sendSse(res, 'hello', { session, stats: computeStats(session) });
    } else {
      sendSse(res, 'hello', { session: null, stats: null });
    }
    const client: SseClient = { response: res, sessionId };
    this.sseClients.add(client);
    // 心跳，防代理断连。unref 同 server：不阻止进程退出。
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 30_000);
    heartbeat.unref?.();
    res.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(client);
    });
  }
}

function dirname(path: string): string {
  return fileURLToPath(new URL('.', path));
}

function isInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
