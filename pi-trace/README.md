# pi-trace

Pi extension that renders a [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)-style trajectory view for every pi session — timeline gantt chart, turn-grouped ledger, rich detail panel, live SSE streaming.

## Install

```bash
pi install npm:@demo-0416/pi-trace
```

Or try without installing:

```bash
pi -e npm:@demo-0416/pi-trace
```

## Usage

Once installed, the extension auto-activates on every pi session:

- **TUI widget** — a stats line appears below the editor: `✻ 3 轮 · LLM 21.7s · 42.9 tok/s · 缓存 96.6% · $0.03`
- **`/trace`** — open the current session's trajectory in the browser
- **`/trace pick`** — pick a historical session from a list

The web UI runs on `http://127.0.0.1:<port>` (port auto-increments from 43110; written to `~/.pi/agent/traces/.port`).

## Features

### Timeline (Gantt)

- 3 lanes: Input / Model / Tools, with 4 projection modes (sequence, duration, time, actual)
- Scroll to zoom (cursor-anchored), right-drag to pan, drag-select to focus
- TTFT gradient ticks on model spans, turn boundary markers
- Hover crosshair + tooltip, click to focus record

### Ledger (Table)

- Turn → group (Message / Step N) → cell hierarchy
- Colored kind tags (USER / ASSISTANT / TOOL / SYSTEM)
- Inline tool result previews, LLM request boundaries with cumulative usage
- Turn + assistant folding, live full-text search

### Detail Panel

- **User / Assistant**: Summary / Preview / Raw / Source tabs — markdown rendering with syntax highlighting, token breakdown, TTFT/generation/throughput timing
- **Tool**: Summary / Payload / Result / Schema / Timing tabs — JSON tree, tool schema from request
- **System**: System Prompt / Tools tabs — full prompt snapshot, tool catalog

### Data

- Rich collection: thinking blocks, tool calls, request config (temperature/thinking/stop), prompt snapshots, tool schemas, call IDs, input source, reasoning tokens
- Read-only session data: live timing stays in memory; only the server port is written to `~/.pi/agent/traces/.port`
- Historical session reconstruction from pi's own session JSONL
- SSE live streaming (partial assistant messages + running tool calls)

## Architecture

```
src/
├── index.ts           # extension entry (activate, widget, /trace commands)
├── collector.ts       # pi event stream → TraceRecord
├── server.ts          # node:http + SSE, serves web UI
├── store.ts           # paths and field truncation
├── model.ts           # TraceSession / TraceRecord types
├── stats.ts           # stats computation
├── session-loader.ts  # historical session reconstruction
└── web/
    ├── dist/          # pre-built React bundle (self-contained)
    ├── vendor/        # dsh ui-trajectory source (MIT, vendored)
    ├── primitives/    # dsh ui-primitives subset (MIT, vendored)
    ├── adapter.ts     # pi session JSON → dsh layout input
    ├── host.tsx       # React app: state, SSE, session picker
    ├── build.mjs      # esbuild + CSS modules plugin
    └── theme.css      # dsh design tokens (light theme)
```

The frontend vendors deepseek-harness's `ui-trajectory` package (MIT) — the same layout engine, timeline, table, and detail panel components, adapted to pi's data model via a thin adapter layer. The backend is pure TypeScript with zero runtime dependencies (pi bundles `@earendil-works/pi-tui`).

## Development

```bash
# Backend smoke test (collector, store, server, stats)
npm test

# Frontend e2e test (install Chromium once)
(cd src/web && npm ci && npx playwright install chromium)
npm run test:e2e

# Rebuild frontend after modifying vendor/ or host.tsx
npm run build:web
```

## Release

`master` is the release source of truth. Bump `pi-trace/package.json`, update
[CHANGELOG.md](CHANGELOG.md), rebuild the browser bundle, and merge the tested PR
before publishing `@demo-0416/pi-trace`. Do not publish from an unmerged branch.
`npm publish` rebuilds and runs the isolated regression/smoke tests. Run the browser
e2e tests separately before release. For a custom Chromium installation, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

## License

MIT. See [LICENSE](LICENSE). Vendored dsh code retains its original MIT license — see [src/web/NOTICE.md](src/web/NOTICE.md).
