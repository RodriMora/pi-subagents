import { existsSync } from "node:fs";
import {
	AssistantMessageComponent,
	SessionManager,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";

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

/**
 * Build Pi's transcript components from the complete active branch. Unlike the
 * model context, this intentionally keeps messages from before compaction so
 * inspection always reaches the parent's first delegated prompt.
 */
export function buildTranscript(sessionFile: string, tui: TUI, cwd: string): Component[] | null {
	if (!existsSync(sessionFile)) return null;
	let entries: any[];
	try {
		entries = SessionManager.open(sessionFile, undefined, cwd).getBranch();
	} catch {
		return null;
	}

	const components: Component[] = [];
	const pending = new Map<string, ToolExecutionComponent>();
	for (const entry of entries) {
		try {
			if (entry.type === "compaction") {
				components.push(new Text(`— compacted ${entry.tokensBefore ?? "earlier"} tokens —`, 0, 0));
				continue;
			}
			if (entry.type === "branch_summary") {
				const summary = typeof entry.summary === "string" ? entry.summary.split("\n")[0] : "branch summary";
				components.push(new Text(`— ${summary} —`, 0, 0));
				continue;
			}
			if (entry.type === "custom_message") {
				const text = userText(entry.content);
				if (entry.display && text.trim()) components.push(new Text(text, 1, 0));
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message?.role === "user") {
				const text = userText(message.content);
				if (text.trim()) components.push(new UserMessageComponent(text));
			} else if (message?.role === "assistant") {
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
			} else if (message?.role === "toolResult") {
				const comp = message.toolCallId ? pending.get(message.toolCallId) : undefined;
				if (comp) {
					try {
						comp.updateResult({
							content: message.content ?? [],
							details: message.details,
							isError: !!message.isError,
						});
					} catch {
						// Keep the call rendering if a historical result shape changed.
					}
					pending.delete(message.toolCallId);
				}
			}
		} catch {
			// One bad historical entry must not hide the rest of the transcript.
		}
	}
	return components;
}
