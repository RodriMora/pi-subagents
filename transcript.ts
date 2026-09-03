import { readFileSync } from "node:fs";
import {
	AssistantMessageComponent,
	SessionManager,
	ToolExecutionComponent,
	UserMessageComponent,
	buildContextEntries,
	parseSessionEntries,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";

const MAX_MESSAGES = 60;

export async function discoverSessionFile(cwd: string, sessionId: string): Promise<string | undefined> {
	try {
		return (await SessionManager.list(cwd)).find((session) => session.id === sessionId)?.path;
	} catch {
		return undefined;
	}
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part?.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function hasVisibleAssistantContent(message: any): boolean {
	return (
		Array.isArray(message?.content) &&
		message.content.some((part: any) => part?.type === "text" || part?.type === "thinking")
	);
}

function toMessages(entries: any[]): any[] {
	let active = entries;
	try {
		active = buildContextEntries(entries);
	} catch {
		// Fall back to the raw entry list; the cap below keeps it bounded.
	}
	const messages: any[] = [];
	for (const entry of active) {
		try {
			messages.push(...sessionEntryToContextMessages(entry));
		} catch {
			// One bad entry must not hide the whole transcript.
		}
	}
	return messages;
}

/**
 * Build Pi's own transcript components for a child session file, so inspecting
 * a subagent looks like looking at the main agent. Returns null when the file
 * is missing or unreadable (callers fall back to the bounded summary).
 */
export function buildTranscript(sessionFile: string, tui: TUI, cwd: string): Component[] | null {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return null;
	}
	let entries: any[];
	try {
		entries = parseSessionEntries(content);
	} catch {
		return null;
	}
	const recent = toMessages(entries).slice(-MAX_MESSAGES);
	const components: Component[] = [];
	const pending = new Map<string, ToolExecutionComponent>();
	for (const message of recent) {
		try {
			if (message.role === "user") {
				const text = userText(message.content);
				if (text.trim()) components.push(new UserMessageComponent(text));
			} else if (message.role === "assistant") {
				if (hasVisibleAssistantContent(message)) components.push(new AssistantMessageComponent(message));
				for (const part of message.content ?? []) {
					if (part?.type !== "toolCall") continue;
					const comp = new ToolExecutionComponent(
						part.name ?? "tool",
						part.id ?? `call-${components.length}`,
						part.arguments ?? {},
						undefined,
						undefined,
						tui,
						cwd,
					);
					comp.markExecutionStarted();
					comp.setArgsComplete();
					if (part.id) pending.set(part.id, comp);
					components.push(comp);
				}
			} else if (message.role === "toolResult") {
				const comp = message.toolCallId ? pending.get(message.toolCallId) : undefined;
				if (comp) {
					try {
						comp.updateResult({
							content: message.content ?? [],
							details: message.details,
							isError: !!message.isError,
						});
					} catch {
						// Keep the partial rendering.
					}
					pending.delete(message.toolCallId);
				}
			} else if (message.role === "compactionSummary" || message.role === "branchSummary") {
				const summary = typeof message.summary === "string" ? message.summary.split("\n")[0] : "";
				if (summary.trim()) components.push(new Text(`— ${summary} —`, 0, 0));
			}
		} catch {
			// One bad message must not hide the whole transcript.
		}
	}
	return components;
}
