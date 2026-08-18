/**
 * AUDIT §5:157 (P3 ×1) — settleLeakedGroups 把所有未结束的工具一律标成
 * success，导致 run 异常死亡（tool_execution_end 丢失）后残留成员显示绿点。
 *
 * 实情校正：Esc 中断走的是 pi-agent-core 的 tool_execution_end{isError:true}
 * （"Operation aborted"），会正常落成 error（红），根本不会残留 pending。真正
 * 到达 settleLeakedGroups 的只有「run 异常死亡、tool_end 丢失」的成员——它是
 * 未观测到完成，不能当作确认成功。修复：标 error 而非 success。
 *
 * 断言：一个组里 m1 正常成功、m2 从未收到 tool_execution_end；agent_end 后
 * settle 把 m2 标成 error（红点），而不是 success（绿点）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme, loadExtension, makeToolCtx } from "./harness.js";
import { plainText } from "./helpers.js";

test("leak 的 pending 成员被标 error 而非 success（异常死亡不显示绿点）", async () => {
	const pi = new FakePi();
	await loadExtension(pi);
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("agent_start");
	await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await pi.emit("tool_execution_start", { toolCallId: "r1", toolName: "read", args: { path: "a.txt" } });
	await pi.emit("tool_execution_start", { toolCallId: "r2", toolName: "read", args: { path: "b.txt" } });
	// r1 正常结束成功；r2 的 tool_execution_end 丢失（模拟 run 死亡）。
	await pi.emit("tool_execution_end", { toolCallId: "r1", toolName: "read", result: { content: [{ type: "text", text: "x" }] }, isError: false });
	// agent_end 触发 settleLeakedGroups（在微任务里）。
	await pi.emit("agent_end", { messages: [] });
	await new Promise((r) => setImmediate(r));

	// 展开视图渲染 leader 的分组预览，含每个成员的 glance 行（带状态点）。
	const read = pi.tools.get("read")!;
	const theme = new FakeTheme() as unknown as FakeTheme & { fgCalls: Array<{ token: string; text: string }> };
	const { ctx } = makeToolCtx({ toolCallId: "r1", args: { path: "a.txt" }, expanded: true, isPartial: false });
	const preview = read.renderCall({ path: "a.txt" }, theme, ctx);
	plainText(preview); // 触发渲染，填充 fgCalls

	// 断言：leak 成员用了 error token 上色的状态点，且没有把 leak 成员当 success。
	const errorDots = theme.fgCalls.filter((c) => c.token === "error" && c.text === "⏺" || (c.token === "error" && c.text === "●"));
	assert.ok(errorDots.length >= 1, `leak 成员应有 error 状态点，fgCalls=${JSON.stringify(theme.fgCalls)}`);
	// r1 成功一个 success 点；r2 leak 应是 error，不应是第二个 success。
	const successDots = theme.fgCalls.filter((c) => c.token === "success" && (c.text === "⏺" || c.text === "●"));
	assert.equal(successDots.length, 1, `只有 r1 是真 success，leak 的 r2 不应也变绿；successDots=${JSON.stringify(successDots)}`);
});
