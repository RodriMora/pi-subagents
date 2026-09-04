import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { applyChildEvent, type ParsedChildState } from "./events.ts";
import {
	clearRecordPid,
	descendantsOf,
	isProcessAlive,
	isRecordCancelled,
	isTerminalStatus,
	readRecords,
	saveRecord,
	withRecordLock,
} from "./registry.ts";
import { EMPTY_USAGE, type AgentRecord, type SpawnAgentInput, type SubagentSettings } from "./types.ts";

const STDERR_LIMIT = 4000;
const TERMINATION_WAIT_MS = 5000;

export class ConcurrencyGate {
	private running = 0;
	private waiters: Array<{ limit: number; resolve: (release: () => void) => void; reject: (error: Error) => void }> = [];

	/** True when a spawn with this limit would have to queue. */
	isFull(limit: number): boolean {
		return limit !== -1 && this.running >= limit;
	}

	acquire(limit: number, signal?: AbortSignal): Promise<() => void> {
		if (limit === -1 || this.running < limit) {
			this.running++;
			return Promise.resolve(this.releaseOnce());
		}
		return new Promise((resolve, reject) => {
			const waiter = { limit, resolve, reject };
			this.waiters.push(waiter);
			if (signal) {
				const abort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(new Error("Subagent was aborted while waiting for a concurrency slot"));
				};
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
		});
	}

	private releaseOnce(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.running--;
			this.drain();
		};
	}

	private drain(): void {
		for (let index = 0; index < this.waiters.length; index++) {
			const waiter = this.waiters[index]!;
			if (waiter.limit !== -1 && this.running >= waiter.limit) continue;
			this.waiters.splice(index, 1);
			this.running++;
			waiter.resolve(this.releaseOnce());
			index--;
		}
	}
}

export const gate = new ConcurrencyGate();

interface LiveChild {
	sendMessage(message: string): Promise<void>;
}

interface OwnedChild {
	pid: number;
	closed: Promise<void>;
	terminate(): Promise<void>;
}

const liveChildren = new Map<string, LiveChild>();
const ownedChildren = new Map<string, OwnedChild>();
const childRuns = new Map<string, Promise<void>>();
const runAbortControllers = new Map<string, AbortController>();
const startingChildren = new Map<string, Promise<LiveChild | null>>();
const resolveStarting = new Map<string, (child: LiveChild | null) => void>();

/** Send directly when this process owns the target child. */
export async function sendSubagentMessage(record: AgentRecord, message: string): Promise<boolean> {
	const startup = startingChildren.get(record.runId);
	const live = startup ? await startup : liveChildren.get(record.runId);
	if (!live) return false;
	await live.sendMessage(message);
	return true;
}

export interface SpawnContext {
	agentDir: string;
	parentRunId: string;
	rootRunId: string;
	currentDepth: number;
	settings: SubagentSettings;
	parentModel?: string;
	parentThinking: string;
	parentCwd: string;
	projectTrusted: boolean;
	persistAfterSettled?: boolean;
	signal?: AbortSignal;
	onRecord?: (record: AgentRecord) => void;
	onUiRequest?: (record: AgentRecord, request: any) => Promise<Record<string, unknown> | void>;
	/** Fired once per child when it reaches a terminal state. */
	onSettled?: (record: AgentRecord) => void;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Test hook: run a fake child instead of the real pi binary.
	const override = process.env.PI_SUBAGENT_COMMAND;
	if (override) return { command: process.execPath, args: [override, ...args] };

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args }
		: { command: process.execPath, args };
}

function compactName(input: SpawnAgentInput): string {
	const value = input.name?.trim() || input.task.replace(/\s+/g, " ").trim().slice(0, 60) || "subagent";
	return value.slice(0, 100);
}

function ensureDirectory(value: string): string {
	const cwd = resolve(value);
	let valid = false;
	try {
		valid = statSync(cwd).isDirectory();
	} catch {
		// Report one stable error below.
	}
	if (!valid) throw new Error(`Subagent working directory does not exist: ${cwd}`);
	return cwd;
}

interface ProcessIdentity {
	pid: number;
	startTime: string;
	processGroup: number;
}

