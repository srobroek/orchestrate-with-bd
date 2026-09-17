import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerLedger } from "../src/tools/ledger";

type Bead = { id: string; status: string; assignee?: string; lease_expires_at?: string };
type Tool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> };

function setup(version: string, bead: Bead) {
	const root = mkdtempSync(join(tmpdir(), "orc-claim-"));
	mkdirSync(join(root, ".beads"));
	writeFileSync(join(root, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: "server", dolt_database: "test" }));
	const state = { ...bead };
	const commands: string[][] = [];
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		const args = cmd.slice(1).filter(arg => arg !== "--json");
		commands.push(args);
		const [verb] = args;
		let payload: unknown = state;
		let exitCode = 0;
		let stderr = "";
		if (verb === "--version") payload = `bd version ${version}`;
		if (verb === "update") {
			const assigneeGuard = args.indexOf("--if-assignee");
			const statusGuard = args.indexOf("--if-status");
			if ((assigneeGuard !== -1 && (state.assignee ?? "") !== args[assigneeGuard + 1]) || (statusGuard !== -1 && state.status !== args[statusGuard + 1])) {
				exitCode = 13;
				stderr = "guard mismatch";
			} else if (args.includes("--claim")) {
				state.assignee = "omp/claim-test";
				state.status = "in_progress";
			} else {
				state.assignee = args[args.indexOf("--assignee") + 1];
				state.status = args[args.indexOf("--status") + 1];
				state.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
			}
			payload = state;
		}
		if (verb === "heartbeat") {
			state.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
			payload = state;
		}
		if (verb === "show") payload = state;
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); } });
		return { stdout: stream, stderr: new Response(stderr).body, exited: Promise.resolve(exitCode), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
	}) as unknown as typeof Bun.spawn);
	let zod: unknown;
	zod = new Proxy(() => zod, { get: () => zod, apply: () => zod });
	let tool: Tool | undefined;
	const pi = { zod, registerTool: (definition: Tool & { name?: string }) => { if (definition.name === "orc_claim") tool = definition; } } as unknown as ExtensionAPI;
	registerLedger(pi);
	if (!tool) throw new Error("claim tool was not registered");
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "claim-test" } };
	return { tool, ctx, commands, state, spawn };
}

afterEach(() => { /* each spy is restored by Bun's test harness */ });

describe("orc_claim native CAS and fallback", () => {
	test("uses both native guards and heartbeats a 1.3 claim", async () => {
		const f = setup("1.3.0", { id: "b-1", status: "open" });
		const result = await f.tool.execute("id", { bead: "b-1" }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ claimed: true, bead: { assignee: "omp/claim-test" } });
		expect(f.commands[1]).toEqual(["update", "b-1", "--assignee", "omp/claim-test", "--status", "in_progress", "--if-assignee", "", "--if-status", "open"]);
		expect(f.commands.map(command => command[0])).toEqual(["--version", "update", "show", "heartbeat"]);
	});

	test("reports a native guard loss without a second write", async () => {
		const f = setup("1.3.0", { id: "b-2", status: "in_progress", assignee: "other" });
		const result = await f.tool.execute("id", { bead: "b-2" }, undefined, undefined, f.ctx);
		expect(result.isError).toBeFalsy();
		expect(result.details).toMatchObject({ claimed: false, bead: { assignee: "other" } });
		expect(f.commands.map(command => command[0])).toEqual(["--version", "update", "show"]);
	});

	test("keeps the old claim/readback path on a pre-1.3 client", async () => {
		const f = setup("1.2.2", { id: "b-old", status: "open" });
		const result = await f.tool.execute("id", { bead: "b-old" }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ claimed: true, bead: { assignee: "omp/claim-test" } });
		expect(f.commands.map(command => command[0])).toEqual(["--version", "update", "show"]);
		expect(f.commands[1]).toEqual(["update", "b-old", "--claim"]);
	});
});
