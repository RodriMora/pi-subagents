import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SubagentMessage {
	version: 1;
	targetRunId: string;
	rootRunId: string;
	text: string;
	createdAt: string;
}

function inboxDir(agentDir: string, runId: string): string {
	return join(agentDir, "subagents", "inbox", runId.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

/** Atomically queue a message for a live subagent process. */
export function queueSubagentMessage(agentDir: string, message: Omit<SubagentMessage, "version" | "createdAt">): void {
	const dir = inboxDir(agentDir, message.targetRunId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const id = `${Date.now()}-${randomUUID()}`;
	const target = join(dir, `${id}.json`);
	const temporary = `${target}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify({ ...message, version: 1, createdAt: new Date().toISOString() })}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(temporary, target);
}

/** Consume queued messages in creation order. Invalid files are discarded. */
export function consumeSubagentMessages(agentDir: string, runId: string, rootRunId: string): SubagentMessage[] {
	const dir = inboxDir(agentDir, runId);
	if (!existsSync(dir)) return [];
	const messages: SubagentMessage[] = [];
	for (const name of readdirSync(dir).filter((item) => item.endsWith(".json")).sort()) {
		const path = join(dir, name);
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SubagentMessage>;
			if (
				value.version === 1 &&
				value.targetRunId === runId &&
				value.rootRunId === rootRunId &&
				typeof value.text === "string" &&
				value.text.trim() &&
				typeof value.createdAt === "string"
			) {
				messages.push(value as SubagentMessage);
			}
		} catch {
			// A malformed command must not wedge the inbox.
		} finally {
			rmSync(path, { force: true });
		}
	}
	return messages;
}
