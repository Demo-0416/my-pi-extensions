/**
 * pi-trace 扩展入口（DESIGN.md 第 3 节）。
 *
 * 采集与展示分离：本文件只做 pi 事件 → Collector 的接线，
 * 以及 HTTP/SSE server 的惰性启动。TUI widget 与 /trace 命令见 M10。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Collector } from './collector.ts';
import { emptySession, type TraceSession } from './model.ts';
import { loadSession } from './session-loader.ts';
import { extensionSrcDir } from './store.ts';
import { join } from 'node:path';
import { TraceServer } from './server.ts';

let server: TraceServer | null = null;
let collector: Collector | null = null;

function ensureServer(): TraceServer {
  if (server === null) {
    server = new TraceServer(join(extensionSrcDir(), 'web'));
    try {
      server.start();
    } catch (error) {
      // 端口全被占用时降级：采集照常，Web 不可用。
      console.error(`[pi-trace] server failed to start: ${String(error)}`);
    }
  }
  return server;
}

export default function (pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile() ?? '';
    let session: TraceSession | null = null;
    try {
      // sidecar 存在 = rich；否则从 session JSONL 重建（reconstructed）并落 sidecar。
      session = loadSession(sessionId, sessionFile || undefined);
    } catch (error) {
      console.error(`[pi-trace] failed to load session ${sessionId}: ${String(error)}`);
    }
    if (session === null) {
      session = emptySession(sessionId, sessionFile, ctx.cwd, Date.now());
    }
    collector = new Collector(session);
    collector.regroup();
    const started = ensureServer();
    if (started.getPort() > 0) started.register(collector);
  });

  pi.on('turn_start', (event, _ctx) => {
    collector?.onTurnStart(event.turnIndex, event.timestamp);
  });

  pi.on('before_provider_request', (event, ctx) => {
    collector?.onBeforeProviderRequest(
      event.payload,
      ctx.model?.id,
      ctx.model?.provider,
    );
  });

  pi.on('message_update', (_event, _ctx) => {
    collector?.onMessageUpdate();
  });

  pi.on('message_end', (event, _ctx) => {
    collector?.onMessageEnd(event.message as Parameters<Collector['onMessageEnd']>[0]);
  });

  pi.on('tool_execution_start', (event, _ctx) => {
    collector?.onToolExecutionStart(event.toolCallId, event.toolName, event.args);
  });

  pi.on('tool_result', (event, _ctx) => {
    collector?.onToolResult(event.toolCallId, event.content, event.details, event.isError);
  });

  pi.on('tool_execution_end', (event, _ctx) => {
    collector?.onToolExecutionEnd(event.toolCallId, event.result, event.isError);
  });

  pi.on('turn_end', (event, _ctx) => {
    collector?.onTurnEnd(event.turnIndex);
  });

  pi.on('session_compact', (event, _ctx) => {
    collector?.onSessionCompact(
      event.compactionEntry?.summary ?? '',
      event.compactionEntry?.tokensBefore,
    );
  });

  pi.on('model_select', (event, _ctx) => {
    collector?.onModelChange(event.model.provider, event.model.id);
  });

  pi.on('session_shutdown', async (_event, _ctx) => {
    // 记录逐条落盘，这里无需额外 flush；server 随进程退出，不单独关。
    collector = null;
  });
}
