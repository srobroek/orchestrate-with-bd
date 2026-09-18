import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, edgesOf } from "../src/bd";
import orchestrateWithBd, { routeDispatch, runHeader } from "../src/index";
import { namedBeads, observeLifecycle, recordDispatch, waveGate, workerFor } from "../src/dispatch";
import { mentionsOrchestrate } from "../src/keyword";

type EventHandler = (event: unknown, ctx?: unknown) => unknown;

interface Registered {
	events: string[];
	busChannels: string[];
	commands: string[];
	tools: string[];
	eventHandlers: Map<string, EventHandler[]>;
	label?: string;
	userMessages: string[];
}

/**
 * A factory must only register during load. Calling a runtime action such as
 * `sendMessage` at load time throws `ExtensionRuntimeNotInitializedError`, so this
 * stub makes every runtime action explode and asserts the factory never reaches one.
 */
function recordingApi(): { pi: ExtensionAPI; seen: Registered } {
	const seen: Registered = { events: [], busChannels: [], commands: [], tools: [], eventHandlers: new Map(), userMessages: [] };
	const explode = (name: string) => () => {
		throw new Error(`runtime action ${name} called during load`);
	};
	// The zod builder is only used to DESCRIBE parameter schemas at registration
	// time; a self-returning proxy stands in for every chained call.
	const zodStub: unknown = new Proxy(() => zodStub, { get: () => zodStub, apply: () => zodStub });
	const stub = {
		setLabel: (label: string) => {
			seen.label = label;
		},
		on: (event: string, handler: EventHandler) => {
			seen.events.push(event);
			const handlers = seen.eventHandlers.get(event) ?? [];
			handlers.push(handler);
			seen.eventHandlers.set(event, handlers);
		},
		events: { on: (channel: string) => { seen.busChannels.push(channel); } },
		registerCommand: (name: string) => {
			seen.commands.push(name);
		},
		registerTool: (definition: { name: string }) => {
			seen.tools.push(definition.name);
		},
		zod: zodStub,
		logger: { error: () => {}, debug: () => {}, warn: () => {}, info: () => {} },
		sendMessage: explode("sendMessage"),
		sendUserMessage: (content: string) => {
			seen.userMessages.push(content);
		},
		appendEntry: explode("appendEntry"),
		getAllTools: explode("getAllTools"),
		getActiveTools: explode("getActiveTools"),
	};
	return { pi: stub as unknown as ExtensionAPI, seen };
}
function fixture(mode: string | null): string {
	const root = mkdtempSync(join(tmpdir(), "orc-index-"));
	if (mode !== null) {
		mkdirSync(join(root, ".beads"));
		writeFileSync(join(root, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: mode, dolt_database: "fx" }));
	}
	return root;
}

describe("extension factory", () => {
	test("registers exactly four events and ten tools, no commands, and reaches no runtime action", () => {
		const { pi, seen } = recordingApi();
		expect(() => orchestrateWithBd(pi)).not.toThrow();
		expect(seen.label).toBe("Orchestrate with bd");
		expect([...new Set(seen.events)].sort()).toEqual(["before_agent_start", "session_start", "todo_reminder", "tool_call"]);
		expect(seen.busChannels).toEqual(["task:subagent:lifecycle"]);
		expect(seen.commands).toEqual([]);
		expect(seen.tools.sort()).toEqual([
			"orc_bind",
			"orc_bot_review_probe",
			"orc_bot_review_request",
			"orc_claim",
			"orc_conflict_probe",
			"orc_decide",
			"orc_finish",
			"orc_release",
			"orc_review_round_policy",
			"orc_status",
		]);
	});
});

describe("tool_call actor injection", () => {
	async function bash(input: Record<string, unknown>, sessionId: string): Promise<unknown> {
		const { pi, seen } = recordingApi();
		orchestrateWithBd(pi);
		const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => sessionId } };
		let result: unknown;
		for (const handler of seen.eventHandlers.get("tool_call") ?? []) result = await handler({ type: "tool_call", toolName: "bash", input }, ctx);
		return result;
	}

	test("adds the calling session's actor to a bash call and keeps one the call already names", async () => {
		expect(await bash({ command: "bd list" }, "sess-1")).toEqual({ input: { command: "bd list", env: { BEADS_ACTOR: "omp/sess-1" } } });
		expect(await bash({ command: "bd list", env: { FOO: "1" } }, "sess-2")).toEqual({
			input: { command: "bd list", env: { FOO: "1", BEADS_ACTOR: "omp/sess-2" } },
		});
		expect(await bash({ command: "bd list", env: { BEADS_ACTOR: "human" } }, "sess-3")).toBeUndefined();
	});

	test("two sessions in one process get two actors", async () => {
		const a = (await bash({ command: "bd list" }, "a")) as { input: { env: { BEADS_ACTOR: string } } };
		const b = (await bash({ command: "bd list" }, "b")) as { input: { env: { BEADS_ACTOR: string } } };
		expect(a.input.env.BEADS_ACTOR).not.toBe(b.input.env.BEADS_ACTOR);
	});
});


