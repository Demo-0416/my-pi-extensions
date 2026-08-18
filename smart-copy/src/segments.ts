/**
 * 切段：marked.lexer 把 assistant 回复拆成选择器条目。
 *
 * 条目顺序（任务规格）：
 *   1. Full response
 *   2. Last code block（存在代码块时的置顶快捷项）
 *   3. 每个代码块（label = 代码首行截断 60 显示列）
 *   4. 每个 Markdown 章节（ATX heading 起，到同级/更高级 heading 前，含 heading 本身）
 *   5. Always copy full response
 */
import { marked, type Tokens } from "marked";
import { visibleWidth } from "@earendil-works/pi-tui";

export interface Segment {
  /** SelectList value：full / last / code:N / section:N / always。 */
  value: string;
  label: string;
  description?: string;
  /** 实际复制 / 写文件的内容。 */
  content: string;
  /** w 写文件用的文件名。 */
  filename: string;
}

export interface SegmentBuild {
  segments: Segment[];
  codeBlockCount: number;
  sectionCount: number;
}

const MAX_LABEL_WIDTH = 60;

/** 代码首行截断到 60 显示列（中文宽字符按 2 列计），超出加 …。 */
function truncateLabel(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  if (visibleWidth(firstLine) <= MAX_LABEL_WIDTH) return firstLine;
  let out = "";
  let width = 0;
  for (const ch of firstLine) {
    const w = visibleWidth(ch);
    if (width + w > MAX_LABEL_WIDTH - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

function linesLabel(n: number): string {
  return n === 1 ? "1 line" : `${n} lines`;
}

/** 语言名 sanitize 防路径穿越；plaintext / 无语言 → .txt（对齐 Claude Code）。 */
export function fileExtension(lang: string | undefined): string {
  if (lang) {
    const sanitized = lang.replace(/[^a-zA-Z0-9]/g, "");
    if (sanitized && sanitized !== "plaintext") return `.${sanitized.toLowerCase()}`;
  }
  return ".txt";
}

/** heading 文本里的行内标记轻量清理，让 label 可读。 */
function cleanHeading(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

interface CodeBlock {
  code: string;
  lang: string | undefined;
}

interface Section {
  heading: string;
  body: string;
}

/** 章节切分：每个 ATX heading 开一章，到下一个 heading（任意层级）前，含 heading 本身。 */
function extractSections(tokens: TokensList): Section[] {
  const sections: Section[] = [];
  let current: { heading: string; raws: string[] } | null = null;
  for (const token of tokens) {
    if (token.type === "heading") {
      if (current !== null) {
        sections.push({ heading: current.heading, body: current.raws.join("") });
      }
      const heading = token as Tokens.Heading;
      current = { heading: cleanHeading(heading.text), raws: [token.raw] };
    } else if (current !== null) {
      current.raws.push(token.raw);
    }
  }
  if (current !== null) {
    sections.push({ heading: current.heading, body: current.raws.join("") });
  }
  return sections;
}

type TokensList = ReturnType<typeof marked.lexer>;

function extractCodeBlocks(tokens: TokensList): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (const token of tokens) {
    if (token.type === "code") {
      const t = token as Tokens.Code;
      blocks.push({ code: t.text, lang: t.lang || undefined });
    }
  }
  return blocks;
}

export function buildSegments(fullText: string): SegmentBuild {
  const tokens = marked.lexer(fullText);
  const codeBlocks = extractCodeBlocks(tokens);
  const sections = extractSections(tokens);

  const segments: Segment[] = [];

  // 1. Full response
  segments.push({
    value: "full",
    label: "Full response",
    description: `${fullText.length} chars, ${linesLabel(countLines(fullText))}`,
    content: fullText,
    filename: "response.md",
  });

  // 2. Last code block（高频需求置顶）
  if (codeBlocks.length > 0) {
    const last = codeBlocks[codeBlocks.length - 1]!;
    segments.push({
      value: "last",
      label: "Last code block",
      description: [last.lang, linesLabel(countLines(last.code))].filter(Boolean).join(", "),
      content: last.code,
      filename: `copy${fileExtension(last.lang)}`,
    });
  }

  // 3. 每个代码块
  codeBlocks.forEach((block, i) => {
    segments.push({
      value: `code:${i}`,
      label: truncateLabel(block.code),
      description: [block.lang, linesLabel(countLines(block.code))].filter(Boolean).join(", "),
      content: block.code,
      filename: `copy${fileExtension(block.lang)}`,
    });
  });

  // 4. 每个 Markdown 章节
  sections.forEach((section, i) => {
    segments.push({
      value: `section:${i}`,
      label: truncateLabel(section.heading) || "(untitled section)",
      description: linesLabel(countLines(section.body)),
      content: section.body,
      filename: "response.md",
    });
  });

  // 5. Always copy full response
  segments.push({
    value: "always",
    label: "Always copy full response",
    description: "Skip this picker in the future (delete smart-copy.json to revert)",
    content: fullText,
    filename: "response.md",
  });

  return { segments, codeBlockCount: codeBlocks.length, sectionCount: sections.length };
}
