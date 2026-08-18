/**
 * AUDIT §5 status-line.ts:66 (P2 ×1):
 *
 * 旧代码 cwd.replace(process.env.HOME ?? "", "~")：HOME 未设置时 ?? "" 得空串，
 * String.replace("", "~") 在下标 0 匹配空串 → 在 cwd 前面凭空插一个 `~`
 * （`~/abs/path`）。改用 CC getDisplayPath (file.ts:163) 的 homedir() +
 * `home + "/"` 边界守卫。
 *
 * 复现旧 bug 的纯字符串对照，加验证新 tildeHome 的边界行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { tildeHome } from "../extension/status-line.js";

test("复现旧 bug：replace('', '~') 会凭空插 ~", () => {
	const cwd = "/srv/work/app";
	// 旧写法（HOME 未设置 → ?? "" → replace("", "~")）
	const buggy = cwd.replace("" /* = process.env.HOME ?? "" */, "~");
	assert.equal(buggy, "~/srv/work/app", "旧写法确实会在前面插一个 ~（这就是 bug）");
	// 新写法：cwd 不在 home 下 → 原样返回，绝不插 ~
	assert.equal(tildeHome(cwd), "/srv/work/app");
});

test("cwd 不在 home 下时原样返回（无 stray ~）", () => {
	assert.equal(tildeHome("/var/tmp/x"), "/var/tmp/x");
	assert.equal(tildeHome("/"), "/");
});

test("cwd == home → ~", () => {
	assert.equal(tildeHome(homedir()), "~");
});

test("cwd 在 home 下 → ~/rest", () => {
	const home = homedir();
	assert.equal(tildeHome(`${home}/projects/app`), "~/projects/app");
});

test("边界守卫：与 home 同前缀但不是子目录时不折叠", () => {
	const home = homedir();
	// home + "extra"（没有分隔符）不应被当成 home 的子目录
	assert.equal(tildeHome(`${home}extra/app`), `${home}extra/app`);
});
