// Fake Pi child for integration tests. Supports the small RPC subset used by
// spawn-agent.ts and makes no API calls.
const text = process.env.FAKE_TEXT ?? "fake done";
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
const exitCode = Number(process.env.FAKE_EXIT ?? 0);
const sessionId = process.env.FAKE_SESSION_ID ?? process.env.PI_SUBAGENT_RUN_ID ?? "fake-session";

if (process.env.FAKE_ARGS_DIR && process.env.PI_SUBAGENT_RUN_ID) {
	const fs = require("node:fs");
	fs.mkdirSync(process.env.FAKE_ARGS_DIR, { recursive: true });
	fs.writeFileSync(
		require("node:path").join(process.env.FAKE_ARGS_DIR, `${process.env.PI_SUBAGENT_RUN_ID}.json`),
		JSON.stringify(process.argv.slice(2)),
	);
}

const line = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let runCount = 0;
function run(message, kind = "prompt") {
	const currentRun = ++runCount;
	line({ type: "agent_start" });
	const finish = () => {
		const output = String(message).startsWith("ui:") ? message : kind === "steer" || currentRun > 1 ? `steered: ${message}` : text;
		line({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: output }],
				api: "fake",
				provider: "fake",
				model: "fake-model",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
				stopReason: exitCode === 0 ? "stop" : "error",
				...(exitCode === 0 ? {} : { errorMessage: "fake failure" }),
				timestamp: Date.now(),
			},
		});
		line({ type: "agent_end", messages: [] });
		line({ type: "agent_settled" });
	};
	if (delay > 0) setTimeout(finish, delay);
	else finish();
}

let pendingUi = false;
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const raw = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (!raw.trim()) continue;
		let command;
		try { command = JSON.parse(raw); } catch { continue; }
		if (command.type === "get_state") {
			line({ type: "response", id: command.id, command: "get_state", success: true, data: {
				sessionId, thinkingLevel: "off", isStreaming: false, isCompacting: false,
				steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
				autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
			} });
		} else if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
			if (command.message === "reject") {
				line({ type: "response", id: command.id, command: command.type, success: false, error: "fake rejection" });
				continue;
			}
			line({ type: "response", id: command.id, command: command.type, success: true });
			if (command.message === "ui-request") {
				pendingUi = true;
				line({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Choose", options: ["approved", "denied"] });
			} else {
				run(command.message, command.streamingBehavior ? "steer" : command.type);
			}
		} else if (command.type === "abort" || command.type === "clear_queue") {
			line({ type: "response", id: command.id, command: command.type, success: true,
				...(command.type === "clear_queue" ? { data: { steering: [], followUp: [] } } : {}) });
		} else if (command.type === "extension_ui_response") {
			if (pendingUi) {
				pendingUi = false;
				run(`ui: ${command.value ?? "cancelled"}`);
			}
		} else {
			line({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported fake RPC command" });
		}
	}
});
