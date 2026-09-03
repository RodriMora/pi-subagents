// Fake pi child for integration tests. Emits a JSON event stream like
// `pi --mode json -p`, controlled by env vars:
//   FAKE_TEXT       final assistant text (default "fake done")
//   FAKE_DELAY_MS   sleep before finishing (default 0)
//   FAKE_EXIT       process exit code (default 0); 1 also sets stopReason "error"
//   FAKE_SESSION_ID session header id (default "fake-session")
// Ignores all argv (the runner passes pi flags; we don't need them).
const text = process.env.FAKE_TEXT ?? "fake done";
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
const exitCode = Number(process.env.FAKE_EXIT ?? 0);
const sessionId = process.env.FAKE_SESSION_ID ?? "fake-session";

const line = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

line({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() });
line({ type: "agent_start" });
line({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
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

if (delay > 0) {
	setTimeout(() => process.exit(exitCode), delay);
} else {
	process.exit(exitCode);
}