describe("workerFor dispatch evidence", () => {
	const record = (sessionId: string, toolCallId: string, beadsByIndex: string[][]) => ({
		toolCallId,
		sessionId,
		cwd: "/tmp",
		actor: `omp/${sessionId}`,
		beadsByIndex,
		workers: new Map(),
	});

	test("returns the worker from a single dispatch", () => {
		const sessionId = "worker-single";
		const dispatch = record(sessionId, "dispatch-single", [["bead-single"]]);
		recordDispatch(dispatch);
		observeLifecycle({ id: "worker-single", agent: "orc-implementer", status: "started", parentToolCallId: dispatch.toolCallId, index: 0 });
		expect(workerFor(sessionId, "bead-single")).toMatchObject({ id: "worker-single", status: "started" });
	});

	test("uses the new worker after an old dispatch aborts", () => {
		const sessionId = "worker-redispached";
		const oldDispatch = record(sessionId, "worker-test-dispatch-redispached-old", [["bead-redispached"]]);
		recordDispatch(oldDispatch);
		observeLifecycle({ id: "worker-redispached-old", agent: "orc-implementer", status: "aborted", parentToolCallId: oldDispatch.toolCallId, index: 0 });
		const newDispatch = record(sessionId, "worker-test-dispatch-redispached-new", [["bead-redispached"]]);
		recordDispatch(newDispatch);
		observeLifecycle({ id: "worker-redispached-new", agent: "orc-implementer", status: "started", parentToolCallId: newDispatch.toolCallId, index: 0 });
		expect(workerFor(sessionId, "bead-redispached")).toMatchObject({ id: "worker-redispached-new", status: "started" });
	});

	test("returns no evidence before a re-dispatched worker emits a lifecycle frame", () => {
		const sessionId = "worker-no-frame";
		const oldDispatch = record(sessionId, "dispatch-no-frame-old", [["bead-no-frame"]]);
		recordDispatch(oldDispatch);
		observeLifecycle({ id: "worker-no-frame-old", agent: "orc-implementer", status: "aborted", parentToolCallId: oldDispatch.toolCallId, index: 0 });
		recordDispatch(record(sessionId, "dispatch-no-frame-new", [["bead-no-frame"]]));
		expect(workerFor(sessionId, "bead-no-frame")).toBeUndefined();
	});

	test("uses the newest record's index when a bead appears in multiple indices", () => {
		const sessionId = "worker-index";
		const oldDispatch = record(sessionId, "dispatch-index-old", [["bead-index"], ["other"]]);
		recordDispatch(oldDispatch);
		observeLifecycle({ id: "worker-index-old", agent: "orc-implementer", status: "aborted", parentToolCallId: oldDispatch.toolCallId, index: 0 });
		const newDispatch = record(sessionId, "dispatch-index-new", [["other"], ["bead-index"]]);
		recordDispatch(newDispatch);
		observeLifecycle({ id: "worker-index-new", agent: "orc-implementer", status: "started", parentToolCallId: newDispatch.toolCallId, index: 1 });
		expect(workerFor(sessionId, "bead-index")).toMatchObject({ id: "worker-index-new", status: "started" });
	});
});
describe("mentionsOrchestrate", () => {
	test("keyword boundary and code masking", () => {
		expect(mentionsOrchestrate("orchestrate")).toBe(true);
		expect(mentionsOrchestrate("we orchestrate. now")).toBe(true);
		expect(mentionsOrchestrate("<brief>orchestrate this</brief>")).toBe(true);
		expect(mentionsOrchestrate("```\norchestrate\n```")).toBe(false);
		expect(mentionsOrchestrate("~~~sh\norchestrate\n~~~")).toBe(false);
		// A closer is the same character, at least as long as the opener; an unclosed fence
		// masks to the end of the text, exactly as OMP's maskNonProse does.
		expect(mentionsOrchestrate("```\norchestrate\n`````")).toBe(false);
		expect(mentionsOrchestrate("````\norchestrate\n```\n")).toBe(false);
		expect(mentionsOrchestrate("```\norchestrate\n~~~\n")).toBe(false);
		expect(mentionsOrchestrate("```\ncode\n```\norchestrate")).toBe(true);
		// OMP's fence regex accepts a mixed 3-run as an opener; parity with OMP is the contract.
		expect(mentionsOrchestrate("``~ opener\norchestrate")).toBe(false);
		expect(mentionsOrchestrate("``orchestrate`` and `x`")).toBe(false);
		expect(mentionsOrchestrate("run `orchestrate`")).toBe(false);
		expect(mentionsOrchestrate("orchestrate()")).toBe(false);
		expect(mentionsOrchestrate("src/orchestrate")).toBe(false);
		expect(mentionsOrchestrate("re-orchestrate")).toBe(false);
		expect(mentionsOrchestrate("ns::orchestrate")).toBe(false);
		expect(mentionsOrchestrate("orchestrated")).toBe(false);
		expect(mentionsOrchestrate("   ")).toBe(false);
	});
});


describe("orc_finish blocked", () => {
	test("records the reason as a comment and never passes --reason to bd update", async () => {
		const root = fixture("server");
		const { pi, seen } = recordingApi();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		(pi as unknown as { registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => void }).registerTool = t => {
			seen.tools.push(t.name);
			tools.set(t.name, t);
		};
		orchestrateWithBd(pi);
		const argvs: string[][] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			return { stdout: new Response('{"id":"b-1"}').body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "s" } };
			await tools.get("orc_finish")?.execute("x", { bead: "b-1", state: "blocked", reason: "needs round.ts" }, undefined, undefined, ctx);
		} finally {
			spawn.mockRestore();
		}
		// Only the `bd` protocol matters here; the ledger also asks git for the canonical root.
		expect(argvs.filter(a => a[0] === "bd").map(a => a.slice(1).join(" "))).toEqual(["comment b-1 blocked: needs round.ts", "update b-1 --status blocked --json"]);
	});
});

