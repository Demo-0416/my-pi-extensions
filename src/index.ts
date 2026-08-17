/**
 * pi-trace 扩展入口（DESIGN.md 第 3 节）。
 *
 * 职责：
 * - pi 事件 → Collector 接线（3.3 事件映射表）
 * - HTTP/SSE server 惰性启动（3.8）
 * - TUI widget 统计行（3.10，turn_end / tool_execution_end 刷新）
 * - /trace 命令：打开当前会话网页；/trace pick：选历史会话
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Collector } from './collector.ts';
import { emptySession, type TraceSession } from './model.ts';
import { listSessions, loadSession } from './session-loader.ts';
import { extensionSrcDir } from './store.ts';
import { computeStats, formatElapsed } from './stats.ts';
import { join } from 'node:path';
import { TraceServer } from './server.ts';

let server: TraceServer | null = null;
let collector: Collector | null = null;
let currentSessionId: string | null = null;
let widgetEnabled = true;

async function ensureServer(): Promise<TraceServer | null> {
  if (server === null) {
    server = new TraceServer(join(extensionSrcDir(), 'web'));
    try {
      await server.start();
    } catch (error) {
      // 端口全被占用时降级：采集照常，Web 不可用。
      console.error(`[pi-trace] server failed to start: ${String(error)}`);
      return null;
    }
  }
  return server;
}

/** 刷新 TUI widget 统计行（DESIGN.md 3.10）。无数据时不显示，避免空态噪音。 */
function refreshWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  if (!widgetEnabled || collector === null || collector.session.records.length === 0) {
    ctx.ui.setWidget('pi-trace', undefined);
    return;
  }
  const stats = computeStats(collector.session);
  ctx.ui.setWidget(
    'pi-trace',
    (_tui, theme) => new Text(
      [
        theme.fg('accent', '✻'),
        theme.fg('muted', `${stats.turns} 轮`),
        `LLM ${formatElapsed(stats.llmMs)}`,
        stats.toolMs > 0 ? `工具 ${formatElapsed(stats.toolMs)}` : null,
        stats.tokPerSec !== null ? `${stats.tokPerSec.toFixed(1)} tok/s` : null,
        stats.cacheHitRate !== null ? `缓存 ${(stats.cacheHitRate * 100).toFixed(0)}%` : null,
        stats.costTotal > 0 ? `$${stats.costTotal.toFixed(2)}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(theme.fg('dim', ' · ')),
    ),
    { placement: 'belowEditor' },
  );
}

/** 打开浏览器（macOS 用 open，Linux 用 xdg-open）。 */
async function openInBrowser(pi: ExtensionAPI, url: string): Promise<void> {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : 'start';
  try {
    await pi.exec(opener, [url]);
  } catch (error) {
    console.error(`[pi-trace] failed to open browser: ${String(error)}`);
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile() ?? '';
    currentSessionId = sessionId;
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
    const started = await ensureServer();
    if (started !== null) started.register(collector);
    refreshWidget(ctx);
  });

  pi.on('before_agent_start', (event, ctx) => {
    // system prompt + 工具目录快照（对齐 dsh SYSTEM 记录）。
    collector?.onBeforeAgentStart({
      systemPrompt: event.systemPrompt,
      toolSnippets: event.systemPromptOptions?.toolSnippets,
      selectedTools: event.systemPromptOptions?.selectedTools,
      customPrompt: event.systemPromptOptions?.customPrompt,
      model: ctx.model?.id,
      provider: ctx.model?.provider,
      cwd: ctx.cwd,
      thinkingLevel: ctx.thinkingLevel,
    });
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

  pi.on('tool_execution_end', (event, ctx) => {
    collector?.onToolExecutionEnd(event.toolCallId, event.result, event.isError);
    refreshWidget(ctx);
  });

  pi.on('turn_end', (event, ctx) => {
    collector?.onTurnEnd(event.turnIndex);
    refreshWidget(ctx);
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

  pi.on('session_shutdown', async (_event, ctx) => {
    // 记录逐条落盘，这里无需额外 flush；server 随进程退出，不单独关。
    if (ctx.hasUI) ctx.ui.setWidget('pi-trace', undefined);
    collector = null;
    currentSessionId = null;
  });

  // --- 命令（DESIGN.md 3.10） ---

  pi.registerCommand('trace', {
    description: 'Open pi-trace in browser',
    getArgumentCompletions: (prefix: string) => {
      if ('pick'.startsWith(prefix)) {
        return [{ value: 'pick', label: 'pick', description: 'Pick a historical session' }];
      }
      return null;
    },
    handler: async (args, ctx) => {
      const port = server?.getPort() ?? 0;
      if (port === 0) {
        ctx.ui.notify('pi-trace server not running', 'error');
        return;
      }
      let sessionId = currentSessionId;
      if (args.trim() === 'pick') {
        const liveIds = new Set(server?.liveSessionIds() ?? []);
        const sessions = listSessions(liveIds);
        if (sessions.length === 0) {
          ctx.ui.notify('no sessions found', 'warning');
          return;
        }
        // 选项编码：`<sessionId>\t<label>`，tab 不会出现在 id 里。
        const options = sessions.map((s) => {
          const date = new Date(s.startedAt).toLocaleString('en-GB', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
          });
          return `${s.sessionId}\t${s.cwd || '?'} · ${date} · ${s.turnCount} 轮 · ${s.precision}`;
        });
        const choice = await ctx.ui.select('Open trace for session:', options);
        if (!choice) return;
        sessionId = choice.split('\t')[0] ?? null;
      }
      if (!sessionId) {
        ctx.ui.notify('no active session', 'warning');
        return;
      }
      const url = `http://127.0.0.1:${port}/?session=${encodeURIComponent(sessionId)}`;
      await openInBrowser(pi, url);
      ctx.ui.notify(`pi-trace: ${url}`, 'info');
    },
  });

  pi.registerCommand('trace-widget', {
    description: 'Toggle pi-trace TUI widget',
    handler: async (_args, ctx) => {
      widgetEnabled = !widgetEnabled;
      if (!widgetEnabled) {
        ctx.ui.setWidget('pi-trace', undefined);
        ctx.ui.notify('pi-trace widget hidden', 'info');
      } else {
        refreshWidget(ctx);
        ctx.ui.notify('pi-trace widget shown', 'info');
      }
    },
  });
}
