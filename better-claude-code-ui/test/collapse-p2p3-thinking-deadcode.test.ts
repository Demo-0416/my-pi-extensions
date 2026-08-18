/**
 * AUDIT §4 / §5：collapse.ts:387 (P2 ×3) + grouping.ts:266 (P3 ×2) +
 * grouping.ts:40 (P3 ×1) — GroupInfo.thinkingSince 从头到尾没有赋值点，
 * groupThinkingMs 的开区间累加全是死代码。
 *
 * CC 判据（据 CC v2.1.234 会话内实测，本地源码快照已过期）：折叠组行本身
 * 带 thinking 时长——组进行中是现在时 "thinking for Xs"，落定后变过去时
 * "thought for Xs"。时长是 thinking 跨度关闭时归因给组的累加值（定值，
 * 不走秒）；live 的 `thinking`→`thought for Xs` 秒表是 spinner 行
 * SpinnerAnimationRow 的独立信号，不在折叠组里。所以删掉的是开区间
 * `now - thinkingSince` 死代码，保留 thinkingMs 累加值 + 时态感知文案。
 *
 * 本测试锁定：
 *  1. groupThinkingMs 只返回累加值，不再吃 `now` 开区间。
 *  2. collapsedSummary 的 thinking 片段时态跟随组：active→"thinking for"，
 *     settled→"thought for"。
 *  3. thinkingMs 未达 1s 阈值时不出现 thinking 片段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	collapsedSummary,
	groupThinkingMs,
	type CollapsedGroup,
} from "../extension/tools/collapse.js";

function makeGroup(over: Partial<CollapsedGroup> = {}): CollapsedGroup {
	return {
		searchCount: 0,
		readCount: 0,
		listCount: 0,
		bashCount: 0,
		mcpCallCount: 0,
		mcpServers: [],
		thinkingMs: 0,
		running: false,
		active: false,
		failed: false,
		...over,
	};
}

test("groupThinkingMs 只返回累加值（不再有 now 开区间）", () => {
	// 死代码删除后 groupThinkingMs 只接受一个参数；传第二个 arg 也不影响结果。
	const g = makeGroup({ thinkingMs: 3_000 });
	assert.equal(groupThinkingMs(g), 3_000);
	// 累加值为 0 时返回 0，负值被夹到 0。
	assert.equal(groupThinkingMs(makeGroup({ thinkingMs: 0 })), 0);
	assert.equal(groupThinkingMs(makeGroup({ thinkingMs: -50 })), 0);
	// 函数只声明一个形参：不存在“靠 now 走秒表”的第二参。
	assert.equal(groupThinkingMs.length, 1, "groupThinkingMs 应只有一个形参");
});

test("collapsedSummary 的 thinking 片段时态跟随组：active→'thinking for'，settled→'thought for'", () => {
	// 组进行中（running=true）：现在时 "thinking for Xs"，与 search/read
	// 片段的现在时一致。
	const running = makeGroup({ thinkingMs: 2_000, readCount: 2, running: true, active: true });
	const sRun = collapsedSummary(running);
	assert.match(sRun, /thinking for 2s/i, `running 组应是现在时，实际: ${sRun}`);
	assert.doesNotMatch(sRun, /thought for/i, `running 组不应是过去时，实际: ${sRun}`);

	// 组落定：过去时 "thought for Xs"。
	const settled = makeGroup({ thinkingMs: 5_000, readCount: 3 });
	const sSet = collapsedSummary(settled);
	assert.match(sSet, /thought for 5s/i, `settled 组应是过去时，实际: ${sSet}`);
	assert.doesNotMatch(sSet, /thinking for/i, `settled 组不应是现在时，实际: ${sSet}`);
});

test("thinkingMs 低于 1s 阈值时不出现 thinking 片段", () => {
	const g = makeGroup({ thinkingMs: 999, readCount: 1 });
	const s = collapsedSummary(g);
	assert.doesNotMatch(s, /thought|thinking/i, `未达阈值不应有 thinking 片段，实际: ${s}`);
	assert.match(s, /Read 1 file/, `仍应有 read 片段，实际: ${s}`);
});

test("collapsedSummary 不再接收 now 参数（签名为 group, styleCount?）", () => {
	// 第二参是 styleCount（把计数加粗）。传函数应生效；传数字（旧的 now）
	// 会被当成 styleCount 调用——但这里只验证签名语义：styleCount 作用于计数。
	const g = makeGroup({ readCount: 4 });
	const styled = collapsedSummary(g, (n) => `<${n}>`);
	assert.match(styled, /Read <4> files/, `styleCount 应作用于计数，实际: ${styled}`);
});
