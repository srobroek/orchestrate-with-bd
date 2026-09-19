import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { observeLifecycle, recordDispatch } from "../src/dispatch";
import { clearLedgerRootCache, registerLedger } from "../src/tools/ledger";

type Bead = { id: string; status: string; assignee?: string; lease_expires_at?: string; metadata?: Record<string, unknown>; dependencies?: Array<{ id: string; dependency_type?: string }> };
type Tool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> };

function setup(bead: Bead, options: { version?: string; reclaim?: boolean; postUnclaimAssignee?: string; swapBeforeUnclaimTo?: string } = {}) {
	const root = mkdtempSync(join(tmpdir(), "orc-release-"));
	mkdirSync(join(root, ".beads"));
	writeFileSync(join(root, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: "server", dolt_database: "test" }));
	const run = { id: "R", issue_type: "epic", status: "in_progress", assignee: "omp/release-test", lease_expires_at: "2999-01-01T00:00:00Z", metadata: { run: { owner: "omp/release-test", root: "R", bound_at: "2026-01-01T00:00:00Z" } } };
	let state = { ...bead, dependencies: [...(bead.dependencies ?? []), { id: "R", dependency_type: "parent-child" }] };
	const commands: string[][] = [];
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		const args = cmd.slice(1).filter(arg => arg !== "--json");
		// The ledger also asks git for the canonical root; only the `bd` protocol is under test.
		if (cmd[0] === "bd" && args[0] !== "--version") commands.push(args);
		const [verb] = args;
		let payload: unknown = state;
		if (verb === "list") payload = [run];
		if (verb === "show") payload = args[1] === "R" ? run : state;
		let exitCode = 0;
		if (verb === "--version") payload = `bd version ${options.version ?? "1.2.2"}`;
		if (verb === "comment") payload = null;
		if (verb === "reclaim" && options.reclaim === true) {
			state.assignee = undefined;
			state.status = "open";
			payload = { count: 1 };
		}
		if (verb === "update") {
			const guardIndex = args.indexOf("--if-assignee");
			const expected = guardIndex >= 0 ? args[guardIndex + 1] : undefined;
			if (expected !== undefined && expected !== state.assignee) exitCode = 13;
			if (exitCode === 0) {
				const assigneeIndex = args.indexOf("--assignee");
				if (assigneeIndex >= 0) state.assignee = args[assigneeIndex + 1] || undefined;
				const statusIndex = args.indexOf("--status");
				if (statusIndex >= 0) state.status = args[statusIndex + 1] as string;
			}
		}
		if (verb === "update" && options.swapBeforeUnclaimTo !== undefined) {
			state.assignee = options.swapBeforeUnclaimTo;
			exitCode = 13;
		}
		if (verb === "unclaim") {
			if (options.swapBeforeUnclaimTo !== undefined) {
				state.assignee = options.swapBeforeUnclaimTo;
				exitCode = 13;
			} else {
				state.assignee = undefined;
				state.status = "open";
				if (options.postUnclaimAssignee !== undefined) state.assignee = options.postUnclaimAssignee;
			}
		}
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); } });
		return { stdout: stream, stderr: new Response(exitCode === 13 ? "assignee mismatch" : "").body, exited: Promise.resolve(exitCode), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
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

afterEach(() => {
	// A fresh temp root per test, but the cached root must not outlive its mocked `Bun.spawn`.
	clearLedgerRootCache();
});


describe("orc_release guards and evidence", () => {
	test("holder mismatch refuses before any write", async () => {
		const f = setup({ id: "b-1", status: "in_progress", assignee: "actual" });
		const result = await f.tool.execute("id", { bead: "b-1", holder: "stale", reason: "stale holder observed" }, undefined, undefined, f.ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("holder changed: now actual");
		expect(f.commands.filter(command => command[0] === "update")).toHaveLength(0);
	});

	test("holder swap during update CAS preserves and reports the new holder", async () => {
		const f = setup({ id: "b-race", status: "in_progress", assignee: "observed" }, { swapBeforeUnclaimTo: "new-holder" });
		recordDispatch({ toolCallId: "dispatch-race", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-race"]], workers: new Map() });
		observeLifecycle({ id: "worker-race", agent: "orc-implementer", status: "aborted", parentToolCallId: "dispatch-race", index: 0 });
		const result = await f.tool.execute("id", { bead: "b-race", holder: "observed", reason: "holder changed during release", liveAgents: [] }, undefined, undefined, f.ctx);
		expect(result.content[0]?.text).toContain("lease-lost: current assignee new-holder");
		expect(result.isError).toBe(true);
		expect(f.state.assignee).toBe("new-holder");
		expect(f.commands.filter(command => command[0] === "update")).toHaveLength(1);
		expect(f.commands.at(-1)?.[0]).toBe("show");
	});

	test("own holder releases through CAS update", async () => {
		const f = setup({ id: "b-2", status: "in_progress", assignee: "omp/release-test" });
		const result = await f.tool.execute("id", { bead: "b-2", holder: "omp/release-test", reason: "recover own stale claim" }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ released: true, tier: "own" });
		expect(f.state.assignee).toBeUndefined();
		expect(f.state.status).toBe("open");
		expect(f.commands.some(command => command[0] === "update" && command.includes("--if-assignee"))).toBe(true);
	});

	test("unknown holder without force refuses and issues no update", async () => {
		const f = setup({ id: "b-3", status: "in_progress", assignee: "other" });
		const result = await f.tool.execute("id", { bead: "b-3", holder: "other", reason: "recover without evidence" }, undefined, undefined, f.ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("no liveness evidence");
		expect(f.commands.filter(command => command[0] === "update")).toHaveLength(0);
	});

	test("reclaims an expired native lease when owner is not live", async () => {
		const f = setup({ id: "b-expired", status: "in_progress", assignee: "dead-worker", lease_expires_at: "2020-01-01T00:00:00Z" }, { version: "1.3.0", reclaim: true });
		const result = await f.tool.execute("id", { bead: "b-expired", holder: "dead-worker", reason: "lease expired", liveAgents: [] }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ released: true, tier: "reclaimed" });
		expect(f.commands.some(command => command[0] === "update" && command.includes("--if-assignee"))).toBe(true);
	});

	test("force releases unknown holder through CAS update", async () => {
		const f = setup({ id: "b-3", status: "in_progress", assignee: "other" });
		const result = await f.tool.execute("id", { bead: "b-3", holder: "other", reason: "human confirmed no live worker", force: true }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ released: true, tier: "forced" });
		expect(f.commands.some(command => command[0] === "update" && command.includes("--force"))).toBe(true);
	});

	test("terminal worker releases through native CAS", async () => {
		const f = setup({ id: "b-5", status: "in_progress", assignee: "other" });
		recordDispatch({ toolCallId: "dispatch-aborted", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-5"]], workers: new Map() });
		observeLifecycle({ id: "worker-aborted", agent: "orc-implementer", status: "aborted", parentToolCallId: "dispatch-aborted", index: 0 });
		const result = await f.tool.execute("id", { bead: "b-5", holder: "other", reason: "worker ended before release" }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ released: true, tier: "worker-ended:aborted" });
		expect(f.commands.some(command => command[0] === "update" && command.includes("--if-assignee"))).toBe(true);
	});

	test("a worker still started refuses before update", async () => {
		const f = setup({ id: "b-4", status: "in_progress", assignee: "other" });
		recordDispatch({ toolCallId: "dispatch-live", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-4"]], workers: new Map() });
		observeLifecycle({ id: "worker-1", agent: "orc-implementer", status: "started", parentToolCallId: "dispatch-live", index: 0 });
		const result = await f.tool.execute("id", { bead: "b-4", holder: "other", reason: "worker should block release" }, undefined, undefined, f.ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("still running");
		expect(f.commands.filter(command => command[0] === "update")).toHaveLength(0);
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
		expect(f.commands.filter(command => command[0] === "update")).toHaveLength(0);
	});

	test("a re-dispatch with no lifecycle frame yet leaves no evidence, so release refuses", async () => {
		const f = setup({ id: "b-8", status: "in_progress", assignee: "other" });
		recordDispatch({ toolCallId: "dispatch-ended", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-8"]], workers: new Map() });
		observeLifecycle({ id: "worker-ended", agent: "orc-implementer", status: "aborted", parentToolCallId: "dispatch-ended", index: 0 });
		recordDispatch({ toolCallId: "dispatch-pending", sessionId: "release-test", cwd: f.ctx.cwd, actor: "omp/release-test", beadsByIndex: [["b-8"]], workers: new Map() });
		const result = await f.tool.execute("id", { bead: "b-8", holder: "other", reason: "old evidence must not release" }, undefined, undefined, f.ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("no liveness evidence");
		expect(f.commands.filter(command => command[0] === "update")).toHaveLength(0);
	});
});
