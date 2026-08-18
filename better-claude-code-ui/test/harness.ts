/**
 * 测试基座：在 Node 里伪造 pi 的 ExtensionAPI / ExtensionUIContext /
 * ToolRenderContext，让扩展不经真实 TUI 就能加载、触发事件、断言渲染结果。
 *
 * 依据：pi-coding-agent/dist/core/extensions/types.d.ts
 * （ExtensionAPI:867、ExtensionUIContext:68、ToolRenderContext:315、
 *   事件结构 AgentStartEvent:537 / TurnStartEvent:550 / ToolExecutionStartEvent:579 等）
 *
 * 设计原则：fake 只实现扩展实际用到的成员（grep `pi\.` / `ctx\.ui\.` 统计过），
 * 其余一律不给——扩展若用了新成员，测试会显式炸出来，而不是静默拿到 undefined。
 */
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** pi-tui Theme 的测试替身：fg(token, text) / bold(text) 是扩展唯一用到的成员。 */
export class FakeTheme {
	name = "fake";
	/** 记录每次 fg 调用的 token，方便断言“用了哪个 theme token”。 */
	fgCalls: Array<{ token: string; text: string }> = [];
	constructor(name = "fake") {
		this.name = name;
	}
	fg(token: string, text: string): string {
		this.fgCalls.push({ token, text });
		return text;
	}
	bold(text: string): string {
		return text;
	}
	getColorMode(): "dark" | "light" {
		return "dark";
	}
}

// ---------------------------------------------------------------------------
// UI context
// ---------------------------------------------------------------------------

/** ExtensionUIContext 的测试替身（types.d.ts:68）。所有 set* 只记录不渲染。 */
export class FakeUI {
	theme: FakeTheme;
	workingMessage: string | undefined;
	workingVisible = true;
	workingIndicator: unknown = undefined;
	hiddenThinkingLabel: string | undefined;
	footerFactory: unknown = undefined;
	headerFactory: unknown = undefined;
	title: string | undefined;
	widgets = new Map<string, unknown>();
	statuses = new Map<string, string | undefined>();
	notifications: Array<{ message: string; type?: string }> = [];
	toolsExpanded = false;
	editorText = "";
	/** setFooter 工厂收到的 footerData 替身（status-line 用 onBranchChange）。 */
	footerData = makeFakeFooterData();

	constructor(theme?: FakeTheme) {
		this.theme = theme ?? new FakeTheme();
	}
	notify(message: string, type?: string): void {
		this.notifications.push({ message, type });
	}
	setStatus(key: string, text: string | undefined): void {
		this.statuses.set(key, text);
	}
	setWorkingMessage(message?: string): void {
		this.workingMessage = message;
	}
	setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
	}
	setWorkingIndicator(options?: unknown): void {
		this.workingIndicator = options;
	}
	setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label;
	}
	setFooter(factory?: unknown): void {
		this.footerFactory = factory;
	}
	setHeader(factory?: unknown): void {
		this.headerFactory = factory;
	}
	setTitle(title: string): void {
		this.title = title;
	}
	setWidget(key: string, content?: unknown): void {
		if (content === undefined) this.widgets.delete(key);
		else this.widgets.set(key, content);
	}
	getToolsExpanded(): boolean {
		return this.toolsExpanded;
	}
	setToolsExpanded(v: boolean): void {
		this.toolsExpanded = v;
	}
	pasteToEditor(_text: string): void {}
	setEditorText(text: string): void {
		this.editorText = text;
	}
	getEditorText(): string {
		return this.editorText;
	}
	async select(): Promise<string | undefined> {
		return undefined;
	}
	async confirm(): Promise<boolean> {
		return false;
	}
	async input(): Promise<string | undefined> {
		return undefined;
	}
	onTerminalInput(): () => void {
		return () => {};
	}
	getAllThemes(): Array<{ name: string; path?: string }> {
		return [];
	}
	getTheme(): undefined {
		return undefined;
	}
	setTheme(): { success: boolean } {
		return { success: true };
	}
	async custom(): Promise<unknown> {
		return undefined;
	}
	async editor(): Promise<string | undefined> {
		return undefined;
	}
	addAutocompleteProvider(): void {}
	setEditorComponent(): void {}
	getEditorComponent(): undefined {
		return undefined;
	}
}

export function makeFakeFooterData() {
	const branchListeners = new Set<() => void>();
	return {
		branch: "main",
		onBranchChange(cb: () => void): () => void {
			branchListeners.add(cb);
			return () => branchListeners.delete(cb);
		},
		fireBranchChange(): void {
			for (const cb of branchListeners) cb();
		},
	};
}

// ---------------------------------------------------------------------------
// ToolRenderContext
// ---------------------------------------------------------------------------

export interface FakeToolCtxOverrides {
	args?: Record<string, unknown>;
	toolCallId?: string;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: Record<string, unknown>;
	cwd?: string;
	executionStarted?: boolean;
	argsComplete?: boolean;
	isPartial?: boolean;
	expanded?: boolean;
	showImages?: boolean;
	isError?: boolean;
}

