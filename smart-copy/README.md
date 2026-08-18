# smart-copy

pi 扩展：模仿 Claude Code 的 `/copy`，支持智能切段（代码块、Markdown 章节）和多消息选择的 `/copyx` 命令。

## 功能

- `/copyx [N]` — 复制第 N 条（1 = 最新，默认）assistant 消息，上限 20 条
- 选择器条目（按顺序）：
  1. **Full response** — 全量回复
  2. **Last code block** — 最后一个代码块（高频快捷项，仅有代码块时出现）
  3. **每个代码块** — label 为代码首行（截断 60 显示列，中文宽字符感知）
  4. **每个 Markdown 章节** — 按 ATX heading 切分（含子章节内容）
  5. **Always copy full response** — 写入偏好后跳过选择器
- 代码块和章节都为 0 时不弹选择器，直接全量复制

## 快捷键

| 按键 | 作用 |
|---|---|
| `ctrl+shift+x` | 等价 `/copyx 1` |
| `↑↓` | 选择器导航 |
| `Enter` | 复制选中项 |
| `Esc` | 取消 |
| `[` `]` 或 `←` `→` | 切换上一条/下一条候选消息 |
| `w` | 当前高亮项写入 `$TMPDIR/pi-copy/<file>`（代码块按语言给扩展名） |
| 直接打字 | 过滤条目 |

复制成功提示 `Copied X chars to clipboard`。

## 配置

偏好文件 `~/.pi/agent/smart-copy.json`：

```json
{ "alwaysFull": true }
```

- 选择器里选 **Always copy full response** 即写入 `alwaysFull: true`，此后 `/copyx` 直接全量复制
- 删除该字段（或整个文件）即恢复选择器

## 复制与 fallback

主路径 `copyToClipboard`（pi 内置降级链：原生 addon → pbcopy/clip/wl-copy/xclip/xsel/termux → SSH OSC 52）。全失败时写入 `$TMPDIR/pi-copy/response.md` 并提示路径，保证任何环境拿得到内容。

## 安装

扩展目录 `npm install` 后，在 `~/.pi/agent/settings.json` 的 `extensions` 数组加入本目录的绝对路径：

```json
{ "extensions": ["/path/to/smart-copy"] }
```

## 已知限制

- 只能复制当前分支可见消息（compaction 之前的消息不在 `getBranch()` 范围内）
- 不复制 thinking 块和工具调用内容
- streaming 中触发（`ctrl+shift+x`）降级为直接全量复制最新消息，不弹选择器
