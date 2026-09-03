import { resolve } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	getMarkdownTheme,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, Text, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { currentDepth, loadSettings } from "./config.ts";
import { SubagentPanel } from "./panel.ts";
import { isTerminalStatus, readRecords, saveRecord } from "./registry.ts";
import { cancelSubagent, killPidTree, startSubagent } from "./spawn-agent.ts";
import { descendantsOf } from "./registry.ts";
import type { AgentRecord, SubagentSettings } from "./types.ts";

interface RuntimeState {
	runId: string;
	rootRunId: string;
	depth: number;
	settings: SubagentSettings;
	projectTrusted: boolean;
}

const SpawnAgentSchema = Type.Object({
	task: Type.String({ description: "Focused task to delegate to the subagent" }),
	name: Type.Optional(Type.String({ description: "Readable subagent name" })),
	cwd: Type.Optional(Type.String({ description: "Working directory, relative to the current agent unless absolute" })),
	model: Type.Optional(Type.String({ description: "Exact model selector. Overrides configured and inherited defaults." })),
	thinking: Type.Optional(Type.String({ description: "Thinking level for this subagent" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional exact tool allowlist" })),
});

const CheckSchema = Type.Object({
	wait: Type.Optional(Type.Boolean({ description: "Block until every subagent finishes or the timeout elapses" })),
	timeoutMs: Type.Optional(Type.Integer({ description: "Max wait in ms when wait:true (default 30000, max 300000)" })),
});

const CancelSchema = Type.Object({
	target: Type.String({ description: "Subagent run id, session id, or exact name" }),
});

const RESULT_OUTPUT_CAP = 8000;

function cap(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function shortId(runId: string): string {
	return runId.slice(0, 8);
}

export default function subagentsExtension(pi: ExtensionAPI) {
	let runtime: RuntimeState | undefined;
	let panel: SubagentPanel | undefined;
	let mainModel: string | undefined;
	let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
	let keepAlive: ReturnType<typeof setInterval> | undefined;

	const modelLabel = (ctx: { model?: { provider: string; id: string } }): string | undefined =>
		ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

	/** Hold the event loop open while background children run (matters for print-mode parents). */
	const refreshKeepAlive = () => {
		if (!runtime) return;
		const pending = readRecords(getAgentDir()).some(
			(record) => record.parentRunId === runtime!.runId && !isTerminalStatus(record.status),
		);
		if (pending && !keepAlive) {
			keepAlive = setInterval(() => {}, 60000);
		} else if (!pending && keepAlive) {
			clearInterval(keepAlive);
			keepAlive = undefined;
		}
	};

	/** Deliver finished-but-undelivered child results to this session, debounced so parallel finishes batch into one message. */
	const scheduleDelivery = () => {
		if (deliveryTimer) return;
		deliveryTimer = setTimeout(() => {
			deliveryTimer = undefined;
			try {
				deliverResults();
			} catch {
				// Delivery is best-effort; the registry keeps the results either way.
			}
		}, 1000);
		deliveryTimer.unref?.();
	};

	const deliverResults = () => {
		if (!runtime) return;
		const agentDir = getAgentDir();
		const children = readRecords(agentDir).filter((record) => record.parentRunId === runtime!.runId);
		const pending = children.filter((record) => isTerminalStatus(record.status) && !record.resultsDelivered);
		if (pending.length === 0) return;
		for (const record of pending) {
			saveRecord(agentDir, { ...record, resultsDelivered: true, updatedAt: new Date().toISOString() });
		}
		const stillRunning = children.filter((record) => !isTerminalStatus(record.status)).length;
		const parts = pending.map((record) => {
			const head = `### ${record.name} — ${record.status}`;
			const body =
				record.status === "completed"
					? cap(record.latestText || "(no output)", RESULT_OUTPUT_CAP)
					: cap(record.error || record.status, RESULT_OUTPUT_CAP);
			return `${head}\n\n${body}`;
		});
		const intro =
			stillRunning > 0
				? `Subagent results (${pending.length} finished, ${stillRunning} still running):`
				: `All ${pending.length} subagent${pending.length === 1 ? "" : "s"} finished:`;
		pi.sendMessage(
			{
				customType: "subagent-results",
				content: `${intro}\n\n${parts.join("\n\n")}`,
				display: true,
				details: {},
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	pi.registerFlag("subagent-depth", {
		description: "Maximum recursive subagent depth (any non-negative integer)",
		type: "string",
	});

	pi.on("session_start", (_event, ctx) => {
		const runId = process.env.PI_SUBAGENT_RUN_ID || ctx.sessionManager.getSessionId();
		const rootRunId = process.env.PI_SUBAGENT_ROOT_ID || runId;
		try {
			runtime = {
				runId,
				rootRunId,
				depth: currentDepth(),
				settings: loadSettings({
					agentDir: getAgentDir(),
					cwd: ctx.cwd,
					projectTrusted: ctx.isProjectTrusted(),
					depthFlag: typeof pi.getFlag("subagent-depth") === "string" ? String(pi.getFlag("subagent-depth")) : undefined,
				}),
				projectTrusted: ctx.isProjectTrusted(),
			};
		} catch (error) {
			runtime = undefined;
			if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}

		if (ctx.mode !== "tui" || !runtime) return;

		mainModel = modelLabel(ctx);

		class SubagentEditor extends CustomEditor {
			private readonly keys: KeybindingsManager;

			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings);
				this.keys = keybindings;
			}

			handleInput(data: string): void {
				// Only steal Down when the cursor cannot move further down, so
				// multiline editing and history navigation keep working.
				if (!this.isShowingAutocomplete() && this.keys.matches(data, "tui.editor.cursorDown")) {
					const cursor = this.getCursor();
					const lines = this.getLines();
					const lastLine = lines.length - 1;
					if (cursor.line === lastLine && cursor.col === (lines[lastLine]?.length ?? 0) && panel?.open()) return;
				} else if (matchesKey(data, Key.down) && !this.isShowingAutocomplete()) {
					const cursor = this.getCursor();
					const lines = this.getLines();
					const lastLine = lines.length - 1;
					if (cursor.line === lastLine && cursor.col === (lines[lastLine]?.length ?? 0) && panel?.open()) return;
				}
				super.handleInput(data);
			}
		}

		let editor: SubagentEditor | undefined;
		ctx.ui.setWidget(
			"subagents",
			(tui, theme) => {
				if (!panel) {
					panel = new SubagentPanel(tui, theme, getAgentDir(), runtime!.runId);
					if (editor) panel.setEditor(editor);
					panel.setMainModel(mainModel);
				} else {
					panel.setTheme(theme);
				}
				return panel;
			},
			{ placement: "belowEditor" },
		);

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new SubagentEditor(tui, theme, keybindings);
			panel?.setEditor(editor);
			return editor;
		});
	});

	pi.registerMessageRenderer("subagent-results", (message, _options, _theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		return new Markdown(text, 1, 0, getMarkdownTheme());
	});

	const trackChild = (record: AgentRecord) => {
		refreshKeepAlive();
		if (isTerminalStatus(record.status)) scheduleDelivery();
	};

	pi.on("input", (event) => {
		// A new user turn cleans finished subagents out of the footer tree.
		// History (including transcripts) stays reviewable via /subagents.
		if (event.source !== "interactive") return;
		try {
			panel?.dismissFinished();
		} catch {
			// Footer cleanup must never block the user's message.
		}
	});

	pi.on("model_select", (_event, ctx) => {
		panel?.setMainModel(modelLabel(ctx));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		panel?.dispose();
		panel = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget("subagents", undefined);
		if (deliveryTimer) {
			clearTimeout(deliveryTimer);
			deliveryTimer = undefined;
		}
		if (keepAlive) {
			clearInterval(keepAlive);
			keepAlive = undefined;
		}
		// This pi process is going away: stop its background children so they
		// do not outlive the session that owns them.
		if (!runtime) return;
		const agentDir = getAgentDir();
		for (const record of readRecords(agentDir)) {
			if (record.parentRunId !== runtime.runId || isTerminalStatus(record.status)) continue;
			try {
				cancelSubagent(agentDir, record);
			} catch {
				// Best effort cleanup.
			}
		}
	});

	pi.registerCommand("subagents", {
		description: "Review the current agent's subagents, including finished ones",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!panel?.openReview()) ctx.ui.notify("This agent has no subagents yet", "info");
		},
	});

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn an isolated recursive Pi subagent that runs in the background and returns immediately. Omit model to use subagents.json defaultModel, or inherit the creating agent's active model. The child keeps running while you do other work; collect results with check_subagents (results also arrive automatically when you go idle).",
		promptSnippet: "Delegate focused independent work to an isolated recursive subagent running in the background",
		promptGuidelines: [
			"spawn_agent returns immediately; the child keeps running while you continue other work.",
			"Call check_subagents with wait:true before your final answer whenever spawned results matter, and use cancel_subagent to stop a runaway child.",
		],
		parameters: SpawnAgentSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!runtime) throw new Error("Subagent extension settings failed to initialize");
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const record = await startSubagent(
				{
					task: params.task,
					name: params.name,
					cwd: params.cwd ? resolve(ctx.cwd, params.cwd) : undefined,
					model: params.model,
					thinking: params.thinking,
					tools: params.tools,
				},
				{
					agentDir: getAgentDir(),
					parentRunId: runtime.runId,
					rootRunId: runtime.rootRunId,
					currentDepth: runtime.depth,
					settings: runtime.settings,
					parentModel,
					parentThinking: ctx.thinkingLevel,
					parentCwd: ctx.cwd,
					projectTrusted: runtime.projectTrusted,
					signal,
					onRecord: trackChild,
					onSettled: trackChild,
				},
			);
			return {
				content: [
					{
						type: "text",
						text: `Spawned subagent "${record.name}" (run ${shortId(record.runId)}, depth ${record.depth}/${record.maxDepth}, model ${record.model}). It is ${record.status === "queued" ? "queued" : "running in the background"} — continue with other work and call check_subagents (wait:true) to collect its result.`,
					},
				],
				details: { record },
			};
		},
		renderCall(args, theme) {
			const name = args.name?.trim() || args.task.replace(/\s+/g, " ").slice(0, 50);
			const model = args.model ? ` · ${args.model}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("spawn_agent"))} ${theme.fg("accent", name)}${theme.fg("dim", model)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const record = result.details?.record;
			if (!record) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new Text(
				`${theme.fg("accent", "◌")} ${theme.fg("accent", record.name)} ${theme.fg("dim", "· spawned in background")}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "check_subagents",
		label: "Check Subagents",
		description:
			"Check the status of this session's subagents and collect finished results. Use wait:true to block until they all finish (or the timeout elapses) before relying on their output.",
		promptSnippet: "Check or wait for background subagent results",
		parameters: CheckSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!runtime) throw new Error("Subagent extension settings failed to initialize");
			const agentDir = getAgentDir();
			const snapshot = () => descendantsOf(readRecords(agentDir), runtime!.runId);
			let rows = snapshot();
			if (params.wait) {
				const timeout = Math.min(Math.max(params.timeoutMs ?? 30000, 0), 300000);
				const deadline = Date.now() + timeout;
				while (rows.some((record) => !isTerminalStatus(record.status)) && Date.now() < deadline) {
					if (signal?.aborted) throw new Error("check_subagents was aborted");
					await new Promise((resolveWait) => setTimeout(resolveWait, 250));
					rows = snapshot();
				}
			}
			// Results returned here count as delivered, so auto-delivery does not
			// inject them again when the session goes idle.
			for (const record of rows) {
				if (isTerminalStatus(record.status) && !record.resultsDelivered) {
					saveRecord(agentDir, { ...record, resultsDelivered: true, updatedAt: new Date().toISOString() });
				}
			}
			if (rows.length === 0) {
				return { content: [{ type: "text", text: "No subagents have been spawned by this session." }], details: { records: [] } };
			}
			const running = rows.filter((record) => !isTerminalStatus(record.status));
			const sections = rows.map((record) => {
				const meta = `${record.model} · depth ${record.depth}/${record.maxDepth} · ${record.cwd}${record.runId ? ` · run ${shortId(record.runId)}` : ""}`;
				let body: string;
				if (isTerminalStatus(record.status)) {
					body =
						record.status === "completed"
							? cap(record.latestText || "(no output)", RESULT_OUTPUT_CAP)
							: cap(record.error || record.status, RESULT_OUTPUT_CAP);
				} else {
					body = `still running: ${record.currentTool || record.activity || record.status}`;
				}
				return `### ${record.name} — ${record.status}\n${meta}\n\n${body}`;
			});
			const summary =
				running.length > 0
					? `${rows.length - running.length}/${rows.length} finished, ${running.length} still running.`
					: `All ${rows.length} subagent${rows.length === 1 ? "" : "s"} finished.`;
			return {
				content: [{ type: "text", text: `${summary}\n\n${sections.join("\n\n")}` }],
				details: { records: rows },
			};
		},
	});

	pi.registerTool({
		name: "cancel_subagent",
		label: "Cancel Subagent",
		description: "Cancel a running or queued subagent of this session by run id, session id, or exact name.",
		promptSnippet: "Stop a running background subagent",
		parameters: CancelSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!runtime) throw new Error("Subagent extension settings failed to initialize");
			const agentDir = getAgentDir();
			const rows = descendantsOf(readRecords(agentDir), runtime.runId);
			const target = params.target.trim();
			const matches = rows.filter(
				(record) => record.runId === target || record.sessionId === target || record.name === target,
			);
			if (matches.length === 0) {
				const names = rows.map((record) => record.name).join(", ") || "none";
				throw new Error(`No subagent matches "${target}". Known subagents: ${names}.`);
			}
			if (matches.length > 1) {
				throw new Error(`"${target}" is ambiguous; matches: ${matches.map((record) => `${record.name} (${shortId(record.runId)})`).join(", ")}`);
			}
			const record = matches[0]!;
			if (isTerminalStatus(record.status)) {
				return { content: [{ type: "text", text: `${record.name} already finished (${record.status}).` }], details: { record } };
			}
			const cancelled = cancelSubagent(agentDir, record);
			trackChild(cancelled);
			return { content: [{ type: "text", text: `Cancelled ${cancelled.name}.` }], details: { record: cancelled } };
		},
	});

	// Keep killPidTree referenced for session_shutdown cleanup paths that go
	// through cancelSubagent; exported for tests and future direct use.
	void killPidTree;
}