describe("orc_finish done on an epic", () => {
	test("refuses while a descendant is open or in progress, closes when the subtree is terminal", async () => {
		const root = fixture("server");
		const { pi, seen } = recordingApi();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
		(pi as unknown as { registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }) => void }).registerTool = t => {
			seen.tools.push(t.name);
			tools.set(t.name, t);
		};
		orchestrateWithBd(pi);
		let children = '[{"id":"E.1","status":"closed"},{"id":"E.2","status":"open"}]';
		const argvs: string[][] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			const args = argv.slice(1).join(" ");
			let body = '{"id":"E","issue_type":"epic","status":"in_progress"}';
			if (args.startsWith("list --parent E ")) body = children;
			if (args.startsWith("list --parent E.")) body = "[]";
			if (args.startsWith("close")) body = '{"id":"E","status":"closed"}';
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "s" } };
			const refused = await tools.get("orc_finish")?.execute("x", { bead: "E", state: "done", reason: "all done" }, undefined, undefined, ctx);
			expect(refused?.isError).toBe(true);
			expect(refused?.content[0]?.text).toContain("E.2");
			expect(argvs.some(a => a[1] === "close")).toBe(false);
			children = '[{"id":"E.1","status":"closed"},{"id":"E.2","status":"blocked"}]';
			const closed = await tools.get("orc_finish")?.execute("x", { bead: "E", state: "done", reason: "all done" }, undefined, undefined, ctx);
			expect(closed?.isError ?? false).toBe(false);
			expect(argvs.some(a => a[1] === "close")).toBe(true);
			// Beyond the walk limit the check is blind, so it refuses rather than closes.
			argvs.length = 0;
			children = JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ id: `E.${i}`, status: "closed" })));
			const blind = await tools.get("orc_finish")?.execute("x", { bead: "E", state: "done", reason: "all done" }, undefined, undefined, ctx);
			expect(blind?.isError).toBe(true);
			expect(blind?.content[0]?.text).toContain("more than 500 descendants");
			expect(argvs.some(a => a[1] === "close")).toBe(false);
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("orc_bind resolves the run from the ledger", () => {
	/** `metadata.run` as bd stores it: `--set-metadata run=<json>` keeps the value a string. */
	const ownership = (owner: string, runRoot: string) => JSON.stringify({ owner, bound_at: "2026-01-01T00:00:00Z", root: runRoot, ci_scoped: true });


	function harness(runEpics: () => string) {
		const root = fixture("server");
		const { pi, seen } = recordingApi();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> }>();
		(pi as unknown as { registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> }) => void }).registerTool = t => {
			seen.tools.push(t.name);
			tools.set(t.name, t);
		};
		orchestrateWithBd(pi);
		const bd: string[][] = [];
		// The store the bind writes into: `show` reflects what `update` did, because the bind reads
		// its own ownership write back and a fixture that forgets the write cannot judge that read.
		const beads: Record<string, Record<string, unknown>> = {
			R: { id: "R", issue_type: "epic", status: "open", assignee: "omp/me", dependencies: [] },
			"R.2": { id: "R.2", issue_type: "epic", status: "open", assignee: "omp/me", parent: "R", dependencies: [{ id: "R", issue_type: "epic", dependency_type: "parent-child" }] },
			"R.2.1": { id: "R.2.1", issue_type: "epic", status: "open", assignee: "omp/me", dependencies: [{ id: "R.2", dependency_type: "parent-child" }] },
			"R.2.9": { id: "R.2.9", issue_type: "task", status: "open", dependencies: [{ id: "R.2", dependency_type: "parent-child" }] },
			OTHER: { id: "OTHER", issue_type: "epic", status: "open", dependencies: [] },
			// Held by a live lead: the record and the claim beside it both say so.
			TAKEN: { id: "TAKEN", issue_type: "epic", status: "open", assignee: "omp/someone-else", lease_expires_at: new Date(Date.now() + 300_000).toISOString(), metadata: { run: ownership("omp/someone-else", "TAKEN") }, dependencies: [] },
			// The same record, but the lead that wrote it is gone: its claim's lease has run out.
			ABANDONED: { id: "ABANDONED", issue_type: "epic", status: "open", assignee: "omp/gone", lease_expires_at: new Date(Date.now() - 1_000).toISOString(), metadata: { run: ownership("omp/gone", "ABANDONED") }, dependencies: [] },
			CONTESTED: { id: "CONTESTED", issue_type: "epic", status: "open", assignee: "omp/me", dependencies: [] },
		};
		// `bd show` prints an object for some beads and a one-element array for others; both shapes
		// are real, so both are exercised.
		const asArray: Record<string, true> = { "R.2": true, "R.2.1": true, "R.2.9": true, ABANDONED: true };
		const show = (id: string): string => {
			const bead = beads[id];
			if (bead === undefined) return "[]";
			return JSON.stringify(asArray[id] === true ? [bead] : bead);
		};
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			const args = argv.slice(1).join(" ");
			if (argv[0] === "bd") bd.push(argv.slice(1));
			let body = "[]";
			// Run discovery: every epic carrying `metadata.run`, whoever owns it.
			if (args.startsWith("list -t epic --has-metadata-key run")) body = runEpics();
			const rest = argv.slice(1);
			const [verb, id] = rest;
			// A client with native leases: reclaim is the only transfer evidence orc_bind accepts.
			if (verb === "--version") body = "bd version 1.3.0";
			if (verb === "show" && id !== undefined) body = show(id);
			if (verb === "update" && id !== undefined) {
				const bead = beads[id];
				const at = rest.indexOf("--set-metadata");
				if (bead !== undefined && at !== -1) {
					const [key, ...value] = (rest[at + 1] ?? "").split("=");
					bead.metadata = { ...(bead.metadata as Record<string, unknown>), [key as string]: value.join("=") };
				}
				// CONTESTED is the race the readback exists for: a second lead's `--set-metadata`
				// lands after this one, so the record the next reader sees is not the one written.
				if (bead !== undefined && id === "CONTESTED") bead.metadata = { run: ownership("omp/racer", "CONTESTED") };
				if (bead !== undefined && rest.includes("--claim") && bead.assignee === undefined) bead.assignee = "omp/me";
				body = show(id);
			}
			// `bd reclaim` releases a claim only when its lease has genuinely run out: that is the
			// only evidence orc_bind accepts for taking a run from the lead that recorded it.
			if (verb === "reclaim") {
				const target = rest[rest.indexOf("--id") + 1] ?? "";
				const bead = beads[target];
				const expires = typeof bead?.lease_expires_at === "string" ? Date.parse(bead.lease_expires_at) : Number.NaN;
				if (bead !== undefined && !Number.isNaN(expires) && expires <= Date.now()) {
					bead.assignee = undefined;
					body = JSON.stringify([{ id: target }]);
				}
			}
			if (args.startsWith("ready")) body = "[]";
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		const ctx = { cwd: root, sessionManager: { getSessionId: () => "me" } };
		/** The ownership record written on `epic`, or undefined when this bind wrote none. */
		const recorded = (epic: string): unknown => {
			for (const argv of bd) {
				if (argv[0] !== "update" || argv[1] !== epic) continue;
				const value = argv[argv.indexOf("--set-metadata") + 1];
				if (value === undefined || !value.startsWith("run=")) continue;
				return JSON.parse(value.slice("run=".length));
			}
			return undefined;
		};
		return { tools, ctx, bd, beads, spawn, recorded };
	}

	test("a child epic of the owned run inherits its root; an unrelated epic and a task are refused", async () => {
		let epics = "[]";
		const f = harness(() => epics);
		try {
			// Nothing recorded anywhere: the run epic itself binds, and it is its own root.
			const first = await f.tools.get("orc_bind")?.execute("x", { epic: "R" }, undefined, undefined, f.ctx);
			expect(first?.isError ?? false).toBe(false);
			expect(f.recorded("R")).toMatchObject({ owner: "omp/me", root: "R" });

			// With R recorded as this lead's run, a child epic rebinds and keeps R as the run root,
			// so a sub-lead's epic is never mistaken for a run root and asked for a DAG review.
			epics = JSON.stringify([{ id: "R", issue_type: "epic", status: "open", assignee: "omp/me", metadata: { run: ownership("omp/me", "R") }, dependencies: [] }]);
			const child = await f.tools.get("orc_bind")?.execute("x", { epic: "R.2" }, undefined, undefined, f.ctx);
			expect(child?.isError ?? false).toBe(false);
			expect(f.recorded("R.2")).toMatchObject({ owner: "omp/me", root: "R" });

			// Two levels down, with no top-level `parent` field: the dependency entry alone carries it.
			const grandchild = await f.tools.get("orc_bind")?.execute("x", { epic: "R.2.1" }, undefined, undefined, f.ctx);
			expect(grandchild?.isError ?? false).toBe(false);
			expect(f.recorded("R.2.1")).toMatchObject({ owner: "omp/me", root: "R" });

			// A task under the run is not a run: refused before any claim or write.
			const taskUnderRun = await f.tools.get("orc_bind")?.execute("x", { epic: "R.2.9" }, undefined, undefined, f.ctx);
			expect(taskUnderRun?.isError).toBe(true);
			expect(taskUnderRun?.content[0]?.text).toContain("not an epic");
			expect(f.recorded("R.2.9")).toBeUndefined();

			// An epic outside the owned run is refused: that refusal is what the locator file did.
			const other = await f.tools.get("orc_bind")?.execute("x", { epic: "OTHER" }, undefined, undefined, f.ctx);
			expect(other?.isError).toBe(true);
			expect(other?.content[0]?.text).toContain("already bound to R");
			expect(f.recorded("OTHER")).toBeUndefined();
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("an epic a live lead holds is refused, and no claim is attempted", async () => {
		const f = harness(() => "[]");
		try {
			const taken = await f.tools.get("orc_bind")?.execute("x", { epic: "TAKEN" }, undefined, undefined, f.ctx);
			expect(taken?.isError).toBe(true);
			expect(taken?.content[0]?.text).toContain("already bound to omp/someone-else");
			expect(f.bd.some(argv => argv.includes("--claim"))).toBe(false);
			expect(f.bd.some(argv => argv[0] === "reclaim")).toBe(false);
			expect(f.recorded("TAKEN")).toBeUndefined();
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a run whose lead's claim has lapsed transfers, because ownership is a record and nothing clears it", async () => {
		// Without this an epic bound by a session that has since ended is unbindable forever: its
		// `metadata.run` names an actor nobody is, and the assignee blocks every later claim.
		const f = harness(() => "[]");
		try {
			const bound = await f.tools.get("orc_bind")?.execute("x", { epic: "ABANDONED" }, undefined, undefined, f.ctx);
			expect(bound?.isError ?? false).toBe(false);
			expect(f.recorded("ABANDONED")).toMatchObject({ owner: "omp/me", root: "ABANDONED", transferred_from: "omp/gone" });
			// The transfer is `bd reclaim`'s, so it happened only because that lease had run out.
			expect(f.bd.some(argv => argv[0] === "reclaim" && argv.includes("ABANDONED"))).toBe(true);
			expect(bound?.content[0]?.text).toContain("run transferred from omp/gone");
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a bind whose ownership write another lead overwrote is refused, not reported bound", async () => {
		// `--set-metadata` is last-writer-wins, so success is the *readback*, never the write.
		const f = harness(() => "[]");
		try {
			const raced = await f.tools.get("orc_bind")?.execute("x", { epic: "CONTESTED" }, undefined, undefined, f.ctx);
			expect(raced?.isError).toBe(true);
			expect(raced?.content[0]?.text).toContain("the ownership write did not land as yours");
			expect(raced?.content[0]?.text).toContain("omp/racer");
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("orc_status is a read: with no run recorded it binds nothing and names orc_bind", async () => {
		const f = harness(() => "[]");
		try {
			const unbound = await f.tools.get("orc_status")?.execute("x", { epic: "R" }, undefined, undefined, f.ctx);
			expect(unbound?.isError).toBe(true);
			expect(unbound?.content[0]?.text).toContain("orc_bind");
			expect(f.bd.some(argv => argv.includes("--set-metadata"))).toBe(false);
			expect(f.bd.some(argv => argv[0] === "close" || argv[0] === "update")).toBe(false);
		} finally {
			f.spawn.mockRestore();
		}
	});
});

describe("orc_bind claims the epic", () => {
	test("refuses to bind an epic another actor holds and records no run", async () => {
		const root = fixture("server");
		const { pi, seen } = recordingApi();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
		(pi as unknown as { registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }) => void }).registerTool = t => {
			seen.tools.push(t.name);
			tools.set(t.name, t);
		};
		orchestrateWithBd(pi);
		const argvs: string[][] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			return { stdout: new Response('{"id":"E","issue_type":"epic","status":"in_progress","assignee":"omp/other"}').body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "me" } };
			const result = await tools.get("orc_bind")?.execute("x", { epic: "E" }, undefined, undefined, ctx);
			expect(result?.isError).toBe(true);
			expect(result?.content[0]?.text).toContain("held by omp/other");
			// Already assigned: no claim attempted, and nothing recorded on the epic.
			expect(argvs.some(a => a.includes("--claim"))).toBe(false);
			expect(argvs.some(a => a.includes("--set-metadata"))).toBe(false);
			// A task id is refused before any claim or write: a run binds an epic.
			spawn.mockImplementation(((argv: string[]) => {
				argvs.push(argv);
				return { stdout: new Response('{"id":"T","issue_type":"task","status":"open"}').body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
			}) as unknown as typeof Bun.spawn);
			const task = await tools.get("orc_bind")?.execute("x", { epic: "T" }, undefined, undefined, ctx);
			expect(task?.isError).toBe(true);
			expect(task?.content[0]?.text).toContain("not an epic");
			expect(argvs.some(a => a.includes("--claim"))).toBe(false);
			expect(argvs.some(a => a.includes("--set-metadata"))).toBe(false);
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("orc_bind admits configured queue aliases", () => {
	type ToolResult = { content: { text: string }[]; details?: unknown; isError?: boolean };
	type Tool = { execute: (...args: unknown[]) => Promise<ToolResult> };

	function boundAssignee(result: ToolResult | undefined): string | undefined {
		const details = result?.details;
		if (details === null || typeof details !== "object" || !("epic" in details)) return undefined;
		const epic = details.epic;
		if (epic === null || typeof epic !== "object" || !("assignee" in epic) || typeof epic.assignee !== "string") return undefined;
		return epic.assignee;
	}

	function toolsFor(pi: ExtensionAPI, seen: Registered): Map<string, Tool> {
		const tools = new Map<string, Tool>();
		(pi as unknown as { registerTool: (tool: { name: string; execute: Tool["execute"] }) => void }).registerTool = tool => {
			seen.tools.push(tool.name);
			tools.set(tool.name, tool);
		};
		orchestrateWithBd(pi);
		return tools;
	}

	/**
	 * One epic, answered from a tiny store: a `--claim` moves the assignee to this actor and a
	 * `--set-metadata` lands on the bead, because `orc_bind` reads its own ownership write back
	 * and refuses a bind that did not land as the caller's.
	 */
	function store(initial: { status: string; assignee?: string }): { spawn: () => Bun.Subprocess; state: { assignee?: string } } {
		const state: { assignee?: string; metadata?: Record<string, unknown> } = { assignee: initial.assignee };
		const spawn = ((argv: string[]) => {
			const command = argv.slice(1).join(" ");
			let body = "[]";
			if (command.startsWith("config get claim.pools ")) body = '{"key":"claim.pools","value":"pool:orc-lead,pool:orc-reviewer"}';
			if (command.startsWith("update E --claim")) state.assignee = "omp/me";
			if (command.startsWith("update E --set-metadata")) {
				const argument = argv[argv.indexOf("--set-metadata") + 1] ?? "";
				const split = argument.indexOf("=");
				state.metadata = { ...state.metadata, [argument.slice(0, split)]: JSON.parse(argument.slice(split + 1)) };
			}
			if (command.startsWith("show E ") || command.startsWith("update E ")) {
				body = JSON.stringify({
					id: "E",
					issue_type: "epic",
					status: state.assignee === undefined ? initial.status : "in_progress",
					...(state.assignee === undefined ? {} : { assignee: state.assignee }),
					...(state.metadata === undefined ? {} : { metadata: state.metadata }),
					dependencies: [],
				});
			}
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as () => Bun.Subprocess;
		return { spawn, state };
	}

	test("claims an epic held by a configured queue alias", async () => {
		const root = fixture("embedded");
		const { pi, seen } = recordingApi();
		const tools = toolsFor(pi, seen);
		const fake = store({ status: "in_progress", assignee: "pool:orc-lead" });
		const spawn = spyOn(Bun, "spawn").mockImplementation(fake.spawn as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "me" } };
			const result = await tools.get("orc_bind")?.execute("x", { epic: "E" }, undefined, undefined, ctx);
			expect(result?.isError ?? false).toBe(false);
			expect(boundAssignee(result)).toBe("omp/me");
		} finally {
			spawn.mockRestore();
		}
	});

	test("an epic held by an alias no configured pool names is not claimable", async () => {
		const root = fixture("embedded");
		const { pi, seen } = recordingApi();
		const tools = toolsFor(pi, seen);
		const fake = store({ status: "in_progress", assignee: "pool:someone-else" });
		const spawn = spyOn(Bun, "spawn").mockImplementation(fake.spawn as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "me" } };
			const result = await tools.get("orc_bind")?.execute("x", { epic: "E" }, undefined, undefined, ctx);
			expect(result?.isError).toBe(true);
			expect(result?.content[0]?.text).toContain("pool:someone-else");
			// The alias still holds it: an unconfigured one is a holder, not a queue.
			expect(fake.state.assignee).toBe("pool:someone-else");
		} finally {
			spawn.mockRestore();
		}
	});

	test("keeps binding an unassigned epic", async () => {
		const root = fixture("embedded");
		const { pi, seen } = recordingApi();
		const tools = toolsFor(pi, seen);
		const fake = store({ status: "open" });
		const spawn = spyOn(Bun, "spawn").mockImplementation(fake.spawn as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "me" } };
			const result = await tools.get("orc_bind")?.execute("x", { epic: "E" }, undefined, undefined, ctx);
			expect(result?.isError ?? false).toBe(false);
			expect(boundAssignee(result)).toBe("omp/me");
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("wave gate", () => {
	const wave = new Map([
		["w-1", { bead: "w-1", title: "one", role: "implementer", tier: "basic" as const, agent: "orc-implementer", }],
		["w-2", { bead: "w-2", title: "two", role: "implementer", tier: "deep" as const, agent: "orc-implementer-deep", }],
		["w-3", { bead: "w-3", title: "three", role: "reviewer", agent: "orc-reviewer", }],
	]);
	test("requires every ready bead exactly once and exempts helpers", () => {
		const partial = waveGate({ tasks: [{ task: "Implement w-1" }] }, wave);
		expect(partial).toMatchObject({ block: true });
		expect((partial as { reason: string }).reason).toContain("w-2");
		expect((partial as { reason: string }).reason).toContain("w-3");
		expect(waveGate({ tasks: [{ task: "w-1" }, { task: "w-2" }, { task: "w-3" }] }, wave)).toEqual({ beadsByIndex: [["w-1"], ["w-2"], ["w-3"]] });
		expect(waveGate({ tasks: [{ task: "w-1" }, { task: "w-1 w-2" }, { task: "w-3" }] }, wave)).toMatchObject({ block: true });
		expect(waveGate({ tasks: [{ agent: "scout", task: "w-1" }] }, wave)).toBeUndefined();
		expect(namedBeads("w-1 and w-2", wave)).toEqual(["w-1", "w-2"]);
	});
});


describe("routeDispatch", () => {
	const wave = new Map([
		["e-1.1", { bead: "e-1.1", title: "a", role: "implementer", tier: "basic" as const, agent: "orc-implementer", }],
		["e-1.2", { bead: "e-1.2", title: "b", role: "implementer", tier: "deep" as const, agent: "orc-implementer-deep", }],
		["e-1.10", { bead: "e-1.10", title: "r", role: "reviewer", agent: "orc-reviewer", }],
	]);

	test("an item naming one wave bead gets that entry's agent; others are untouched", () => {
		const input = {
			tasks: [
				{ name: "A", agent: "orc-implementer", task: "Bead e-1.1: add subtract" },
				{ name: "B", agent: "orc-implementer", task: "Bead e-1.2: add safeDivide" },
				{ name: "R", agent: "orc-implementer", task: "Review bead e-1.10 against the merged diff" },
				{ name: "H", agent: "scout", task: "where is OPERATIONS defined?" },
			],
		};
		const routed = routeDispatch(input, wave) as { tasks: Array<Record<string, unknown>> };
		expect(routed.tasks[0]).toEqual(input.tasks[0]);
		expect(routed.tasks[1]).toMatchObject({ agent: "orc-implementer-deep" });
		expect(routed.tasks[2]).toMatchObject({ agent: "orc-reviewer" });
		expect(routed.tasks[3]).toEqual(input.tasks[3]);
	});

	test("a helper whose brief cites a wave bead is never rerouted; an item with no agent is", () => {
		const input = {
			tasks: [
				{ name: "S", agent: "scout", task: "For bead e-1.2: where is OPERATIONS defined?" },
				{ name: "O", agent: "operator", task: "Bead e-1.2: rename x to y" },
				{ name: "SR", agent: "security-reviewer", task: "Review the diff for e-1.2" },
				{ name: "N", task: "Bead e-1.2: add safeDivide" },
			],
		};
		const routed = routeDispatch(input, wave) as { tasks: Array<Record<string, unknown>> };
		expect(routed.tasks[0]).toEqual(input.tasks[0]);
		expect(routed.tasks[1]).toEqual(input.tasks[1]);
		expect(routed.tasks[2]).toEqual(input.tasks[2]);
		expect(routed.tasks[3]).toMatchObject({ agent: "orc-implementer-deep" });
		expect(routeDispatch({ tasks: [{ agent: "scout", task: "e-1.2" }] }, wave)).toBeUndefined();
	});

	test("bead ids match whole, so e-1.1 does not claim an item about e-1.10, and a brief naming two beads is left alone", () => {
		expect(routeDispatch({ tasks: [{ agent: "orc-implementer", task: "e-1.10 only" }] }, wave)).toMatchObject({ tasks: [{ agent: "orc-reviewer" }] });
		expect(routeDispatch({ tasks: [{ agent: "orc-implementer", task: "e-1.1 and e-1.2 together" }] }, wave)).toBeUndefined();
	});

	test("nothing to change, an empty wave, or a non-object input returns undefined; the single-item shape is routed too", () => {
		expect(routeDispatch({ tasks: [{ agent: "orc-implementer-deep", task: "e-1.2" }] }, wave)).toBeUndefined();
		expect(routeDispatch({ tasks: [{ agent: "orc-implementer", task: "e-1.2" }] }, new Map())).toBeUndefined();
		expect(routeDispatch("x", wave)).toBeUndefined();
		expect(routeDispatch({ agent: "orc-implementer", task: "e-1.2" }, wave)).toMatchObject({ agent: "orc-implementer-deep" });
	});
});

describe("orc_status and orc_finish over the review lifecycle", () => {
	type Tool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> };
	test("the DAG review gates the wave, a review bead needs a verdict, and fix makes the reopened task the next wave", async () => {
		const root = fixture("server");
		const { pi, seen } = recordingApi();
		const tools = new Map<string, Tool>();
		(pi as unknown as { registerTool: (t: { name: string } & Tool) => void }).registerTool = t => {
			seen.tools.push(t.name);
			tools.set(t.name, t);
		};
		orchestrateWithBd(pi);
		// A tiny stateful store: the epic E, task E.1 (closed by an implementer), review E.9 held by a reviewer.
		const beads: Record<string, Record<string, unknown>> = {
			E: { id: "E", issue_type: "epic", status: "in_progress", assignee: "omp/s" },
			// `bd show` shape for edges: { id, dependency_type }.
			"E.1": { id: "E.1", issue_type: "task", title: "Add subtract", status: "closed", assignee: "impl", metadata: { role: "implementer", tier: "basic" }, dependencies: [{ id: "E", dependency_type: "parent-child" }] },
			"E.9": { id: "E.9", issue_type: "task", title: "Review", status: "in_progress", assignee: "rev", metadata: { role: "reviewer" }, dependencies: [{ id: "E", dependency_type: "parent-child" }, { id: "E.1", dependency_type: "blocks" }] },
		};
		const argvs: string[][] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			const args = argv.slice(1);
			argvs.push(args);
			let body: unknown = null;
			const [verb, id] = args;
			if (verb === "show") body = beads[id as string];
			else if (verb === "list" && args.includes("--has-metadata-key")) {
				// Run discovery: `bd list -t epic --has-metadata-key run`.
				const key = args[args.indexOf("--has-metadata-key") + 1];
				const type = args.includes("-t") ? args[args.indexOf("-t") + 1] : undefined;
				body = Object.values(beads).filter(b => {
					const metadata = b.metadata;
					const has = metadata !== null && typeof metadata === "object" && key !== undefined && key in metadata;
					return has && (type === undefined || b.issue_type === type);
				});
			} else if (verb === "list") body = Object.values(beads).filter(b => edgesOf(b as BdBead).some(d => d.type === "parent-child" && d.id === args[2]));
			else if (verb === "ready") body = Object.values(beads).filter(b => b.status === "open" && !b.assignee && edgesOf(b as BdBead).every(d => d.type === "parent-child" || beads[d.id]?.status === "closed"));
			else if (verb === "reopen") beads[id as string]!.status = "open";
			else if (verb === "update") {
				const b = beads[id as string]!;
				for (let i = 2; i < args.length; i++) {
					if (args[i] === "--status") b.status = args[++i];
					else if (args[i] === "--assignee") b.assignee = args[++i] || undefined;
					else if (args[i] === "--set-metadata") {
						const [k, ...rest] = (args[++i] as string).split("=");
						b.metadata = { ...(b.metadata as Record<string, unknown>), [k as string]: rest.join("=") };
					}
				}
				body = b;
			} else if (verb === "create") {
				const created = { id: "E.0", issue_type: args[args.indexOf("--type") + 1], title: args[args.indexOf("--title") + 1], status: "open", metadata: JSON.parse(args[args.indexOf("--metadata") + 1] as string), dependencies: [{ id: args[args.indexOf("--parent") + 1], dependency_type: "parent-child" }] };
				beads[created.id] = created;
				body = created;
			}
			return { stdout: new Response(JSON.stringify(body)).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "s" } };
			// 0. Bind (the one write), then read.
			const bound = await tools.get("orc_bind")?.execute("x", { epic: "E" }, undefined, undefined, ctx);
			expect(bound?.isError ?? false).toBe(false);
			// 1. No DAG review yet: the wave is withheld and the create command is returned; nothing is created by the read.
			const status1 = await tools.get("orc_status")?.execute("x", {}, undefined, undefined, ctx);
			expect(status1?.content[0]?.text).toContain("DAG review required");
			expect(status1?.content[0]?.text).toContain("bd create --type task --parent E");
			expect((status1?.details as { ready: string[] }).ready).toEqual([]);
			expect(argvs.some(a => a[0] === "create")).toBe(false);
			// The lead runs the command; the review is now the wave.
			beads["E.0"] = { id: "E.0", issue_type: "task", title: "Review the DAG", status: "open", metadata: { role: "dag-reviewer" }, dependencies: [{ id: "E", dependency_type: "parent-child" }] };
			const status2 = await tools.get("orc_status")?.execute("x", {}, undefined, undefined, ctx);
			expect((status2?.details as { wave: Array<{ bead: string; agent: string }> }).wave).toEqual([expect.objectContaining({ bead: "E.0", agent: "orc-reviewer", })]);
			beads["E.0"]!.status = "closed";
			// 2. A review bead cannot finish done without a verdict; a task cannot carry one.
			const bare = await tools.get("orc_finish")?.execute("x", { bead: "E.9", state: "done", reason: "ok" }, undefined, undefined, ctx);
			expect(bare?.isError).toBe(true);
			expect(bare?.content[0]?.text).toContain("verdict");
			const misuse = await tools.get("orc_finish")?.execute("x", { bead: "E.1", state: "done", reason: "ok", verdict: "approve" }, undefined, undefined, ctx);
			expect(misuse?.isError).toBe(true);
			// 3. fix: the task is reopened for the same tier and is the next wave; the review is open, unassigned, and blocked by it.
			// No `targets`: the default reads the review's task edges in the `bd show` shape.
			const fix = await tools.get("orc_finish")?.execute("x", { bead: "E.9", state: "done", verdict: "fix", reason: "two nits", comment: "narrow the type" }, undefined, undefined, ctx);
			expect(fix?.isError ?? false).toBe(false);
			expect(beads["E.9"]).toMatchObject({ status: "open", assignee: undefined });
			const status3 = await tools.get("orc_status")?.execute("x", {}, undefined, undefined, ctx);
			const wave3 = (status3?.details as { wave: Array<Record<string, unknown>> }).wave;
			expect(wave3).toEqual([expect.objectContaining({ bead: "E.1", agent: "orc-implementer", fix: expect.objectContaining({ from: "E.9", findings: "narrow the type" }) })]);
			// The implementer finishes; the review is ready again.
			beads["E.1"]!.status = "closed";
			beads["E.1"]!.assignee = "impl";
			const status4 = await tools.get("orc_status")?.execute("x", {}, undefined, undefined, ctx);
			expect((status4?.details as { ready: string[] }).ready).toEqual(["E.9 Review"]);
		} finally {
			spawn.mockRestore();
		}
	});
});
test("fix restores a departed foreign holder to its phase queue", async () => {
	const root = fixture("server");
	const { pi } = recordingApi();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> }>();
	(pi as unknown as { registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => void }).registerTool = t => {
		tools.set(t.name, t as { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> });
	};
	orchestrateWithBd(pi);
	const beads: Record<string, Record<string, unknown>> = {
		E: { id: "E", issue_type: "epic", status: "in_progress", assignee: "omp/verdict-phase" },
		"E.1": { id: "E.1", issue_type: "task", status: "in_progress", assignee: "pool:orc:implement", metadata: { role: "implementer", tier: "basic", phase: "pool:orc:implement" }, dependencies: [{ id: "E", dependency_type: "parent-child" }] },
		"E.9": { id: "E.9", issue_type: "task", status: "in_progress", assignee: "rev", metadata: { role: "reviewer" }, dependencies: [{ id: "E", dependency_type: "parent-child" }, { id: "E.1", dependency_type: "blocks" }] },
	};
	const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
		const args = argv.slice(1);
		const [verb, id] = args;
		let body: unknown = null;
		if (verb === "--version") body = "bd version 1.3.0";
		else if (verb === "show") body = beads[id as string];
		else if (verb === "comment") body = null;
		else if (verb === "update") {
			const bead = beads[id as string];
			if (bead === undefined) throw new Error(`missing bead ${id}`);
			for (let i = 2; i < args.length; i++) {
				if (args[i] === "--if-assignee") {
					const expected = args[++i] || undefined;
					if (bead.assignee !== expected) throw new Error(`assignee mismatch for ${id}`);
				} else if (args[i] === "--if-status") {
					if (bead.status !== args[++i]) throw new Error(`status mismatch for ${id}`);
				} else if (args[i] === "--status") bead.status = args[++i];
				else if (args[i] === "--assignee") bead.assignee = args[++i] || undefined;
				else if (args[i] === "--set-metadata") {
					const [key, ...rest] = (args[++i] as string).split("=");
					bead.metadata = { ...(bead.metadata as Record<string, unknown>), [key as string]: rest.join("=") };
				}
			}
			body = bead;
		} else if (verb === "reopen") {
			const bead = beads[id as string];
			if (bead === undefined) throw new Error(`missing bead ${id}`);
			bead.status = "open";
			body = bead;
		}
		return { stdout: new Response(JSON.stringify(body)).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
	}) as unknown as typeof Bun.spawn);
	try {
		recordDispatch({ toolCallId: "dispatch-phase", sessionId: "verdict-phase", cwd: root, actor: "omp/verdict-phase", beadsByIndex: [["E.1"]], workers: new Map() });
		observeLifecycle({ id: "worker-ended", agent: "orc-implementer", status: "aborted", parentToolCallId: "dispatch-phase", index: 0 });
		const ctx = { cwd: root, sessionManager: { getSessionId: () => "verdict-phase" } };
		const result = await tools.get("orc_finish")?.execute("x", { bead: "E.9", state: "done", verdict: "fix", reason: "fix queue routing", comment: "restore the phase" }, undefined, undefined, ctx);
		expect(result?.isError ?? false).toBe(false);
		expect(beads["E.1"]).toMatchObject({ status: "open", assignee: "pool:orc:implement", metadata: { fix_from: "E.9", fix_findings: "restore the phase", fix_round: "1", phase: "pool:orc:implement" } });
		expect(beads["E.9"]).toMatchObject({ status: "open", assignee: undefined });
		expect(result?.content[0]?.text).toContain("pool:orc:implement");
	} finally {
		spawn.mockRestore();
		rmSync(join(root, ".orchestration"), { recursive: true, force: true });
	}
});

describe("orc_claim queue eligibility", () => {
	type ToolResult = { content: { text: string }[]; details?: unknown; isError?: boolean };
	type Tool = { execute: (...args: unknown[]) => Promise<ToolResult> };

	function claimTool(): Tool {
		const { pi } = recordingApi();
		let claim: Tool | undefined;
		(pi as unknown as { registerTool: (tool: { name: string; execute: Tool["execute"] }) => void }).registerTool = tool => {
			if (tool.name === "orc_claim") claim = tool;
		};
		orchestrateWithBd(pi);
		if (claim === undefined) throw new Error("orc_claim was not registered");
		return claim;
	}

	function fixtureClaim(initial: Record<string, unknown>, unreadable = false) {
		const root = fixture("server");
		const state = { ...initial };
		const commands: string[][] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			const args = argv.slice(1).filter(arg => arg !== "--json");
			commands.push(args);
			const [verb] = args;
			let body: unknown = state;
			let code = 0;
			let stderr = "";
			if (verb === "--version") body = "bd version 1.3.0";
			if (verb === "show" && unreadable) {
				body = null;
				code = 1;
				stderr = "shared store unavailable";
			}
			if (verb === "update") {
				const assigneeGuard = args.indexOf("--if-assignee");
				const statusGuard = args.indexOf("--if-status");
				if (assigneeGuard !== -1 && (state.assignee ?? "") !== args[assigneeGuard + 1]) {
					code = 13;
					stderr = "guard mismatch";
				} else if (statusGuard !== -1 && state.status !== args[statusGuard + 1]) {
					code = 13;
					stderr = "guard mismatch";
				} else if (args.includes("--claim")) {
					state.assignee = "omp/worker";
					state.status = "in_progress";
				} else {
					state.assignee = args[args.indexOf("--assignee") + 1];
					state.status = args[args.indexOf("--status") + 1];
				}
				body = state;
			}
			if (verb === "heartbeat") body = state;
			const stdout = new Response(JSON.stringify(body)).body;
			return { stdout, stderr: new Response(stderr).body, exited: Promise.resolve(code), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		return { root, claim: claimTool(), commands, state, spawn };
	}

	test("claims a bead when the dispatched agent matches its queue", async () => {
		const f = fixtureClaim({ id: "Q", status: "open", assignee: "pool:orc-reviewer" });
		try {
			const result = await f.claim.execute("id", { bead: "Q", agent: "orc-reviewer" }, undefined, undefined, { cwd: f.root, sessionManager: { getSessionId: () => "worker" } });
			expect(result.isError).toBeFalsy();
			expect(result.details).toMatchObject({ claimed: true, bead: { assignee: "omp/worker" } });
			expect(f.commands.some(args => args[0] === "update" && args.includes("pool:orc-reviewer"))).toBe(true);
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("refuses a mismatched queue and names the bead, queue, and agent", async () => {
		const f = fixtureClaim({ id: "Q", status: "open", assignee: "pool:orc-reviewer" });
		try {
			const result = await f.claim.execute("id", { bead: "Q", agent: "orc-implementer" }, undefined, undefined, { cwd: f.root, sessionManager: { getSessionId: () => "worker" } });
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe("orc_claim Q: refused, bead Q is in queue pool:orc-reviewer, but agent orc-implementer tried");
			expect(f.commands.some(args => args[0] === "update")).toBe(false);
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("keeps an unqueued bead on the existing claim path", async () => {
		const f = fixtureClaim({ id: "Q", status: "open" });
		try {
			const result = await f.claim.execute("id", { bead: "Q" }, undefined, undefined, { cwd: f.root, sessionManager: { getSessionId: () => "worker" } });
			expect(result.isError).toBeFalsy();
			expect(result.details).toMatchObject({ claimed: true, bead: { assignee: "omp/worker" } });
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("refuses a queued claim without an agent instead of guessing", async () => {
		const f = fixtureClaim({ id: "Q", status: "open", assignee: "pool:orc-reviewer" });
		try {
			const result = await f.claim.execute("id", { bead: "Q", agent: undefined }, undefined, undefined, { cwd: f.root, sessionManager: { getSessionId: () => "worker" } });
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe("orc_claim Q: refused, queue pool:orc-reviewer is unreadable without a claiming agent");
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("refuses when the bead cannot be read, naming the uncertainty", async () => {
		const f = fixtureClaim({ id: "Q", status: "open" }, true);
		try {
			const result = await f.claim.execute("id", { bead: "Q", agent: "orc-reviewer" }, undefined, undefined, { cwd: f.root, sessionManager: { getSessionId: () => "worker" } });
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("orc_claim Q: refused, bead unreadable:");
			expect(result.content[0]?.text).toContain("shared store unavailable");
		} finally {
			f.spawn.mockRestore();
		}
	});
});