/** ToolRenderContext 的测试替身（types.d.ts:315）。invalidate 默认是 spy。 */
export function makeToolCtx(overrides: FakeToolCtxOverrides = {}): {
	ctx: any;
	invalidateCalls: { count: number };
} {
	const invalidateCalls = { count: 0 };
	const ctx = {
		args: {},
		toolCallId: "call-1",
		invalidate: () => {
			invalidateCalls.count++;
		},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
	return { ctx, invalidateCalls };
}

// ---------------------------------------------------------------------------
// ExtensionAPI
// ---------------------------------------------------------------------------

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

/** ExtensionAPI 的测试替身（types.d.ts:867）。 */
export class FakePi {
	private handlers = new Map<string, Set<Handler>>();
	/** registerTool 捕获：name -> ToolDefinition */
	tools = new Map<string, any>();
	commands = new Map<string, any>();
	shortcuts = new Map<string, any>();
	flags = new Map<string, { type: string; default?: unknown; value?: unknown }>();
	messageRenderers = new Map<string, any>();
	markdownTransformers: any[] = [];
	entryRenderers = new Map<string, any>();
	appendedEntries: Array<{ customType: string; data: unknown }> = [];
	sentMessages: any[] = [];
	sessionName: string | undefined;
	labels = new Map<string, string | undefined>();
	activeTools: string[] = [];
	/** getAllTools() 的返回 */
	allToolsList: any[] = [];
	commandsList: any[] = [];
	thinkingLevel: string = "medium";
	model: any = { id: "fake-model", name: "Fake Model" };
	providers = new Map<string, any>();
	ui = new FakeUI();
	events = new EventEmitter();
	cwd = process.cwd();
	mode: "tui" | "rpc" | "json" | "print" = "tui";
	hasUI = true;
	/** ctx.sessionManager 替身（扩展读历史消息时用） */
	sessionManager = makeFakeSessionManager();
	modelRegistry = {};
	scopedModels: any[] = [];

	on(event: string, handler: Handler): void {
		if (!this.handlers.has(event)) this.handlers.set(event, new Set());
		this.handlers.get(event)!.add(handler);
	}

	/** 触发一个事件，await 所有 handler。返回各 handler 的结果数组。 */
	async emit(event: string, payload: Record<string, unknown> = {}): Promise<any[]> {
		const ev = { type: event, ...payload };
		const ctx = this.ctx();
		const hs = this.handlers.get(event);
		if (!hs) return [];
		const results: any[] = [];
		for (const h of [...hs]) results.push(await h(ev, ctx));
		return results;
	}

	/** 扩展事件 handler 收到的 ExtensionContext（types.d.ts:209）。 */
	ctx(): any {
		return {
			ui: this.ui,
			mode: this.mode,
			hasUI: this.hasUI,
			cwd: this.cwd,
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			model: this.model,
			scopedModels: this.scopedModels,
			thinkingLevel: this.thinkingLevel,
			isIdle: () => true,
			isProjectTrusted: () => true,
			signal: undefined,
			abort(): void {},
			hasPendingMessages: () => false,
			shutdown(): void {},
			getContextUsage: () => undefined,
			compact(): void {},
			getSystemPrompt: () => "",
		};
	}

	registerTool(tool: any): void {
		this.tools.set(tool.name, tool);
	}
	registerCommand(name: string, opts: any): void {
		this.commands.set(name, opts);
	}
	registerShortcut(id: string, opts: any): void {
		this.shortcuts.set(id, opts);
	}
	registerFlag(name: string, opts: any): void {
		this.flags.set(name, opts);
	}
	getFlag(name: string): unknown {
		return this.flags.get(name)?.value;
	}
	registerMessageRenderer(customType: string, renderer: any): void {
		this.messageRenderers.set(customType, renderer);
	}
	registerMarkdownTransformer(transformer: any): void {
		this.markdownTransformers.push(transformer);
	}
	registerEntryRenderer(customType: string, renderer: any): void {
		this.entryRenderers.set(customType, renderer);
	}
	sendMessage(message: any, options?: unknown): void {
		this.sentMessages.push({ ...message, options });
	}
	sendUserMessage(): void {}
	appendEntry(customType: string, data?: unknown): void {
		this.appendedEntries.push({ customType, data });
	}
	setSessionName(name: string): void {
		this.sessionName = name;
	}
	getSessionName(): string | undefined {
		return this.sessionName;
	}
	setLabel(entryId: string, label: string | undefined): void {
		this.labels.set(entryId, label);
	}
	async exec(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return { stdout: "", stderr: "", exitCode: 0 };
	}
	getActiveTools(): string[] {
		return this.activeTools;
	}
	getAllTools(): any[] {
		return this.allToolsList;
	}
	setActiveTools(toolNames: string[]): void {
		this.activeTools = toolNames;
	}
	getCommands(): any[] {
		return this.commandsList;
	}
	async setModel(): Promise<boolean> {
		return true;
	}
	getThinkingLevel(): string {
		return this.thinkingLevel;
	}
	setThinkingLevel(level: string): void {
		this.thinkingLevel = level;
	}
	registerProvider(name: string, config?: any): void {
		this.providers.set(name, config);
	}
	unregisterProvider(name: string): void {
		this.providers.delete(name);
	}
}

export function makeFakeSessionManager() {
	const entries: any[] = [];
	return {
		entries,
		getEntries: () => entries,
		getBranch: (_fromId?: string) => entries,
		getSessionId: () => "test-session-id",
		getSessionName: () => undefined,
		getCurrentSession: () => ({ entries }),
	};
}

// ---------------------------------------------------------------------------
// 加载扩展
// ---------------------------------------------------------------------------

/**
 * 加载 extension/index.ts 并注册到一个 FakePi 上。
 *
 * 注意：ESM 模块图有缓存，同一进程里多次 loadExtension 共享扩展模块的
 * 模块级状态（spinner/grouping 等的私有状态会残留）。需要干净状态的测试
 * 请放在独立的测试文件里（node:test 每个文件一个进程）。
 */
export async function loadExtension(pi?: FakePi): Promise<FakePi> {
	const fake = pi ?? new FakePi();
	const mod = await import("../extension/index.js");
	(mod as any).default(fake);
	return fake;
}

/** 触发 session_start（footer/header/分组器等都挂在这个事件上初始化）。 */
export async function startSession(pi: FakePi, reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup"): Promise<void> {
	await pi.emit("session_start", { reason });
}
