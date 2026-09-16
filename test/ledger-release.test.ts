import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { observeLifecycle, recordDispatch } from "../src/dispatch";
import { registerLedger } from "../src/tools/ledger";

type Bead = { id: string; status: string; assignee?: string; metadata?: Record<string, unknown> };
type Tool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> };

function setup(bead: Bead, options: { postUpdateAssignee?: string } = {}) {
	const root = mkdtempSync(join(tmpdir(), "orc-release-"));
	mkdirSync(join(root, ".beads"));
	writeFileSync(join(root, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: "server", dolt_database: "test" }));
	let state = { ...bead };
	const commands: string[][] = [];
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		const args = cmd.slice(1).filter(arg => arg !== "--json");
		commands.push(args);
		const [verb] = args;
		let payload: unknown = state;
		if (verb === "comment") payload = null;
		if (verb === "update") {
			for (let i = 2; i < args.length; i++) {
				if (args[i] === "--assignee") state.assignee = args[++i] || undefined;
				if (args[i] === "--status") state.status = args[++i] as string;
				if (args[i] === "--set-metadata") {
					const [key, value] = (args[++i] as string).split("=");
					state.metadata = { ...state.metadata, [key]: value };
				}
			}
            if (options.postUpdateAssignee !== undefined) state.assignee = options.postUpdateAssignee;
		}
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); } });
		return { stdout: stream, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
	}) as unknown as typeof Bun.spawn);
	let zod: unknown;
	zod = new Proxy(() => zod, { get: () => zod, apply: () => zod });
	let tool: Tool | undefined;
	const pi = { zod, registerTool: (definition: Tool & { name?: string }) => { if (definition.name === "orc_release") tool = definition; } } as unknown as ExtensionAPI;
	registerLedger(pi);
	if (!tool) throw new Error("release tool was not registered");
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "release-test" } };
	return { tool, ctx, commands, spawn, state };
}

afterEach(() => { /* each spy is restored by Bun's test harness */ });


describe("orc_release guards and evidence", () => {
	test("holder mismatch refuses before any write", async () => {
		const f = setup({ id: "b-1", status: "in_progress", assignee: "actual" });
		const result = await f.tool.execute("id", { bead: "b-1", holder: "stale", reason: "stale holder observed" }, undefined, undefined, f.ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("holder changed: now actual");
		expect(f.commands).toHaveLength(1);
	});

	test("own holder releases and records metadata", async () => {
		const f = setup({ id: "b-2", status: "in_progress", assignee: "omp/release-test" });
		const result = await f.tool.execute("id", { bead: "b-2", holder: "omp/release-test", reason: "recover own stale claim" }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ released: true, tier: "own" });
		expect(f.state.assignee).toBeUndefined();
		expect(f.state.status).toBe("open");
		expect(f.state.metadata?.released_from).toBe("omp/release-test");
		expect(f.commands.map(command => command[0])).toEqual(["show", "comment", "update", "show"]);
	});

    test("unknown holder without force refuses and issues no update", async () => {
        const f = setup({ id: "b-3", status: "in_progress", assignee: "other" });
        const result = await f.tool.execute("id", { bead: "b-3", holder: "other", reason: "recover without evidence" }, undefined, undefined, f.ctx);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("no liveness evidence");
        expect(f.commands).toHaveLength(1);
        expect(f.commands.some(command => command[0] === "update")).toBe(false);
    });

    test("force releases unknown holder and records takeover", async () => {
        const f = setup({ id: "b-3", status: "in_progress", assignee: "other" });
        const result = await f.tool.execute("id", { bead: "b-3", holder: "other", reason: "human confirmed no live worker", force: true }, undefined, undefined, f.ctx);
        expect(result.details).toMatchObject({ released: true, tier: "forced" });
        expect(f.commands.some(command => command[0] === "comment" && command[2]?.startsWith("release (forced)"))).toBe(true);
    });

    test("terminal worker releases with worker-ended evidence", async () => {
        const f = setup({ id: "b-5", status: "in_progress", assignee: "other" });
        recordDispatch({ toolCallId: "dispatch-aborted", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-5"]], workers: new Map() });
        observeLifecycle({ id: "worker-aborted", agent: "orc-implementer", status: "aborted", parentToolCallId: "dispatch-aborted", index: 0 });
        const result = await f.tool.execute("id", { bead: "b-5", holder: "other", reason: "worker ended before release" }, undefined, undefined, f.ctx);
        expect(result.details).toMatchObject({ released: true, tier: "worker-ended:aborted" });
        expect(f.commands.some(command => command[0] === "comment" && command[2]?.startsWith("release (worker-ended:aborted)"))).toBe(true);
    });

    test("readback still assigned reports unsuccessful release", async () => {
        const f = setup({ id: "b-6", status: "in_progress", assignee: "other" }, { postUpdateAssignee: "other" });
        const result = await f.tool.execute("id", { bead: "b-6", holder: "other", reason: "forced readback probe", force: true }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ released: false, reason: expect.stringContaining("readback still shows other") });
    });

	test("a worker still started refuses before update", async () => {
		const f = setup({ id: "b-4", status: "in_progress", assignee: "other" });
		recordDispatch({ toolCallId: "dispatch-live", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-4"]], workers: new Map() });
		observeLifecycle({ id: "worker-1", agent: "orc-implementer", status: "started", parentToolCallId: "dispatch-live", index: 0 });
		const result = await f.tool.execute("id", { bead: "b-4", holder: "other", reason: "worker should block release" }, undefined, undefined, f.ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("still running");
		expect(f.commands).toHaveLength(1);
	});

	test("a live re-dispatch outranks an earlier ended worker for the same bead", async () => {
		const f = setup({ id: "b-7", status: "in_progress", assignee: "other" });
		recordDispatch({ toolCallId: "dispatch-old", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-7"]], workers: new Map() });
		observeLifecycle({ id: "worker-old", agent: "orc-implementer", status: "aborted", parentToolCallId: "dispatch-old", index: 0 });
		recordDispatch({ toolCallId: "dispatch-new", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-7"]], workers: new Map() });
		observeLifecycle({ id: "worker-new", agent: "orc-implementer", status: "started", parentToolCallId: "dispatch-new", index: 0 });
		const result = await f.tool.execute("id", { bead: "b-7", holder: "other", reason: "stale evidence must not release" }, undefined, undefined, f.ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("worker-new");
		expect(f.commands).toHaveLength(1);
	});

	test("a re-dispatch with no lifecycle frame yet leaves no evidence, so release refuses", async () => {
		const f = setup({ id: "b-8", status: "in_progress", assignee: "other" });
		recordDispatch({ toolCallId: "dispatch-ended", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-8"]], workers: new Map() });
		observeLifecycle({ id: "worker-ended", agent: "orc-implementer", status: "aborted", parentToolCallId: "dispatch-ended", index: 0 });
		recordDispatch({ toolCallId: "dispatch-pending", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-8"]], workers: new Map() });
		const result = await f.tool.execute("id", { bead: "b-8", holder: "other", reason: "old evidence must not release" }, undefined, undefined, f.ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("no liveness evidence");
		expect(f.commands).toHaveLength(1);
	});
});
