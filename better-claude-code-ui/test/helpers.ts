/**
 * 渲染断言辅助：pi-tui 组件都有 render(width): string[]（pi-tui tui.d.ts:11），
 * 渲染行带 ANSI；plain* 系列用 pi-tui 的 stripTerminalSequences 剥成纯文本。
 */
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

/** 组件渲染成 ANSI 行数组。 */
export function renderLines(component: any, width = 80): string[] {
	return component.render(width);
}

/** 组件渲染成纯文本行数组（剥 ANSI）。 */
export function plain(component: any, width = 80): string[] {
	return renderLines(component, width).map((l) => stripTerminalSequences(l));
}

/** 组件渲染成纯文本（行用 \n 连接）。 */
export function plainText(component: any, width = 80): string {
	return plain(component, width).join("\n");
}

/** 纯文本可见宽度（CJK 友好，代理对安全）。 */
export function width(text: string): number {
	return visibleWidth(text);
}

/** 把多行文本按可见宽度折行（pi-tui wrapTextWithAnsi 的纯文本包装）。 */
export function wrapPlain(text: string, width: number): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (visibleWidth(line) <= width) {
			out.push(line);
			continue;
		}
		let cur = "";
		let curW = 0;
		for (const ch of line) {
			const w = visibleWidth(ch);
			if (curW + w > width) {
				out.push(cur);
				cur = ch;
				curW = w;
			} else {
				cur += ch;
				curW += w;
			}
		}
		if (cur) out.push(cur);
	}
	return out;
}

/** 等一个微任务周期（让 .then(invalidate) 类回调跑完）。 */
export async function tick(): Promise<void> {
	await new Promise((r) => setImmediate(r));
}

/** 带超时地等一个条件成立，默认 2s。不成立就抛。 */
export async function waitFor(cond: () => boolean, timeoutMs = 2000, label = "condition"): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}