function readProcessIdentity(pid: number): ProcessIdentity | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return undefined;
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		const processGroup = Number(fields[2]);
		const startTime = fields[19];
		if (!Number.isInteger(processGroup) || !startTime) return undefined;
		return { pid, processGroup, startTime };
	} catch {
		return undefined;
	}
}

function sameProcess(identity: ProcessIdentity): boolean {
	const current = readProcessIdentity(identity.pid);
	return !!current && current.startTime === identity.startTime;
}

function processGroupSnapshot(group: number): ProcessIdentity[] {
	if (process.platform !== "linux") return [];
	const members: ProcessIdentity[] = [];
	try {
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name)) continue;
			const identity = readProcessIdentity(Number(name));
			if (identity?.processGroup === group) members.push(identity);
		}
	} catch {
		// /proc may be unavailable or restricted.
	}
	return members;
}

function signalPidTree(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

/**
 * Stop a process tree not owned by this Pi process. On Linux, delayed SIGKILL
 * targets only the original process-group members whose PID start time still
 * matches. Other platforms avoid a delayed PID-only kill that could hit a
 * reused PID.
 */
export function killPidTree(pid: number, expectedStartTime?: string): void {
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
		return;
	}
	const leader = readProcessIdentity(pid);
	if (expectedStartTime && leader?.startTime !== expectedStartTime) return;
	const members = processGroupSnapshot(pid);
	signalPidTree(pid, "SIGTERM");
	if (members.length === 0) return;
	setTimeout(() => {
		for (const member of members) {
			if (!sameProcess(member)) continue;
			try {
				process.kill(member.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}, 3000).unref();
}

function waitTimeout(ms: number): Promise<void> {
	return new Promise((resolveWait) => {
		const timer = setTimeout(resolveWait, ms);
		timer.unref();
	});
}

function ownChild(runId: string, child: ChildProcessWithoutNullStreams): OwnedChild {
	const pid = child.pid;
	if (!pid) throw new Error("Subagent process started without a PID");
	let closed = false;
	let resolveClosed!: () => void;
	const closedPromise = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	child.once("close", () => {
		closed = true;
		resolveClosed();
	});
	const identity = readProcessIdentity(pid);
	let terminating: Promise<void> | undefined;
	const owned: OwnedChild = {
		pid,
		closed: closedPromise,
		terminate() {
			if (terminating) return terminating;
			terminating = (async () => {
				if (process.platform === "win32") {
					spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
				} else {
					signalPidTree(pid, "SIGTERM");
					const timer = setTimeout(() => {
						// If Node has not observed process exit and the identity still
						// matches, the process-group id cannot have been recycled.
						if (
							!closed &&
							child.exitCode === null &&
							child.signalCode === null &&
							(!identity || sameProcess(identity))
						) {
							signalPidTree(pid, "SIGKILL");
						}
					}, 3000);
					timer.unref();
					closedPromise.finally(() => clearTimeout(timer));
				}
				await Promise.race([closedPromise, waitTimeout(TERMINATION_WAIT_MS)]);
			})();
			return terminating;
		},
	};
	ownedChildren.set(runId, owned);
	closedPromise.finally(() => {
		if (ownedChildren.get(runId) === owned) ownedChildren.delete(runId);
	});
	return owned;
}

/** Force-cancel a running or queued child and all of its descendants. */
export function cancelSubagent(agentDir: string, record: AgentRecord): AgentRecord {
	const cancelOne = (item: AgentRecord): AgentRecord => {
		let updated!: AgentRecord;
		let pid: number | undefined;
		let owned: OwnedChild | undefined;
		withRecordLock(agentDir, item.runId, () => {
			const latest = readRecords(agentDir).find((candidate) => candidate.runId === item.runId) ?? item;
			const now = new Date().toISOString();
			updated = saveRecord(agentDir, {
				...latest,
				status: "cancelled",
				activity: "cancelled",
				currentTool: undefined,
				error: latest.error ?? "Cancelled",
				finishedAt: latest.finishedAt ?? now,
				updatedAt: now,
			});
			owned = ownedChildren.get(item.runId);
			pid = updated.pid;
			runAbortControllers.get(item.runId)?.abort();
		});
		if (owned) void owned.terminate();
		else if (pid && isProcessAlive(pid)) killPidTree(pid, updated.pidStartTime);
		return updated;
	};
	for (const child of descendantsOf(readRecords(agentDir), record.runId).reverse()) {
		if (!isTerminalStatus(child.status)) cancelOne(child);
	}
	return cancelOne(record);
}

/** Stop and await children owned by this process. Queued run loops also drain. */
export async function terminateOwnedSubagents(runIds: readonly string[]): Promise<void> {
	const ids = new Set(runIds);
	const terminations: Promise<void>[] = [];
	for (const runId of ids) {
		const owned = ownedChildren.get(runId);
		if (owned) terminations.push(owned.terminate());
	}
	await Promise.all(terminations);
	const runs = [...ids].map((runId) => childRuns.get(runId)).filter((run): run is Promise<void> => !!run);
	await Promise.race([Promise.all(runs).then(() => {}), waitTimeout(TERMINATION_WAIT_MS)]);
}

async function findSessionFile(cwd: string, sessionId: string): Promise<string | undefined> {
	try {
		return (await SessionManager.list(cwd)).find((session) => session.id === sessionId)?.path;
	} catch {
		return undefined;
	}
}

/**
 * Launch a subagent without waiting for it. Validates everything the caller
 * should see as a tool error (depth, model, cwd), persists the record, and
 * returns immediately. The process runs in the background; progress lands in
 * the registry and onSettled fires when it reaches a terminal state.
 */
export async function startSubagent(input: SpawnAgentInput, context: SpawnContext): Promise<AgentRecord> {
	if (context.signal?.aborted) throw new Error("Subagent spawn was aborted");
	if (context.currentDepth >= context.settings.maxDepth) {
		throw new Error(`Subagent depth limit reached (${context.currentDepth}/${context.settings.maxDepth})`);
	}
	const queued = gate.isFull(context.settings.maxConcurrency);
	const runId = randomUUID();
	const cwd = ensureDirectory(input.cwd ? resolve(context.parentCwd, input.cwd) : context.parentCwd);
	const model = input.model?.trim() || context.settings.defaultModel || context.parentModel;
	if (!model) {
		throw new Error("No subagent model is available; choose a parent model or configure defaultModel");
	}
	const thinking = input.thinking?.trim() || context.settings.defaultThinking || context.parentThinking;
	const now = new Date().toISOString();
	const record: AgentRecord = {
		version: 1,
		runId,
		parentRunId: context.parentRunId,
		rootRunId: context.rootRunId,
		sessionId: runId,
		name: compactName(input),
		task: input.task,
		cwd,
		model,
		thinking,
		tools: input.tools,
		depth: context.currentDepth + 1,
		maxDepth: context.settings.maxDepth,
		status: queued ? "queued" : "starting",
		activity: queued ? "waiting for a concurrency slot" : "starting",
		usage: { ...EMPTY_USAGE },
		startedAt: now,
		updatedAt: now,
	};
	Object.assign(record, saveRecord(context.agentDir, record));
	context.onRecord?.(record);

	startingChildren.set(record.runId, new Promise((resolveChild) => resolveStarting.set(record.runId, resolveChild)));
	const runAbort = new AbortController();
	runAbortControllers.set(record.runId, runAbort);
	const run = runSubagentProcess(input, context, record, runAbort.signal)
		.catch((error) => {
			if (isRecordCancelled(context.agentDir, record.runId)) {
				const onDisk = readRecords(context.agentDir).find((candidate) => candidate.runId === record.runId);
				if (onDisk) Object.assign(record, onDisk);
				return;
			}
			if (isTerminalStatus(record.status)) return;
			record.status = "failed";
			record.activity = "failed";
			record.error = error instanceof Error ? error.message : String(error);
			record.finishedAt = record.finishedAt ?? new Date().toISOString();
			record.updatedAt = record.finishedAt;
			Object.assign(record, saveRecord(context.agentDir, record));
			context.onRecord?.(record);
			context.onSettled?.(record);
		})
		.finally(() => {
			if (runAbortControllers.get(record.runId) === runAbort) runAbortControllers.delete(record.runId);
			resolveStarting.get(record.runId)?.(isTerminalStatus(record.status) ? null : liveChildren.get(record.runId) ?? null);
			resolveStarting.delete(record.runId);
			startingChildren.delete(record.runId);
		});
	childRuns.set(record.runId, run);
	void run.finally(() => {
		if (childRuns.get(record.runId) === run) childRuns.delete(record.runId);
	});
	return record;
}

async function runSubagentProcess(
	input: SpawnAgentInput,
	context: SpawnContext,
	record: AgentRecord,
	runSignal: AbortSignal,
): Promise<void> {
	let release: (() => void) | undefined;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const publish = () => {
		Object.assign(record, saveRecord(context.agentDir, record));
		context.onRecord?.(record);
	};
	const publishClosed = () => {
		Object.assign(record, clearRecordPid(context.agentDir, record));
		context.onRecord?.(record);
	};
	const diskCancelled = () => isRecordCancelled(context.agentDir, record.runId);
	const schedulePublish = (immediate = false) => {
		if (immediate) {
			if (flushTimer) clearTimeout(flushTimer);
			flushTimer = undefined;
			publish();
			return;
		}
		if (!flushTimer) {
			flushTimer = setTimeout(() => {
				flushTimer = undefined;
				publish();
			}, 200);
			flushTimer.unref?.();
		}
	};
	const settle = (status: AgentRecord["status"], detail?: string) => {
		if (diskCancelled()) status = "cancelled";
		record.status = status;
		record.activity = status;
		record.currentTool = undefined;
		if (detail) record.error = detail;
		record.finishedAt = new Date().toISOString();
		record.updatedAt = record.finishedAt;
		publish();
		context.onSettled?.(record);
	};

	try {
		release = await gate.acquire(context.settings.maxConcurrency, runSignal);
		if (record.status === "cancelled" || diskCancelled()) return;

		const systemPrompt = `You are subagent "${record.name}" at depth ${record.depth}/${record.maxDepth}. Complete delegated tasks and return concise, self-contained results.`;
		const args = [
			"--mode",
			"rpc",
			"--session-id",
			record.runId,
			"--name",
			record.name,
			"--model",
			record.model,
			"--append-system-prompt",
			systemPrompt,
		];
		if (record.thinking) args.push("--thinking", record.thinking);
		if (input.tools?.length) args.push("--tools", input.tools.join(","));
		if (context.projectTrusted && (record.cwd === context.parentCwd || record.cwd.startsWith(`${context.parentCwd}/`))) {
			args.push("--approve");
		}

		let stderr = "";
		let buffer = "";
		let requestId = 0;
		let initialSettled = false;
		let resolveInitial!: () => void;
		const initialDone = new Promise<void>((resolveDone) => {
			resolveInitial = resolveDone;
		});
		const state: ParsedChildState = { finalText: "" };
		const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
		const continuationReleases: Array<() => void> = [];

		const invocation = getPiInvocation(args);
		let child: ChildProcessWithoutNullStreams | undefined;
		withRecordLock(context.agentDir, record.runId, () => {
			if (diskCancelled()) return;
			child = spawn(invocation.command, invocation.args, {
				cwd: record.cwd,
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_SUBAGENT_RUN_ID: record.runId,
					PI_SUBAGENT_PARENT_ID: context.parentRunId,
					PI_SUBAGENT_ROOT_ID: context.rootRunId,
					PI_SUBAGENT_DEPTH: String(record.depth),
					PI_SUBAGENT_MAX_DEPTH: String(context.settings.maxDepth),
				},
			});
			child.on("error", (error) => {
				stderr = `${stderr}\n${error.message}`.slice(-STDERR_LIMIT);
			});
			ownChild(record.runId, child);
			record.pid = child.pid;
			record.pidStartTime = child.pid ? readProcessIdentity(child.pid)?.startTime : undefined;
			record.status = "starting";
			record.activity = "starting";
			publish();
		});
		if (!child) return;
		const launchedChild = child;

		const send = (command: Record<string, unknown>): Promise<any> => {
			const id = `subagent-${++requestId}`;
			return new Promise((resolveCommand, rejectCommand) => {
				pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
				if (!launchedChild.stdin.write(`${JSON.stringify({ ...command, id })}\n`)) {
					launchedChild.stdin.once("drain", () => {});
				}
			});
		};

		const liveChild: LiveChild = {
			async sendMessage(message: string) {
				const followUp = isTerminalStatus(record.status);
				const releaseTurn = followUp ? await gate.acquire(context.settings.maxConcurrency) : undefined;
				if (releaseTurn) continuationReleases.push(releaseTurn);
				try {
					await send({
						type: "prompt",
						message,
						...(followUp ? {} : { streamingBehavior: "steer" }),
					});
				} catch (error) {
					if (releaseTurn) {
						const index = continuationReleases.indexOf(releaseTurn);
						if (index >= 0) continuationReleases.splice(index, 1);
						releaseTurn();
					}
					throw error;
				}
			},
		};
		liveChildren.set(record.runId, liveChild);

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "response" && typeof event.id === "string") {
				const request = pending.get(event.id);
				if (!request) return;
				pending.delete(event.id);
				if (event.success) request.resolve(event);
				else request.reject(new Error(event.error || `${event.command || "RPC command"} failed`));
				return;
			}
			if (event.type === "extension_ui_request" && typeof event.id === "string") {
				const dialog = ["select", "confirm", "input", "editor"].includes(event.method);
				if (context.onUiRequest) {
					void context.onUiRequest(record, event).then(
						(response) => {
							if (dialog) launchedChild.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, ...(response ?? { cancelled: true }) })}\n`);
						},
						() => {
							if (dialog) launchedChild.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
						},
					);
				} else if (dialog) {
					launchedChild.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
				}
				return;
			}
			const important = applyChildEvent(record, state, event);
			if (event.type === "agent_settled") {
				if (initialSettled) continuationReleases.shift()?.();
				if (record.status === "cancelled" || diskCancelled()) {
					const onDisk = readRecords(context.agentDir).find((r) => r.runId === record.runId);
					if (onDisk) Object.assign(record, onDisk);
				} else if (state.stopReason === "aborted") {
					settle("cancelled", "Subagent was aborted");
				} else if (state.stopReason === "error") {
					settle("failed", state.errorMessage || stderr.trim() || "Subagent failed");
				} else {
					record.latestText = state.finalText || record.latestText || "(no output)";
					settle("completed");
				}
				if (!initialSettled) {
					initialSettled = true;
					resolveInitial();
				}
				if (context.persistAfterSettled === false) launchedChild.stdin.end();
				return;
			}
			schedulePublish(important);
		};

		launchedChild.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				processLine(line);
			}
		});
		launchedChild.stderr.on("data", (chunk) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
		});
		launchedChild.stdin.on("error", () => {});
		launchedChild.on("close", (code) => {
			liveChildren.delete(record.runId);
			for (const releaseTurn of continuationReleases.splice(0)) releaseTurn();
			if (buffer.trim()) processLine(buffer);
			for (const request of pending.values()) request.reject(new Error(stderr.trim() || `Subagent exited with code ${code ?? 1}`));
			pending.clear();
			const wasCancelled = record.status === "cancelled" || diskCancelled();
			if (wasCancelled) {
				const onDisk = readRecords(context.agentDir).find((candidate) => candidate.runId === record.runId);
				if (onDisk) Object.assign(record, onDisk);
			}
			let newlySettled = false;
			if (!wasCancelled && !isTerminalStatus(record.status)) {
				record.status = "failed";
				record.activity = "failed";
				record.currentTool = undefined;
				record.error = stderr.trim() || `Subagent exited with code ${code ?? 1}`;
				record.finishedAt = new Date().toISOString();
				record.updatedAt = record.finishedAt;
				newlySettled = true;
			}
			record.pid = undefined;
			publishClosed();
			if (newlySettled) context.onSettled?.(record);
			if (!initialSettled) {
				initialSettled = true;
				resolveInitial();
			}
		});

		try {
			const stateResponse = await send({ type: "get_state" });
			if (typeof stateResponse.data?.sessionFile === "string") {
				record.sessionFile = stateResponse.data.sessionFile;
				publish();
			} else {
				record.sessionFile = await findSessionFile(record.cwd, record.runId);
			}
			await send({ type: "prompt", message: input.task });
			resolveStarting.get(record.runId)?.(liveChild);
			await initialDone;
		} catch (error) {
			launchedChild.stdin.end();
			const owned = ownedChildren.get(record.runId);
			if (owned) void owned.terminate();
			throw error;
		}
	} finally {
		if (flushTimer) clearTimeout(flushTimer);
		release?.();
	}
}
