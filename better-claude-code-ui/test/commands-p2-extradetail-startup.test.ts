/**
 * AUDIT §4 / §5:71 (P2 ×11): commands.ts 的 extraDetail 从 ~/.pi/settings.json
 * 的 ccToolsExtraDetail 读入并持久化，但 builtins.ts 的模块级 extraDetail 只默认
 * false、且仅由 setExtraDetail() 改写。启动时没人把持久化值回灌给 builtins：
 *   - 状态栏读 commands.ts 的 extraDetail → 显示 "on"
 *   - builtins 实际仍按 previewLimit()=8 截断 → 行为是 off
 *   - 第一次 Ctrl+Shift+O 做 setDetail(!extraDetail)=setDetail(false) → 归到 off，
 *     看起来“第一次快捷键空按/反而关掉”。
 *
 * 修复：registerCommands 启动时一次性 setExtraDetail(extraDetail)，让 builtins 的
 * 开关与持久化/显示状态一致。
 *
 * 本测试在一个带 ccToolsExtraDetail:true 的临时 cwd 里全新加载扩展（模块级状态
 * 每个测试文件一进程，互不污染），然后观察 builtins 的“实际行为侧”：bash 20 行
 * 输出应全展开、不出现 "... (N earlier lines)" 截断——证明 extraDetail 真的推给了
 * builtins，而不是只在 commands.ts 里 on、builtins 里 off。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("启动时把持久化的 ccToolsExtraDetail 回灌给 builtins（状态栏 on 时行为也 on）", async () => {
	// 1) 造一个临时 cwd，写入 .pi/settings.json { ccToolsExtraDetail: true }。
	//    readSettings 用 process.cwd()+/.pi/settings.json 与 homedir 合并，cwd 优先级
	//    在合并里靠前（先 assign cwd 再 assign home），这里只设 cwd 侧即可命中。
	const dir = mkdtempSync(join(tmpdir(), "cc-extra-detail-"));
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ ccToolsExtraDetail: true }) + "\n");

	const origCwd = process.cwd();
	process.chdir(dir);
	try {
		// 2) 在 chdir 之后再动态 import——commands.ts 在模块顶层读 settings（第 70-71 行），
		//    import 时机决定它读到的是我们造的 cwd 设置。
		const { FakePi, loadExtension } = await import("./harness.js");
		const commands = await import("../extension/commands.js");

		// 断言前提：commands.ts 读到了持久化的 on。
		assert.equal(commands.isExtraDetail(), true, "commands.ts 应从 settings 读到 on");

		// 3) 全量加载扩展（= 启动路径）：registerBuiltins 注册 bash 等工具，
		//    registerCommands 在启动时一次性 setExtraDetail(extraDetail) 回灌 builtins。
		//    修复前 registerCommands 什么都不往 builtins 推。
		const pi = new FakePi();
		await loadExtension(pi);

		// 4) 观察 builtins 的“实际行为侧”：20 行 bash 成功输出。
		//    off（cap=8）→ 只显示尾 8 行且带 "... (12 earlier lines)"。
		//    on（cap=12000）→ 20 行全展开、无 "earlier lines" 截断。
		const bash = pi.tools.get("bash");
		assert.ok(bash, "bash 工具已注册");
		const { FakeTheme } = await import("./harness.js");
		const { plainText } = await import("./helpers.js");
		const theme = new FakeTheme("claude-code-dark");

		const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n");
		const result = { content: [{ type: "text", text: lines }] };
		const ctx: any = {
			state: {}, lastComponent: undefined, invalidate: () => {}, toolCallId: "call-extra",
			cwd: dir, executionStarted: true, argsComplete: true, isPartial: false,
			expanded: false, isError: false, args: { command: "seq 20" },
		};
		const rendered = bash.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
		const text = plainText(rendered, 100);

		assert.doesNotMatch(text, /earlier lines/, `extraDetail 已推给 builtins 时不应截断，实际:\n${text}`);
		assert.match(text, /line-1\b/, `应能看到第 1 行（全展开），实际:\n${text}`);
		assert.match(text, /line-20\b/, `应能看到第 20 行，实际:\n${text}`);
	} finally {
		process.chdir(origCwd);
	}
});
