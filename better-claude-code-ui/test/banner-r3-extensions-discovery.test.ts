/**
 * 用户实测缺陷:欢迎盒 Extensions 栏只扫 ~/.pi/agent/extensions/ 目录,漏掉
 * settings.json `extensions` 数组按路径加载的扩展(better-claude-code-ui 自己、
 * pi-trace)和 `packages` 包提供的扩展。修复:并入三份 settings.json 的两个
 * 数组,从路径/包名推导显示名(跳过 index/src/extension 等无信息段)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extensionDisplayName } from "../extension/banner.js";

test("extensionDisplayName 从路径/包名推导有意义的显示名", () => {
	const cases: Array<[string, string]> = [
		["/a/b/better-claude-code-ui/extension/index.ts", "better-claude-code-ui"],
		["/w/pi-smart-copy/smart-copy", "smart-copy"],
		["../pi-trace/src/index.ts", "pi-trace"],
		["npm:pi-web-access", "pi-web-access"],
		["npm:@juicesharp/rpiv-todo", "rpiv-todo"],
		["git:github.com/code-yeongyu/pi-rules", "pi-rules"],
		["my-ext.ts", "my-ext"],
	];
	for (const [input, expected] of cases) {
		assert.equal(extensionDisplayName(input), expected, `${input} 应推导为 ${expected}`);
	}
});

test("全 generic 段的路径回退为原 spec(不产出空名/..)", () => {
	const out = extensionDisplayName("src/index.ts");
	assert.ok(out.length > 0, "不应为空");
	assert.notEqual(out, "..", "不应是 ..");
});
