import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, edgesOf } from "../src/bd";
import orchestrateWithBd, { mutatesStore, routeDispatch, runHeader, STOP_REFUSAL, storeMutationBlock } from "../src/index";
import { namedBeads, observeLifecycle, recordDispatch, waveGate, workerFor } from "../src/dispatch";
import { mentionsOrchestrate } from "../src/keyword";
import { readLocator, writeLocator } from "../src/run";
import { NO_STORE, NOT_SERVER_MODE, storeRefusal } from "../src/tools/ledger";

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
	test("registers lifecycle bus and nine tools", () => {
		const { pi, seen } = recordingApi();
		expect(() => orchestrateWithBd(pi)).not.toThrow();
		expect(seen.label).toBe("Orchestrate with bd");
		expect([...new Set(seen.events)].sort()).toEqual(["before_agent_start", "todo_reminder", "tool_call"]);
		expect(seen.busChannels).toEqual(["task:subagent:lifecycle"]);
		expect(seen.commands).toEqual([]);
		expect(seen.tools.sort()).toEqual(["orc_bind", "orc_bot_review_probe", "orc_bot_review_request", "orc_claim", "orc_conflict_probe", "orc_finish", "orc_release", "orc_review_round_policy", "orc_status"]);
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

describe("before_agent_start", () => {
	async function header(root: string, prompt: string): Promise<unknown> {
		const { pi, seen } = recordingApi();
		orchestrateWithBd(pi);
		const ctx = { cwd: root, sessionManager: { getSessionId: () => "sess-2" }, models: { resolve: () => ({ id: "m" }) } };
		let result: unknown;
		for (const handler of seen.eventHandlers.get("before_agent_start") ?? []) {
			result = await handler({ type: "before_agent_start", prompt }, ctx);
		}
		return result;
	}

	test("injects the run header naming store and run for a prompt that says orchestrate", async () => {
		const root = fixture("server");
		writeLocator(root, "fx-epic");
		const result = (await header(root, "please orchestrate the ready beads")) as {
			message: { customType: string; display: boolean; attribution: string; content: string };
		};
		expect(result.message.customType).toBe("orc-run-header");
		expect(result.message.display).toBe(false);
		expect(result.message.attribution).toBe("user");
		expect(result.message.content).toContain("run epic: fx-epic");
		expect(result.message.content).toContain("store: fx (server mode)");
		expect(result.message.content).toContain("actor: omp/sess-2");
		expect(result.message.content).toContain("skill://orchestrate-with-bd");
		expect(result.message.content).toContain("orc_status.ready");
		expect(result.message.content).toContain("Never implementer, then its reviewer, then the next implementer");
	});

	test("stays silent for inline code, a file name, or a capitalised word", async () => {
		const root = fixture("server");
		expect(await header(root, "look at `orchestrate` here")).toBeUndefined();
		expect(await header(root, "open orchestrate.ts")).toBeUndefined();
		expect(await header(root, "Orchestrate the team")).toBeUndefined();
	});

	test("names the missing run when no locator is bound", () => {
		expect(runHeader(fixture("server"), "omp/x")).toContain("no run epic yet");
	});

	test("an embedded or missing store makes the header STOP-only: no contract, no skill to follow", () => {
		const embedded = runHeader(fixture("embedded"), "omp/x");
		expect(embedded).toContain("STOP.");
		expect(embedded).not.toContain("skill://");
		expect(embedded).not.toContain("Work in waves");
		expect(runHeader(fixture(null), "omp/x")).toContain("STOP.");
		expect(runHeader(fixture("server"), "omp/x")).not.toContain("STOP.");
	});
});

describe("store mutation gate in a stopped session", () => {
	test("recognises every bd invocation and every .beads/ path, and nothing else", () => {
		for (const cmd of ["bd init --shared-server --reinit-local", "env -u X bd export > i.jsonl && bd backup init /tmp/b", "bd export > issues.jsonl", "/usr/bin/bd bootstrap --yes", "cd x && bd dolt push", "bd list --json", "cat .beads/metadata.json", "echo '{}' > .beads/config.yaml"]) {
			expect(mutatesStore(cmd), cmd).toBe(true);
		}
		for (const cmd of ["git status", "bun test", "ls -la", "echo bdx", "cat README.md"]) {
			expect(mutatesStore(cmd), cmd).toBe(false);
		}
		expect(storeMutationBlock("bash", { command: "bd init --shared-server" })?.block).toBe(true);
		expect(storeMutationBlock("write", { path: "/r/.beads/metadata.json", content: "{}" })?.block).toBe(true);
		expect(storeMutationBlock("task", { tasks: [] })?.block).toBe(true);
		expect(storeMutationBlock("orc_claim", { bead: "x" })?.reason).toBe(STOP_REFUSAL);
		expect(storeMutationBlock("task", { tasks: [] }, "roles missing")?.reason).toBe("roles missing");
		expect(storeMutationBlock("bash", { command: "bd list --json" })?.block).toBe(true);
		expect(storeMutationBlock("bash", { command: "git status" })).toBeUndefined();
		expect(storeMutationBlock("read", { path: "/r/.beads/metadata.json" })).toBeUndefined();
	});

	test("only a session that received the STOP header is gated; a server-mode session is not", async () => {
		const { pi, seen } = recordingApi();
		orchestrateWithBd(pi);
		const resolveAll = { resolve: () => ({ id: "m" }) };
		const run = async (root: string, sessionId: string, models: { resolve(spec: string): unknown } = resolveAll, toolName = "bash") => {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId }, models };
			let header: string | undefined;
			for (const handler of seen.eventHandlers.get("before_agent_start") ?? []) header = ((await handler({ type: "before_agent_start", prompt: "orchestrate epic x" }, ctx)) as { message?: { content?: string } } | undefined)?.message?.content;
			let result: unknown;
			for (const handler of seen.eventHandlers.get("tool_call") ?? []) result = await handler({ type: "tool_call", toolName, input: toolName === "bash" ? { command: "bd init --shared-server --reinit-local" } : { tasks: [] } }, ctx);
			return { header, result: result as { block?: boolean; reason?: string; input?: unknown } | undefined };
		};
		expect((await run(fixture("embedded"), "stopped-1")).result?.block).toBe(true);
		const ok = await run(fixture("server"), "live-1");
		expect(ok.result?.block).toBeUndefined();
		expect(ok.header).toContain("skill://orchestrate-with-bd");
		expect((ok.result?.input as { env: { BEADS_ACTOR: string } }).env.BEADS_ACTOR).toBe("omp/live-1");
	});

	test("a server-mode session whose agents name an unresolvable alias gets the roles STOP and refuses dispatch", async () => {
		const { pi, seen } = recordingApi();
		orchestrateWithBd(pi);
		const ctx = {
			cwd: fixture("server"),
			sessionManager: { getSessionId: () => "roles-1" },
			models: { resolve: (spec: string) => (spec === "@slow" ? undefined : { id: "m" }) },
		};
		let header = "";
		for (const handler of seen.eventHandlers.get("before_agent_start") ?? []) header = ((await handler({ type: "before_agent_start", prompt: "orchestrate epic x" }, ctx)) as { message?: { content?: string } } | undefined)?.message?.content ?? "";
		expect(header).toContain("STOP.");
		expect(header).toContain("@slow (orc-implementer-max, orc-reviewer)");
		expect(header).toContain("modelRoles.slow");
		expect(header).not.toContain("skill://orchestrate-with-bd");
		let result: { block?: boolean; reason?: string } | undefined;
		for (const handler of seen.eventHandlers.get("tool_call") ?? []) result = (await handler({ type: "tool_call", toolName: "task", input: { tasks: [] } }, ctx)) as typeof result;
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("@slow");
		// A read stays allowed: only dispatch, the ledger, bd, and .beads/ writes are refused.
		for (const handler of seen.eventHandlers.get("tool_call") ?? []) result = (await handler({ type: "tool_call", toolName: "read", input: { path: "x" } }, ctx)) as typeof result;
		expect(result).toBeUndefined();
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
		const oldDispatch = record(sessionId, "dispatch-old", [["bead-redispached"]]);
		recordDispatch(oldDispatch);
		observeLifecycle({ id: "worker-old", agent: "orc-implementer", status: "aborted", parentToolCallId: oldDispatch.toolCallId, index: 0 });
		const newDispatch = record(sessionId, "dispatch-new", [["bead-redispached"]]);
		recordDispatch(newDispatch);
		observeLifecycle({ id: "worker-new", agent: "orc-implementer", status: "started", parentToolCallId: newDispatch.toolCallId, index: 0 });
		expect(workerFor(sessionId, "bead-redispached")).toMatchObject({ id: "worker-new", status: "started" });
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

describe("locator", () => {
	test("round-trips, ignores garbage, and keeps the gitignore inside the root", () => {
		const root = fixture(null);
		expect(readLocator(root)).toBeNull();
		writeLocator(root, "epic-1");
		expect(readLocator(root)).toEqual({ schema_version: 1, run_id: "epic-1", root_id: "epic-1" });
		expect(readFileSync(join(root, ".orchestration", ".gitignore"), "utf8")).toBe("*\n");
		writeFileSync(join(root, ".orchestration", ".active-run"), "{not json");
		expect(readLocator(root)).toBeNull();
		writeFileSync(join(root, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 2, run_id: "x" }));
		expect(readLocator(root)).toBeNull();
		writeFileSync(join(root, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "" }));
		expect(readLocator(root)).toBeNull();
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
		expect(argvs.map(a => a.slice(1).join(" "))).toEqual(["comment b-1 blocked: needs round.ts", "update b-1 --status blocked --json"]);
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

describe("orc_bind rebind in an isolated clone", () => {
	test("a child epic of the inherited run rebinds; an unrelated epic is refused", async () => {
		const root = fixture("server");
		writeLocator(root, "R");
		const { pi, seen } = recordingApi();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
		(pi as unknown as { registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }) => void }).registerTool = t => {
			seen.tools.push(t.name);
			tools.set(t.name, t);
		};
		orchestrateWithBd(pi);
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			const args = argv.slice(1).join(" ");
			let body = "[]";
			// The real `bd show` shape: a top-level `parent` and `{ id, dependency_type }` entries.
			if (args.startsWith("show R.2 ")) body = '[{"id":"R.2","issue_type":"epic","status":"open","assignee":"omp/me","parent":"R","dependencies":[{"id":"R","issue_type":"epic","dependency_type":"parent-child"}]}]';
			if (args.startsWith("show R.2.1 ")) body = '[{"id":"R.2.1","issue_type":"epic","status":"open","assignee":"omp/me","dependencies":[{"id":"R.2","dependency_type":"parent-child"}]}]';
			if (args.startsWith("show R.2.9 ")) body = '[{"id":"R.2.9","issue_type":"task","status":"open","dependencies":[{"id":"R.2","dependency_type":"parent-child"}]}]';
			if (args.startsWith("show OTHER ")) body = '{"id":"OTHER","issue_type":"epic","status":"open","dependencies":[]}';
			if (args.startsWith("update R.2 --claim")) body = '{"id":"R.2"}';
			if (args.startsWith("ready")) body = "[]";
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "me" } };
			const child = await tools.get("orc_bind")?.execute("x", { epic: "R.2" }, undefined, undefined, ctx);
			expect(child?.isError ?? false).toBe(false);
			// The clone now runs R.2 but the run root stays R, so R.2 is never asked for a DAG review.
			expect(readLocator(root)).toEqual({ schema_version: 1, run_id: "R.2", root_id: "R" });
			// Two levels down, with no top-level `parent` field: the dependency entry alone carries it.
			writeLocator(root, "R");
			const grandchild = await tools.get("orc_bind")?.execute("x", { epic: "R.2.1" }, undefined, undefined, ctx);
			expect(grandchild?.isError ?? false).toBe(false);
			expect(readLocator(root)).toEqual({ schema_version: 1, run_id: "R.2.1", root_id: "R" });
			// A task under the run is not a run: refused before any claim or write.
			writeLocator(root, "R");
			const taskUnderRun = await tools.get("orc_bind")?.execute("x", { epic: "R.2.9" }, undefined, undefined, ctx);
			expect(taskUnderRun?.isError).toBe(true);
			expect(taskUnderRun?.content[0]?.text).toContain("not an epic");
			expect(readLocator(root)?.run_id).toBe("R");
			writeLocator(root, "R");
			const other = await tools.get("orc_bind")?.execute("x", { epic: "OTHER" }, undefined, undefined, ctx);
			expect(other?.isError).toBe(true);
			expect(other?.content[0]?.text).toContain("already bound to R");
			expect(readLocator(root)?.run_id).toBe("R");
			// orc_status is a read: it never binds, and it names the bind tool when nothing is bound.
			rmSync(join(root, ".orchestration"), { recursive: true, force: true });
			const unbound = await tools.get("orc_status")?.execute("x", { epic: "R" }, undefined, undefined, ctx);
			expect(unbound?.isError).toBe(true);
			expect(unbound?.content[0]?.text).toContain("orc_bind");
			expect(readLocator(root)).toBeNull();
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("orc_bind claims the epic", () => {
	test("refuses to bind an epic another actor holds and writes no locator", async () => {
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
			// Already assigned: no claim attempted, no list walk, no locator.
			expect(argvs.some(a => a.includes("--claim"))).toBe(false);
			expect(readLocator(root)).toBeNull();
			// A task id is refused before any claim or locator write: a run binds an epic.
			spawn.mockImplementation(((argv: string[]) => {
				argvs.push(argv);
				return { stdout: new Response('{"id":"T","issue_type":"task","status":"open"}').body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
			}) as unknown as typeof Bun.spawn);
			const task = await tools.get("orc_bind")?.execute("x", { epic: "T" }, undefined, undefined, ctx);
			expect(task?.isError).toBe(true);
			expect(task?.content[0]?.text).toContain("not an epic");
			expect(argvs.some(a => a.includes("--claim"))).toBe(false);
			expect(readLocator(root)).toBeNull();
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("store mode refusal", () => {
	test("server mode passes; embedded and a missing store refuse, from the file alone", () => {
		expect(storeRefusal(fixture("server"))).toBeNull();
		expect(storeRefusal(fixture("embedded"))).toBe(NOT_SERVER_MODE);
		expect(storeRefusal(fixture(null))).toContain(NO_STORE);
		expect(NOT_SERVER_MODE).toContain("bd init --shared-server --reinit-local");
	});
});
describe("wave gate", () => {
	const wave = new Map([
		["w-1", { bead: "w-1", title: "one", role: "implementer", tier: "basic" as const, agent: "orc-implementer", isolated: true }],
		["w-2", { bead: "w-2", title: "two", role: "implementer", tier: "deep" as const, agent: "orc-implementer-deep", isolated: true }],
		["w-3", { bead: "w-3", title: "three", role: "reviewer", agent: "orc-reviewer", isolated: false }],
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
		["e-1.1", { bead: "e-1.1", title: "a", role: "implementer", tier: "basic" as const, agent: "orc-implementer", isolated: true }],
		["e-1.2", { bead: "e-1.2", title: "b", role: "implementer", tier: "deep" as const, agent: "orc-implementer-deep", isolated: true }],
		["e-1.10", { bead: "e-1.10", title: "r", role: "reviewer", agent: "orc-reviewer", isolated: false }],
	]);

	test("an item naming one wave bead gets that entry's agent and isolation; others are untouched", () => {
		const input = {
			tasks: [
				{ name: "A", agent: "orc-implementer", isolated: true, task: "Bead e-1.1: add subtract" },
				{ name: "B", agent: "orc-implementer", isolated: true, task: "Bead e-1.2: add safeDivide" },
				{ name: "R", agent: "orc-implementer", task: "Review bead e-1.10 against the merged diff" },
				{ name: "H", agent: "scout", task: "where is OPERATIONS defined?" },
			],
		};
		const routed = routeDispatch(input, wave) as { tasks: Array<Record<string, unknown>> };
		expect(routed.tasks[0]).toEqual(input.tasks[0]);
		expect(routed.tasks[1]).toMatchObject({ agent: "orc-implementer-deep", isolated: true });
		expect(routed.tasks[2]).toMatchObject({ agent: "orc-reviewer", isolated: false });
		expect(routed.tasks[3]).toEqual(input.tasks[3]);
	});

	test("a helper whose brief cites a wave bead is never rerouted; an item with no agent is", () => {
		const input = {
			tasks: [
				{ name: "S", agent: "scout", task: "For bead e-1.2: where is OPERATIONS defined?" },
				{ name: "O", agent: "operator", isolated: false, task: "Bead e-1.2: rename x to y" },
				{ name: "SR", agent: "security-reviewer", task: "Review the diff for e-1.2" },
				{ name: "N", task: "Bead e-1.2: add safeDivide" },
			],
		};
		const routed = routeDispatch(input, wave) as { tasks: Array<Record<string, unknown>> };
		expect(routed.tasks[0]).toEqual(input.tasks[0]);
		expect(routed.tasks[1]).toEqual(input.tasks[1]);
		expect(routed.tasks[2]).toEqual(input.tasks[2]);
		expect(routed.tasks[3]).toMatchObject({ agent: "orc-implementer-deep", isolated: true });
		expect(routeDispatch({ tasks: [{ agent: "scout", task: "e-1.2" }] }, wave)).toBeUndefined();
	});

	test("bead ids match whole, so e-1.1 does not claim an item about e-1.10, and a brief naming two beads is left alone", () => {
		expect(routeDispatch({ tasks: [{ agent: "orc-implementer", task: "e-1.10 only" }] }, wave)).toMatchObject({ tasks: [{ agent: "orc-reviewer" }] });
		expect(routeDispatch({ tasks: [{ agent: "orc-implementer", task: "e-1.1 and e-1.2 together" }] }, wave)).toBeUndefined();
	});

	test("nothing to change, an empty wave, or a non-object input returns undefined; the single-item shape is routed too", () => {
		expect(routeDispatch({ tasks: [{ agent: "orc-implementer-deep", isolated: true, task: "e-1.2" }] }, wave)).toBeUndefined();
		expect(routeDispatch({ tasks: [{ agent: "orc-implementer", task: "e-1.2" }] }, new Map())).toBeUndefined();
		expect(routeDispatch("x", wave)).toBeUndefined();
		expect(routeDispatch({ agent: "orc-implementer", task: "e-1.2" }, wave)).toMatchObject({ agent: "orc-implementer-deep", isolated: true });
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
			else if (verb === "list") body = Object.values(beads).filter(b => edgesOf(b as BdBead).some(d => d.type === "parent-child" && d.id === args[2]));
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
			expect((status2?.details as { wave: Array<{ bead: string; agent: string }> }).wave).toEqual([expect.objectContaining({ bead: "E.0", agent: "orc-reviewer", isolated: false })]);
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
			rmSync(join(root, ".orchestration"), { recursive: true, force: true });
		}
	});
});
