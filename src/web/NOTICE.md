# Vendored Code Attribution

This project vendors source code from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
licensed under the MIT License (see `LICENSE` in each vendored directory).

## `src/web/vendor/`

From `packages/client/ui-trajectory/src/client/` (dsh-client-ui-trajectory, MIT, Copyright (c) 2026 DeepSeek):

- Pure logic: `layout.ts`, `timeline.ts`, `trajectory-record.ts`, `trajectory-preview.ts`,
  `trajectory-search-index.ts`, `trajectory-virtual-rows.ts`, `locales.ts`
- React components: `TrajectoryTable.tsx`, `TrajectoryTimeline.tsx`, `TrajectoryToolbar.tsx`,
  `TrajectoryCell.tsx`, `TrajectoryTurn.tsx`, `TrajectoryTurnHeader.tsx`, `TrajectoryGroupHeader.tsx`
- CSS modules: all `*.module.css`

Modifications: import paths for `@deepseek-ai/dsh-client-ui-primitives` redirected to
`../primitives/`; `TranslateNS` type localized; `declare module` locale augmentation removed.
All `@deepseek-ai/dsh-client-runtime` imports are `import type` (erased at build time).

## `src/web/primitives/`

From `packages/client/ui-primitives/src/` (dsh-client-ui-primitives, MIT, Copyright (c) 2026 DeepSeek):

- `markdown/` — MarkdownText renderer (shiki syntax highlighting + katex math)
- `JsonTree.tsx`, `Menu.tsx`, `Tooltip.tsx`, `pointer-grace.ts`, `clipboard.ts`, `icons.tsx`

Modifications: icon import paths localized; no functional changes.

## Build

`src/web/build.mjs` bundles the vendored code with esbuild into `src/web/dist/`.
A custom CSS Modules plugin scopes class names with `dsh-<file>-` prefixes and injects
styles at runtime. The bundle is self-contained (React, shiki, katex included).
