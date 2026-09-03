import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { applyChildEvent, toolUsage, type ParsedChildState } from "./events.ts";
import { isProcessAlive, readRecords, saveRecord } from "./registry.ts";
import { EMPTY_USAGE, type AgentRecord, type SpawnAgentInput, type SubagentSettings } from "./types.ts";

const STDERR_LIMIT = 4000;
const OUTPUT_LIMIT = 50 * 1024;

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
	signal?: AbortSignal;
	onRecord?: (record: AgentRecord) => void;
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

function boundedOutput(text: string): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= OUTPUT_LIMIT) return text;
	let result = text.slice(-OUTPUT_LIMIT);
	while (Buffer.byteLength(result, "utf8") > OUTPUT_LIMIT) result = result.slice(1);
	return `[Earlier output omitted; full transcript remains in the child session.]\n\n${result}`;
}

export function killPidTree(pid: number): void {
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
	setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}, 3000).unref();
}

/** Force-cancel a running or queued child: kill its process tree and persist the state. */
export function cancelSubagent(agentDir: string, record: AgentRecord): AgentRecord {
	if (record.pid && isProcessAlive(record.pid)) killPidTree(record.pid);
	const updated: AgentRecord = {
		...record,
		status: "cancelled",
		activity: "cancelled",
		error: record.error ?? "Cancelled",
		finishedAt: record.finishedAt ?? new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	saveRecord(agentDir, updated);
	return updated;
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
		task: input.task.slice(0, 1000),
		cwd,
		model,
		thinking,
		depth: context.currentDepth + 1,
		maxDepth: context.settings.maxDepth,
		status: queued ? "queued" : "starting",
		activity: queued ? "waiting for a concurrency slot" : "starting",
		usage: { ...EMPTY_USAGE },
		startedAt: now,
		updatedAt: now,
	};
	saveRecord(context.agentDir, record);
	context.onRecord?.(record);

	void runSubagentProcess(input, context, record).catch((error) => {
		if (record.status === "cancelled") return;
		record.status = "failed";
		record.activity = "failed";
		record.error = error instanceof Error ? error.message : String(error);
		record.finishedAt = record.finishedAt ?? new Date().toISOString();
		record.updatedAt = record.finishedAt;
		saveRecord(context.agentDir, record);
		context.onRecord?.(record);
		context.onSettled?.(record);
	});
	return record;
}

async function runSubagentProcess(
	input: SpawnAgentInput,
	context: SpawnContext,
	record: AgentRecord,
): Promise<void> {
	let promptDir: string | null = null;
	let release: (() => void) | undefined;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const publish = () => {
		saveRecord(context.agentDir, record);
		context.onRecord?.(record);
	};
	const diskCancelled = () =>
		readRecords(context.agentDir).find((r) => r.runId === record.runId)?.status === "cancelled";
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
		record.status = status;
		record.activity = status;
		if (detail) record.error = detail;
		record.finishedAt = record.finishedAt ?? new Date().toISOString();
		record.updatedAt = record.finishedAt;
		publish();
		context.onSettled?.(record);
	};

	try {
		release = await gate.acquire(context.settings.maxConcurrency);
		// A cancel may have landed while this child waited for a slot; the disk
		// record is authoritative because cancelSubagent runs in a different copy.
		if (record.status === "cancelled" || diskCancelled()) return;

		const promptDirCreated = mkdtempSync(join(tmpdir(), "pi-subagent-"));
		promptDir = promptDirCreated;
		const promptPath = join(promptDirCreated, "task.md");
		writeFileSync(
			promptPath,
			`You are subagent "${record.name}" at depth ${record.depth}/${record.maxDepth}. Complete this delegated task and return a concise, self-contained result.\n\n${input.task}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);

		const args = ["--mode", "json", "-p", "--session-id", record.runId, "--name", record.name, "--model", record.model];
		if (record.thinking) args.push("--thinking", record.thinking);
		if (input.tools?.length) args.push("--tools", input.tools.join(","));
		if (context.projectTrusted && (record.cwd === context.parentCwd || record.cwd.startsWith(`${context.parentCwd}/`))) {
			args.push("--approve");
		}
		args.push(`@${promptPath}`);

		let stderr = "";
		let buffer = "";
		const state: ParsedChildState = { finalText: "" };

		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: record.cwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PI_SUBAGENT_RUN_ID: record.runId,
				PI_SUBAGENT_PARENT_ID: context.parentRunId,
				PI_SUBAGENT_ROOT_ID: context.rootRunId,
				PI_SUBAGENT_DEPTH: String(record.depth),
				PI_SUBAGENT_MAX_DEPTH: String(context.settings.maxDepth),
			},
		});
		record.pid = child.pid;
		record.status = "starting";
		record.activity = "starting";
		publish();

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const important = applyChildEvent(record, state, JSON.parse(line));
				schedulePublish(important);
			} catch {
				// Ignore non-JSON diagnostics on stdout.
			}
		};
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (chunk) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
		});

		const exitCode = await new Promise<number>((resolveExit) => {
			child.on("close", (code) => resolveExit(code ?? 1));
			child.on("error", (error) => {
				stderr = `${stderr}\n${error.message}`.slice(-STDERR_LIMIT);
				resolveExit(1);
			});
		});
		if (buffer.trim()) processLine(buffer);
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		record.sessionFile = await findSessionFile(record.cwd, record.runId);

		if (record.status === "cancelled" || diskCancelled()) {
			// cancelSubagent owns the terminal state; never overwrite it with
			// a failure just because the killed process exited non-zero.
			const onDisk = readRecords(context.agentDir).find((r) => r.runId === record.runId);
			if (onDisk) Object.assign(record, onDisk);
			context.onSettled?.(record);
			return;
		}
		if (state.stopReason === "aborted") {
			settle("cancelled", "Subagent was aborted");
			return;
		}
		if (exitCode !== 0 || state.stopReason === "error") {
			settle("failed", state.errorMessage || stderr.trim() || `Subagent exited with code ${exitCode}`);
			return;
		}
		record.latestText = state.finalText || record.latestText || "(no output)";
		settle("completed");
		void boundedOutput;
	} finally {
		if (flushTimer) clearTimeout(flushTimer);
		if (promptDir) rmSync(promptDir, { recursive: true, force: true });
		release?.();
	}
}
