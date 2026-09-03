import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { descendantsOf, isTerminalStatus, readRecords, saveRecord } from "./registry.ts";
import { buildTranscript, discoverSessionFile } from "./transcript.ts";
import type { AgentRecord } from "./types.ts";

const MAX_FOOTER_ROWS = 8;
const MAX_TRANSCRIPT_LINES = 150;
const SCROLL_STEP = 5;

function shortPath(path: string): string {
	const home = homedir();
	return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function elapsed(record: AgentRecord): string {
	const end = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
	const seconds = Math.max(0, Math.floor((end - Date.parse(record.startedAt)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

export function isTerminal(record: AgentRecord): boolean {
	return isTerminalStatus(record.status);
}

function statusIcon(record: AgentRecord): string {
	switch (record.status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "✗";
		case "idle":
			return "◐";
		case "queued":
			return "◌";
		default:
			return "●";
	}
}

function statusColor(record: AgentRecord): "success" | "error" | "warning" | "accent" {
	if (record.status === "completed") return "success";
	if (record.status === "failed" || record.status === "cancelled") return "error";
	if (record.status === "idle") return "warning";
	return "accent";
}

/** Strip OSC control sequences (e.g. semantic-prompt markers) that would skew width math. */
function clean(line: string): string {
	return line.replace(/\][^\x07]*\x07/g, "");
}

export class SubagentPanel implements Component, Focusable {
	focused = false;
	private records: AgentRecord[] = [];
	private visible: AgentRecord[] = [];
	private selected = 0;
	private detail = false;
	private reviewing = false;
	private editor?: Component;
	private mainModel?: string;
	private transcript: { key: string; components: Component[] } | null = null;
	private transcriptFile?: string;
	private lastDiscover = 0;
	private scrollOffset = 0;
	private detailRunId?: string;
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private theme: Theme,
		private readonly agentDir: string,
		private readonly currentRunId: string,
	) {
		this.refresh();
		this.timer = setInterval(() => {
			const before = JSON.stringify(this.records);
			this.refresh();
			if (before !== JSON.stringify(this.records)) this.tui.requestRender();
		}, 250);
		this.timer.unref?.();
	}

	setEditor(editor: Component): void {
		this.editor = editor;
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
	}

	setMainModel(model: string | undefined): void {
		this.mainModel = model;
	}

	/** Hide finished subagents from the footer. Runs when the user starts a new turn. */
	dismissFinished(): number {
		this.refresh();
		let count = 0;
		for (const record of this.records) {
			if (!isTerminal(record) || record.footerDismissed) continue;
			try {
				saveRecord(this.agentDir, { ...record, footerDismissed: true, updatedAt: new Date().toISOString() });
				count++;
			} catch {
				// One bad write must not block the rest.
			}
		}
		if (count > 0) this.refresh();
		return count;
	}

	/** Down-arrow entry: only non-dismissed subagents. */
	open(): boolean {
		this.refresh();
		if (this.visible.length === 0) return false;
		this.reviewing = false;
		this.detail = false;
		this.selected = Math.min(this.selected, this.visible.length - 1);
		this.tui.setFocus(this);
		this.tui.requestRender();
		return true;
	}

	/** /subagents entry: full history including dismissed. */
	openReview(): boolean {
		this.refresh();
		if (this.records.length === 0) return false;
		this.reviewing = true;
		this.detail = false;
		this.selected = Math.min(this.selected, this.records.length - 1);
		this.tui.setFocus(this);
		this.tui.requestRender();
		return true;
	}

	private rows(): AgentRecord[] {
		return this.reviewing ? this.records : this.visible;
	}

	private close(): void {
		this.detail = false;
		this.reviewing = false;
		this.tui.setFocus(this.editor ?? null);
		this.tui.requestRender();
	}

	private refresh(): void {
		const selectedId = this.rows()[this.selected]?.runId;
		this.records = descendantsOf(readRecords(this.agentDir), this.currentRunId);
		this.visible = this.records.filter((record) => !record.footerDismissed);
		const rows = this.rows();
		const restored = selectedId ? rows.findIndex((record) => record.runId === selectedId) : -1;
		this.selected = restored >= 0 ? restored : Math.min(this.selected, Math.max(0, rows.length - 1));
		if (this.focused && rows.length === 0) this.close();
	}

	handleInput(data: string): void {
		// Left arrow (Esc as an alias) always goes back one level:
		// detail -> list -> editor.
		if (matchesKey(data, Key.left) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.detail) {
				this.detail = false;
				this.scrollOffset = 0;
				this.tui.requestRender();
			} else {
				this.close();
			}
			return;
		}
		if (this.detail) {
			if (matchesKey(data, Key.enter)) {
				this.detail = false;
				this.scrollOffset = 0;
				this.tui.requestRender();
			} else if (matchesKey(data, Key.up)) {
				this.scrollOffset = Math.min(this.scrollOffset + SCROLL_STEP, 10000);
				this.tui.requestRender();
			} else if (matchesKey(data, Key.down)) {
				this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP);
				this.tui.requestRender();
			}
			return;
		}
		// Enter or Right arrow opens the selected subagent.
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			if (this.rows().length > 0) {
				this.detail = true;
				this.scrollOffset = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.selected === 0) this.close();
			else this.selected--;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(this.rows().length - 1, this.selected + 1);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		this.refresh();
		if (this.focused && this.detail) return this.renderDetail(width);
		return this.renderTree(width);
	}

	private mainLine(): string {
		const main = this.theme.fg("accent", this.theme.bold("main"));
		return this.mainModel ? `${main} ${this.theme.fg("dim", `· ${this.mainModel}`)}` : main;
	}

	private rowBody(record: AgentRecord): string {
		const icon = this.theme.fg(statusColor(record), statusIcon(record));
		const activity = record.currentTool || record.activity || record.status;
		const sep = this.theme.fg("dim", " · ");
		const segments = [
			record.model ? this.theme.fg("dim", record.model) : undefined,
			this.theme.fg("dim", activity),
			...(isTerminal(record) ? [this.theme.fg("dim", elapsed(record))] : []),
		].filter((segment): segment is string => Boolean(segment));
		return `${icon} ${record.name}  ${segments.join(sep)}`;
	}

	private renderTree(width: number): string[] {
		// One tree for every state: the footer while typing, the focused list
		// after Down, and /subagents history. Only selection and hints differ.
		const rows = this.rows();
		if (rows.length === 0) return [];
		const byId = new Map(rows.map((r) => [r.runId, r]));
		const isLast = (record: AgentRecord): boolean => {
			const siblings = rows.filter((r) => r.parentRunId === record.parentRunId);
			return siblings[siblings.length - 1]?.runId === record.runId;
		};
		const ancestorChain = (record: AgentRecord): AgentRecord[] => {
			const chain: AgentRecord[] = [];
			let current = record;
			while (current.parentRunId !== this.currentRunId && byId.has(current.parentRunId)) {
				current = byId.get(current.parentRunId)!;
				chain.unshift(current);
			}
			return chain;
		};
		const selectedRunId = this.focused ? rows[this.selected]?.runId : undefined;
		const start = this.focused
			? Math.max(0, Math.min(rows.length - MAX_FOOTER_ROWS, this.selected - Math.floor(MAX_FOOTER_ROWS / 2)))
			: 0;
		const window = rows.slice(start, start + MAX_FOOTER_ROWS);
		const lines = [this.mainLine() + (this.reviewing ? this.theme.fg("dim", "  · history") : "")];
		if (start > 0) lines.push(this.theme.fg("dim", "  …"));
		for (const record of window) {
			const prefix =
				ancestorChain(record).map((a) => (isLast(a) ? "   " : "│  ")).join("") +
				(isLast(record) ? "└─ " : "├─ ");
			const line = truncateToWidth(prefix + this.rowBody(record), width, "…");
			if (this.focused && record.runId === selectedRunId) {
				lines.push(this.theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line)))));
			} else {
				lines.push(line);
			}
		}
		if (start + window.length < rows.length) {
			lines.push(this.theme.fg("dim", `… +${rows.length - start - window.length} more`));
		}
		lines.push(this.theme.fg("dim", this.focused ? "↑/↓ select   Enter/→ open   ← back" : "↓ inspect"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private transcriptComponents(record: AgentRecord): Component[] | null {
		const file = record.sessionFile ?? this.transcriptFile;
		if (!file) {
			const now = Date.now();
			if (now - this.lastDiscover > 2000) {
				this.lastDiscover = now;
				void discoverSessionFile(record.cwd, record.sessionId).then((found) => {
					if (found && this.records[this.selected]?.runId === record.runId) {
						this.transcriptFile = found;
						this.tui.requestRender();
					}
				});
			}
			return null;
		}
		if (record.sessionFile) this.transcriptFile = record.sessionFile;
		let key: string;
		try {
			const stat = statSync(file);
			key = `${file}:${stat.mtimeMs}:${stat.size}`;
		} catch {
			return null;
		}
		if (!this.transcript || this.transcript.key !== key) {
			const components = buildTranscript(file, this.tui, record.cwd);
			this.transcript = components ? { key, components } : null;
		}
		return this.transcript?.components ?? null;
	}

	private legacyDetail(record: AgentRecord, width: number): string[] {
		const lines = [
			this.theme.fg("muted", "Task"),
			...wrapTextWithAnsi(record.task, Math.max(1, width)).slice(0, 3),
			"",
			this.theme.fg("muted", "Current activity"),
			truncateToWidth(record.currentTool || record.activity || record.status, width, "…"),
		];
		if (record.latestText) {
			lines.push("", this.theme.fg("muted", "Latest output"), ...wrapTextWithAnsi(record.latestText, Math.max(1, width)).slice(-4));
		}
		if (record.error) lines.push("", this.theme.fg("error", truncateToWidth(record.error, width, "…")));
		return lines;
	}

	private renderDetail(width: number): string[] {
		const record = this.rows()[this.selected];
		if (!record) return [];
		if (this.detailRunId !== record.runId) {
			this.detailRunId = record.runId;
			this.scrollOffset = 0;
			this.transcript = null;
		}
		const icon = this.theme.fg(statusColor(record), statusIcon(record));
		const lines = [
			truncateToWidth(`${icon} ${this.theme.bold(record.name)} ${this.theme.fg("dim", `· ${record.status} · ${elapsed(record)}`)}`, width),
			this.theme.fg("dim", `${record.model}${record.thinking !== "off" ? `:${record.thinking}` : ""} · depth ${record.depth}/${record.maxDepth} · ${shortPath(record.cwd)}`),
			"",
		];
		const components = this.transcriptComponents(record);
		if (!components || components.length === 0) {
			lines.push(...this.legacyDetail(record, width));
		} else {
			const body: string[] = [];
			for (const component of components) {
				for (const line of component.render(width)) body.push(clean(line));
			}
			const total = body.length;
			const end = Math.max(0, total - this.scrollOffset);
			const start = Math.max(0, end - MAX_TRANSCRIPT_LINES);
			if (start > 0) lines.push(this.theme.fg("dim", `… ${start} earlier lines · ↑ scroll`));
			lines.push(...body.slice(start, end));
			if (this.scrollOffset > 0) lines.push(this.theme.fg("dim", `… ${total - end} newer lines · ↓ follow`));
		}
		lines.push("", this.theme.fg("dim", "↑/↓ scroll   ← back"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}
