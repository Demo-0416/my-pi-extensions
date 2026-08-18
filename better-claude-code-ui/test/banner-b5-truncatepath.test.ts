/**
 * AUDIT §5 banner.ts:79 (P3 ×2):
 *
 * 旧 truncatePath 对绝对路径 `/a/b/c` 产出 `//…/c`（first = parts[0]||"/" 强制
 * 成 "/"，模板再加一个 "/" → 双斜杠）；对带尾斜杠的 `/a/b/` 产出 `//…/`（末段
 * split 出空串，信息全丢）。改成 CC logoV2Utils.ts:175 的 `<first>/…/<last>`
 * 形状：绝对路径 first = "" → 单个前导斜杠 `/…/c`，先去掉尾斜杠让 last 是真尾段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { truncatePath } from "../extension/banner.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const strip = (s: string) => stripTerminalSequences(s);

test("绝对路径不产出双斜杠", () => {
	const out = strip(truncatePath("/home/user/projects/app/src", 12));
	assert.doesNotMatch(out, /^\/\//, `绝对路径不应以 // 开头，实际: ${JSON.stringify(out)}`);
	assert.match(out, /src$/, `尾段 src 应保留: ${JSON.stringify(out)}`);
	// 应是 `/…/src` 形状（单前导斜杠）
	assert.equal(out, "/…/src");
});

test("带尾斜杠的路径不丢失末段", () => {
	const out = strip(truncatePath("/home/user/projects/app/", 12));
	assert.doesNotMatch(out, /…\/$/, `不应以 …/ 结尾（信息全丢），实际: ${JSON.stringify(out)}`);
	// 去掉尾斜杠后末段是 app
	assert.match(out, /app$/, `末段应是 app: ${JSON.stringify(out)}`);
	assert.equal(out, "/…/app");
});

test("~ 相对路径仍是 ~/…/tail", () => {
	const out = strip(truncatePath("~/projects/deep/nested/app/src", 12));
	assert.match(out, /^~\//, `应以 ~/ 开头: ${JSON.stringify(out)}`);
	assert.match(out, /src$/, `尾段 src 应保留: ${JSON.stringify(out)}`);
});

test("够短时原样返回", () => {
	assert.equal(truncatePath("~/app", 20), "~/app");
});

test("末段太长时截断末段但保留 head", () => {
	const out = strip(truncatePath("/home/user/verylongfinalsegmentname", 10));
	assert.ok(out.length > 0);
	assert.doesNotMatch(out, /^\/\//, `不应双斜杠: ${JSON.stringify(out)}`);
});
