# better-claude-code-ui

Claude Code visual identity for [pi](https://pi.dev): themes, welcome banner, status line, spinner, turn footer, and CC-style tool rendering — faithfully aligned against the Claude Code source, line by line.

## Install

```bash
pi install npm:better-claude-code-ui
```

Try it without installing:

```bash
pi -e npm:better-claude-code-ui
```

### Recommended setting

This extension draws its own welcome banner, so pi's built-in startup header
becomes redundant. Hide it in `~/.pi/agent/settings.json`:

```json
{ "quietStartup": true }
```

The full two-column banner (extensions + skills) appears the first time you
open a given project, matching CC's `showOnboarding` behavior; later starts in
that project use the condensed logo.

## What you get

**6 themes** (`/themes` to switch, or use `/cc-theme` for a CC-only picker):

- `claude-code-dark` / `claude-code-light` — truecolor, matched key-by-key to CC's palette
- `claude-code-dark-ansi` / `claude-code-light-ansi` — ANSI-16 for terminals without truecolor
- `claude-code-dark-daltonized` / `claude-code-light-daltonized` — color-blind friendly variants

**UI modules**:

- **Welcome banner** — CC's condensed logo on startup, boxed banner for new versions / first run in a project
- **Status line** — model, cwd (with `~` shortening), git branch
- **Spinner** — CC's verb rotation with byline: elapsed time, token count, `esc to interrupt`
- **Turn footer** — per-request cost/duration summary, matching CC v2.1.234 behavior
- **Tool rendering** — CC-style tool rows (no background box), grouped consecutive calls with `⎿` continuation lines, CC-faithful diff rendering with syntax highlighting (shiki)
- **Thinking** — collapsed by default with CC's label treatment; `alt+t` to expand
- **Prompt editor** — CC's `❯` prompt pointer

**Commands**:

- `/cc-theme` — theme picker (CC themes only)
- `/cc-tools` — toggle CC-style tool rendering options
- `/cc-spinner` — spinner options

## Requirements

Runs inside pi (`@earendil-works/pi-coding-agent`); pi core packages are peer dependencies provided by the host. Tested against pi 0.84.x.

## License

MIT
