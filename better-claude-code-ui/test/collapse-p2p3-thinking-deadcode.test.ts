/**
 * AUDIT §4 / §5：collapse.ts:387 (P2 ×3) + grouping.ts:266 (P3 ×2) +
 * grouping.ts:40 (P3 ×1) — GroupInfo.thinkingSince 从头到尾没有赋值点，
 * 折叠组摘要里“进行时 thinking for Xs”分支和 groupThinkingMs 的开区间累加
 * 全是死代码。
 *
 * CC 判据：CollapsedReadSearchContent.tsx（折叠组摘要的对应物）根本没有
 * thinking 片段（现在/过去时都没有），live 的 `thinking`→`thought for Xs`
 * 秒表只存在于 SpinnerAnimationRow.tsx:197-201（spinner 状态行）。所以折叠组
 * 里的 live 秒表 + 现在时分支应删除；只保留 settled 的 thinkingMs→
 * “thought for Xs”（dsh-tui 移植的落定文案）。
 *
 * 本测试锁定删除后的行为：
 *  1. groupThinkingMs 只返回累加值，不再吃 `now` 开区间。
 *  2. collapsedSummary 落定文案永远是过去时 "thought for Xs"，没有现在时。
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

test("collapsedSummary 的 thinking 片段永远是过去时 'thought for'（无现在时死分支）", () => {
	// running=true（组还在跑）时，thinking 片段仍是过去时——CC 折叠组从不显示
	// 现在时 'thinking for'（那是 spinner 行的事）。
	const running = makeGroup({ thinkingMs: 2_000, readCount: 2, running: true, active: true });
	const sRun = collapsedSummary(running);
	assert.match(sRun, /thought for 2s/i, `running 组也应是过去时，实际: ${sRun}`);
	assert.doesNotMatch(sRun, /thinking for/i, `不应出现现在时 'thinking for'，实际: ${sRun}`);

	// settled 同样是过去时。
	const settled = makeGroup({ thinkingMs: 5_000, readCount: 3 });
	const sSet = collapsedSummary(settled);
	assert.match(sSet, /thought for 5s/i, `settled 组应是过去时，实际: ${sSet}`);
	assert.doesNotMatch(sSet, /thinking for/i);
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
