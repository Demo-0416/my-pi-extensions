/**
 * 选择器：ctx.ui.custom + SelectList（tui.md Pattern 1 骨架）。
 *
 * 交互：
 *   ↑↓ 导航 / Enter 复制 / Esc 取消 / 直接打字过滤（按 label 子串）
 *   [ ] 或 ← → 切换上一条/下一条候选消息，切段列表实时重建
 *   w 把当前高亮项写入 $TMPDIR/pi-copy/<filename>，状态栏提示路径
 */
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Text,
  getKeybindings,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSegments, type Segment } from "./segments.ts";

export const COPY_DIR = join(process.env.TMPDIR ?? tmpdir(), "pi-copy");

export type PickerOutcome =
  | { action: "copy"; segment: Segment }
  | { action: "always"; segment: Segment }
  | { action: "cancel" };

/** 写文件（w 快捷键与 clipboard fallback 共用）。 */
export function writeToFile(text: string, filename: string): string {
  mkdirSync(COPY_DIR, { recursive: true });
  const path = join(COPY_DIR, filename);
  writeFileSync(path, text, "utf8");
  return path;
}

/** SelectList 的 items/filteredItems 在 .d.ts 里是 private，运行时是公开字段。 */
type MutableSelectList = {
  items: SelectItem[];
  filteredItems: SelectItem[];
  selectedIndex: number;
};

const toItem = (s: Segment): SelectItem => ({
  value: s.value,
  label: s.label,
  description: s.description,
});

export async function pickSegment(
  ctx: ExtensionContext,
  messages: string[],
  initialIndex: number,
): Promise<PickerOutcome> {
  let current = initialIndex;
  let filter = "";
  let allItems: SelectItem[] = [];
  let segmentByValue = new Map<string, Segment>();

  return await ctx.ui.custom<PickerOutcome>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    const title = new Text("", 1, 0);
    container.addChild(title);

    const selectList = new SelectList([], 10, {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    const sl = selectList as unknown as MutableSelectList;
    container.addChild(selectList);

    const help = new Text(
      theme.fg(
        "dim",
        "↑↓ navigate • enter copy • [ ] or ← → switch message • w write file • type to filter • esc cancel",
      ),
      1,
      0,
    );
    container.addChild(help);

    const status = new Text("", 1, 0);
    container.addChild(status);
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    const applyFilter = (): void => {
      const f = filter.trim().toLowerCase();
      sl.filteredItems = f === ""
        ? allItems
        : allItems.filter((i) => i.label.toLowerCase().includes(f));
      sl.selectedIndex = 0;
    };

    const rebuild = (): void => {
      const build = buildSegments(messages[current]!);
      segmentByValue = new Map(build.segments.map((s) => [s.value, s]));
      allItems = build.segments.map(toItem);
      applyFilter();
      title.setText(
        theme.fg("accent", theme.bold(`Copy from message ${current + 1}/${messages.length}`)),
      );
      status.setText("");
      tui.requestRender();
    };

    const switchMessage = (delta: number): void => {
      const next = current + delta;
      if (next < 0 || next >= messages.length) {
        status.setText(
          theme.fg("warning", next < 0 ? "Already at first message" : "Already at last message"),
        );
        tui.requestRender();
        return;
      }
      current = next;
      filter = "";
      rebuild();
    };

    const writeFocused = (): void => {
      const item = selectList.getSelectedItem();
      const seg = item === null ? undefined : segmentByValue.get(item.value);
      if (seg === undefined) return;
      try {
        const path = writeToFile(seg.content, seg.filename);
        status.setText(theme.fg("muted", `Written to ${path}`));
      } catch (e) {
        status.setText(
          theme.fg("warning", `Write failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      tui.requestRender();
    };

    selectList.onSelect = (item) => {
      const seg = segmentByValue.get(item.value);
      if (seg === undefined) return;
      done(item.value === "always" ? { action: "always", segment: seg } : { action: "copy", segment: seg });
    };
    selectList.onCancel = () => done({ action: "cancel" });

    rebuild();

    const kb = getKeybindings();
    const isLeft = (d: string) => d === "\x1b[D" || d === "\x1bOD";
    const isRight = (d: string) => d === "\x1b[C" || d === "\x1bOC";

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // 导航/确认/取消走 SelectList 自身逻辑。
        if (
          kb.matches(data, "tui.select.up")
          || kb.matches(data, "tui.select.down")
          || kb.matches(data, "tui.select.confirm")
          || kb.matches(data, "tui.select.cancel")
        ) {
          selectList.handleInput(data);
          tui.requestRender();
          return;
        }
        if (data === "w") { writeFocused(); return; }
        if (data === "[" || isLeft(data)) { switchMessage(-1); return; }
        if (data === "]" || isRight(data)) { switchMessage(1); return; }
        // 可打印字符 → 过滤；Backspace/DEL 删一个。
        if (data.length === 1 && data >= " ") {
          filter += data;
          applyFilter();
          tui.requestRender();
          return;
        }
        if (data === "\x7f" || data === "\b") {
          filter = filter.slice(0, -1);
          applyFilter();
          tui.requestRender();
        }
      },
    };
  });
}
