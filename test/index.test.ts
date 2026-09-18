import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, edgesOf } from "../src/bd";
import orchestrateWithBd, { MIGRATION_REFUSAL, mutatesStore, routeDispatch, runHeader, STOP_REFUSAL, storeMutationBlock } from "../src/index";
import { namedBeads, observeLifecycle, recordDispatch, waveGate, workerFor } from "../src/dispatch";
import { mentionsOrchestrate } from "../src/keyword";
import { backupEvidence, boundedMigration, type MigrationGate, migrationEligible, migrationGates, parseStableVersion, stableAtLeast } from "../src/migration";
import { readLocator, validateLocator, writeLocator } from "../src/run";
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
	test("registers exactly three events and nine tools, no commands, and reaches no runtime action", () => {
		const { pi, seen } = recordingApi();
		expect(() => orchestrateWithBd(pi)).not.toThrow();
		expect(seen.label).toBe("Orchestrate with bd");
		expect([...new Set(seen.events)].sort()).toEqual(["before_agent_start", "todo_reminder", "tool_call"]);
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

 test("names the missing run when no locator is bound", async () => {
		expect(await runHeader(fixture("server"), "omp/x")).toContain("no run epic yet");
	});

	test("an embedded or missing store makes the header STOP-only: no contract, no skill to follow", async () => {
		const embedded = await runHeader(fixture("embedded"), "omp/x");
		expect(embedded).toContain("STOP.");
		expect(embedded).not.toContain("skill://");
		expect(embedded).not.toContain("Work in waves");
		expect(await runHeader(fixture(null), "omp/x")).toContain("STOP.");
		expect(await runHeader(fixture("server"), "omp/x")).not.toContain("STOP.");
	});
});

describe("locator validation", () => {
	test("classifies missing, valid, closed, foreign, and unreadable locators", async () => {
		const root = fixture("server");
		const show = async (_id: string) => ({ id: "E", issue_type: "epic", status: "open", assignee: "omp/a" });
		expect((await validateLocator(root, "omp/a", show)).state).toBe("missing");
		writeLocator(root, "E");
		expect((await validateLocator(root, "omp/a", show)).state).toBe("valid");
		expect((await validateLocator(root, "omp/b", show)).state).toBe("stale");
		const closed = await validateLocator(root, "omp/a", async () => ({ id: "E", status: "closed", assignee: "omp/a" }));
		const unreadable = await validateLocator(root, "omp/a", async () => { throw new Error("offline"); });
		expect(closed.state).toBe("stale");
		expect(unreadable.state).toBe("stale");
		if (closed.state === "stale") expect(closed.reason).toContain("closed");
		if (unreadable.state === "stale") expect(unreadable.reason).toContain("unreadable: offline");
	});
});

describe("store mutation gate in a stopped session", () => {
	test("recognises complete bd and .beads path tokens, and nothing else", () => {
		for (const cmd of [
			"bd init --shared-server --reinit-local",
			"env -u X bd export > i.jsonl && bd backup init /tmp/b",
			"bd export > issues.jsonl",
			"/usr/bin/bd bootstrap --yes",
			"cd x && bd dolt push",
			"bd list --json",
			"b\\d export",
			"b''d export",
			["bd " + String.fromCharCode(92), "export"].join("\n"),
			"cat .beads/metadata.json",
			"cat /tmp/.beads/config.yaml",
			"echo '{}' > .beads/config.yaml",
			"echo '.beads'",
			"echo \\.beads",
			"echo .beads>/tmp/log",
			"echo .bea\\ds",
			"echo .be''ads",
			"rm -rf .beads",
			"mv .beads /tmp/x",
			"echo ok && rm -rf .beads",
			"dir=.beads/; rm -rf \"$dir\"",
			"dir=.beads; rm -rf \"$dir\"",
			`echo "x'"; bd delete x`,
		]) {
			expect(mutatesStore(cmd), cmd).toBe(true);
		}
		for (const cmd of [
			"git status",
			"bun test",
			"ls -la",
			"echo bdx",
			"cat README.md",
			"echo .beadsx",
			"cat archive.beads",
			"cat /tmp/archive.beads",
			"cat project.beads/notes",
			"dir=archive.beads; echo \"$dir\"",
			"dir=.beadsx; echo \"$dir\"",
			"echo \\\".beads\\\"",
			String.raw`printf '%s\n' x\;bd`,
			String.raw`printf '%s\n' x\;.beads`,
			String.raw`echo '.bea\ds'`,
			String.raw`echo ".bea\ds"`,
		]) {
			expect(mutatesStore(cmd), cmd).toBe(false);
		}
		expect(storeMutationBlock("bash", { command: "bd init --shared-server" })?.block).toBe(true);
		expect(storeMutationBlock("write", { path: "/r/.beads/metadata.json", content: "{}" })?.block).toBe(true);
		expect(storeMutationBlock("task", { tasks: [] })?.block).toBe(true);
		expect(storeMutationBlock("orc_claim", { bead: "x" })?.reason).toBe(STOP_REFUSAL);
		expect(storeMutationBlock("task", { tasks: [] }, { reason: "roles missing" })?.reason).toBe("roles missing");
		expect(storeMutationBlock("bash", { command: "bd list --json" })?.block).toBe(true);
		expect(storeMutationBlock("bash", { command: "echo '.beads'>/tmp/log" })?.block).toBe(true);
		expect(storeMutationBlock("bash", { command: "git status && echo archive.beads" })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: "echo .beadsx" })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: "dir=.beads/; rm -rf \"$dir\"" })?.block).toBe(true);
		expect(storeMutationBlock("bash", { command: "dir=.beads; rm -rf \"$dir\"" })?.block).toBe(true);
		expect(storeMutationBlock("bash", { command: "dir=archive.beads; echo \"$dir\"" })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: "dir=.beadsx; echo \"$dir\"" })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: "git status" })).toBeUndefined();
		expect(storeMutationBlock("read", { path: "/r/.beads/metadata.json" })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: "/usr/bin/bd export" })?.block).toBe(true);
		expect(storeMutationBlock("bash", { command: "./bd export" })?.block).toBe(true);
		expect(storeMutationBlock("bash", { command: "cat docs/bd/readme.md" })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: "echo bd/docs" })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: String.raw`cat archive\.beads` })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: String.raw`cat project\.beads/notes` })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: String.raw`echo x\bd` })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: String.raw`cat .beads\ notes` })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: String.raw`printf '%s\n' x\;bd` })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: String.raw`printf '%s\n' x\;.beads` })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: String.raw`echo '.bea\ds'` })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: String.raw`echo ".bea\ds"` })).toBeUndefined();
		expect(storeMutationBlock("bash", { command: `echo "x'"; bd delete x` })?.block).toBe(true);
		expect(storeMutationBlock("bash", { command: String.raw`echo .bea\ds` })?.block).toBe(true);
		expect(storeMutationBlock("bash", { command: String.raw`echo \.beads` })?.block).toBe(true);
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
			if (args.startsWith("show R ")) body = '{"id":"R","issue_type":"epic","status":"open","assignee":"omp/me","dependencies":[]}';
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
			expect(result?.content[0]?.text).toBe("epic E is held by omp/other; a lead binds only the epic it claims");
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

	test("claims an epic held by a configured queue alias", async () => {
		const root = fixture("server");
		const { pi, seen } = recordingApi();
		const tools = toolsFor(pi, seen);
		let assignee = "pool:orc-lead";
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			const command = argv.slice(1).join(" ");
			let body = "[]";
			if (command.startsWith("config get claim.pools ")) body = '{"key":"claim.pools","value":"pool:orc-lead,pool:orc-reviewer"}';
			if (command.startsWith("show E ")) body = JSON.stringify({ id: "E", issue_type: "epic", status: "in_progress", assignee, dependencies: [] });
			if (command.startsWith("update E --claim")) {
				assignee = "omp/me";
				body = JSON.stringify({ id: "E", issue_type: "epic", status: "in_progress", assignee });
			}
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "me" } };
			const result = await tools.get("orc_bind")?.execute("x", { epic: "E" }, undefined, undefined, ctx);
			expect(result?.isError ?? false).toBe(false);
			expect(boundAssignee(result)).toBe("omp/me");
		} finally {
			spawn.mockRestore();
		}
	});

	test("keeps binding an unassigned epic", async () => {
		const root = fixture("server");
		const { pi, seen } = recordingApi();
		const tools = toolsFor(pi, seen);
		let assignee: string | undefined;
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			const command = argv.slice(1).join(" ");
			let body = "[]";
			if (command.startsWith("show E ")) body = JSON.stringify({ id: "E", issue_type: "epic", status: "open", ...(assignee === undefined ? {} : { assignee }), dependencies: [] });
			if (command.startsWith("update E --claim")) {
				assignee = "omp/me";
				body = JSON.stringify({ id: "E", issue_type: "epic", status: "in_progress", assignee });
			}
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
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


/** A `bd` stand-in on `PATH`, so `bd-stable` is measured against a fixture rather than the host's install. */
function fakeBd(output: string): string {
	const bin = join(mkdtempSync(join(tmpdir(), "orc-bd-")), "bd");
	writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`);
	chmodSync(bin, 0o755);
	return bin;
}

/** An embedded checkout whose `bd backup` records prove a synced native backup outside it. */
function migratable(overrides: { created?: string; synced?: string; url?: string } = {}): { root: string; backup: string } {
	const root = fixture("embedded");
	const backup = mkdtempSync(join(tmpdir(), "orc-backup-"));
	writeFileSync(
		join(root, ".beads", "dolt-backup.json"),
		JSON.stringify({ backup_url: overrides.url ?? pathToFileURL(backup).href, backup_name: "default", created_at: overrides.created ?? "2026-09-17T05:09:11.046026Z" }),
	);
	writeFileSync(join(root, ".beads", "dolt-backup-state.json"), JSON.stringify({ last_sync: overrides.synced ?? "2026-09-17T05:09:13.813246Z", duration: "1.1s" }));
	return { root, backup };
}

/** Run `body` with `vars` in `process.env`, restoring every key afterwards. */
async function withEnv<T>(vars: Record<string, string>, body: () => Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(vars)) {
		saved[key] = process.env[key];
		process.env[key] = value;
	}
	try {
		return await body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("stable bd version parsing", () => {
	test("a stable release parses; a prerelease, a local build, or a fourth part does not", () => {
		expect(parseStableVersion("bd version 1.3.0 (f45b249ce)")).toEqual([1, 3, 0]);
		expect(parseStableVersion("v2.1.4")).toEqual([2, 1, 4]);
		for (const output of ["bd version 1.3.0-rc.1", "1.3.0+build.7", "1.3.0dev", "1.3.0.2", "bd version dev", ""]) {
			expect(parseStableVersion(output), output).toBeNull();
		}
	});

	test("the 1.3.0 floor accepts 1.3.0 and 2.x and rejects 1.2.2 and every unstable spelling", () => {
		for (const output of ["1.3.0", "bd version 1.3.1 (abc)", "2.0.0", "10.0.0"]) expect(stableAtLeast(output), output).toBe(true);
		for (const output of ["1.2.2", "0.9.9", "1.2.99", "1.3.0-rc.1", "1.3.0+build.7", ""]) expect(stableAtLeast(output), output).toBe(false);
	});
});

describe("backup evidence", () => {
	test("a synced local backup outside the checkout is evidence; nothing else is", () => {
		const { root, backup } = migratable();
		expect(backupEvidence(root)).toEqual({ dir: backup });
		expect(backupEvidence(fixture("embedded"))).toHaveProperty("missing");
		// A sync older than the backup proves nothing about the data the reinit is about to drop.
		expect(backupEvidence(migratable({ created: "2026-09-17T05:09:11Z", synced: "2026-09-17T05:00:00Z" }).root)).toHaveProperty("missing");
		// A remote backup cannot be restored by `bd backup restore --force <dir>`.
		expect(backupEvidence(migratable({ url: "s3://bucket/beads" }).root)).toHaveProperty("missing");
		expect(backupEvidence(migratable({ url: pathToFileURL(join(tmpdir(), "orc-gone-backup-does-not-exist")).href }).root)).toHaveProperty("missing");
		// A backup inside the checkout is destroyed by the same `--reinit-local` it exists to undo.
		const inside = migratable();
		writeFileSync(join(inside.root, ".beads", "dolt-backup.json"), JSON.stringify({ backup_url: pathToFileURL(join(inside.root, ".beads", "backup")).href, created_at: "2026-09-17T05:09:11Z" }));
		mkdirSync(join(inside.root, ".beads", "backup"));
		expect(backupEvidence(inside.root)).toHaveProperty("missing");
	});
});

describe("migration gates", () => {
	async function gatesFor(root: string, options: { bd?: string; clients?: string; migrator?: string; designated?: string; session?: string } = {}): Promise<Map<string, MigrationGate>> {
		const gates = await withEnv({ BD_BIN: options.bd ?? fakeBd("bd version 1.3.0 (f45b249ce)") }, () =>
			migrationGates(root, {
				session: options.session ?? "mig-1",
				designated: options.designated,
				env: { BEADS_MIGRATION_CLIENTS: options.clients ?? "1.3.0", BEADS_MIGRATION_MIGRATOR: options.migrator ?? "1" },
			}),
		);
		return new Map(gates.map(gate => [gate.name, gate]));
	}

	test("all five gates report; the four blocking ones are met and post-verification is owed", async () => {
		const { root, backup } = migratable();
		const gates = await gatesFor(root, { designated: "mig-1" });
		expect([...gates.keys()]).toEqual(["bd-stable", "clients-compatible", "backup-verified", "designated-migrator", "post-verification"]);
		expect(gates.get("bd-stable")?.state).toBe("met");
		expect(gates.get("clients-compatible")?.state).toBe("met");
		expect(gates.get("backup-verified")?.detail).toContain(backup);
		expect(gates.get("designated-migrator")?.state).toBe("met");
		// Owed, never a precondition: it cannot exist before the migration runs.
		expect(gates.get("post-verification")?.state).toBe("after");
		expect(migrationEligible([...gates.values()])).toBe(true);
	});

	test("each blocking gate fails closed on its own and sinks eligibility", async () => {
		const { root } = migratable();
		const cases: [string, { bd?: string; clients?: string; migrator?: string; designated?: string }][] = [
			["bd-stable", { bd: fakeBd("bd version 1.3.0-rc.1") }],
			["bd-stable", { bd: join(tmpdir(), "orc-no-such-bd-binary") }],
			["clients-compatible", { clients: "1.2.2" }],
			["clients-compatible", { clients: "" }],
			["designated-migrator", { migrator: "0" }],
			["designated-migrator", { designated: "another-session" }],
		];
		for (const [name, options] of cases) {
			const gates = await gatesFor(root, options);
			expect(gates.get(name)?.state, `${name} ${JSON.stringify(options)}`).toBe("missing");
			expect(migrationEligible([...gates.values()]), name).toBe(false);
		}
		const noBackup = await gatesFor(fixture("embedded"));
		expect(noBackup.get("backup-verified")?.state).toBe("missing");
		expect(migrationEligible([...noBackup.values()])).toBe(false);
		// An absent measurement is never a pass.
		expect(migrationEligible([])).toBe(false);
		expect(migrationEligible(undefined)).toBe(false);
	});
});

describe("boundedMigration", () => {
	test("allows the documented route including bd migrate --force", () => {
		for (const cmd of [
			"bd --version",
			"bd export",
			"bd export > issues.jsonl",
			"bd backup init /tmp/orc-b",
			"bd backup sync",
			"bd backup restore --force /tmp/orc-b",
			"bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix omp-orchestrate",
			"bd bootstrap",
			"bd bootstrap --yes",
			"bd dolt status",
			"bd dolt push",
			"bd dolt pull",
			"bd migrate --force",
			"bd migrate --force --yes --json",
			"bd list --all --json",
			"mv .beads/embeddeddolt /tmp/orc-b",
			"bd export > issues.jsonl && bd backup sync",
			"bd list --all --json | jq length",
			"git ls-remote origin 'refs/dolt/*'",
		]) {
			expect(boundedMigration(cmd), cmd).toBe(true);
		}
	});
	test("refuses every unbounded bd form and every destructive store path, while leaving controls allowed", () => {
		for (const cmd of [
			"bd delete x",
			"bd update x --claim",
			"bd close omp-1",
			"bd migrate",
			"bd migrate schema",
			"bd init --shared-server",
			"bd export > .beads/issues.jsonl",
			"mv .beads/embeddeddolt .beads/backup",
			"rm -rf .beads",
			"mv .beads /tmp/x",
			"echo '.beads'",
			"echo .beads>/tmp/log",
			"git status && rm -rf .beads",
			"bd list --all --json; bd delete x",
			"bd${IFS}delete x",
			`echo "x'"; bd delete x`,
			"b\\d delete x",
			"b''d delete x",
			["bd " + String.fromCharCode(92), "delete x"].join("\n"),
			"bd $(echo delete) x",
			"bd close `cat id`",
			"(bd delete x)",
			"bd import < issues.jsonl",
			"bd export > issues.jsonl && bd${IFS}delete x",
			"",
		]) {
			expect(boundedMigration(cmd), JSON.stringify(cmd)).toBe(false);
		}
		for (const cmd of [
			"echo .beadsx",
			"echo archive.beads",
			"echo /tmp/archive.beads",
			"echo project.beads/notes",
			"echo .beadsx && git status",
			String.raw`printf '%s\n' x\;bd`,
			String.raw`printf '%s\n' x\;.beads`,
			String.raw`echo '.bea\ds'`,
			String.raw`echo ".bea\ds"`,
		]) {
			expect(boundedMigration(cmd), JSON.stringify(cmd)).toBe(true);
		}
	});

});

describe("in-session migration admission", () => {
	interface GateResult {
		block?: boolean;
		reason?: string;
		input?: unknown;
	}

	async function session(
		root: string,
		sessionId: string,
		env: Record<string, string>,
	): Promise<{ header: string; call: (toolName: string, input: unknown) => Promise<GateResult | undefined> }> {
		const { pi, seen } = recordingApi();
		orchestrateWithBd(pi);
		const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId }, models: { resolve: () => ({ id: "m" }) } };
		const header = await withEnv(env, async () => {
			let content = "";
			for (const handler of seen.eventHandlers.get("before_agent_start") ?? []) {
				content = ((await handler({ type: "before_agent_start", prompt: "orchestrate epic x" }, ctx)) as { message?: { content?: string } } | undefined)?.message?.content ?? "";
			}
			return content;
		});
		const call = async (toolName: string, input: unknown): Promise<GateResult | undefined> => {
			let result: GateResult | undefined;
			for (const handler of seen.eventHandlers.get("tool_call") ?? []) result = (await handler({ type: "tool_call", toolName, input }, ctx)) as GateResult | undefined;
			return result;
		};
		return { header, call };
	}

	const met = (bd = "bd version 1.3.0 (f45b249ce)"): Record<string, string> => ({
		BD_BIN: fakeBd(bd),
		BEADS_MIGRATION_CLIENTS: "1.3.0",
		BEADS_MIGRATION_MIGRATOR: "1",
	});

	test("an admitted session gets the gate list and the bounded contract, not the lead contract", async () => {
		const { root, backup } = migratable();
		const { header } = await session(root, "mig-ok", met());
		expect(header).toContain("migration gates:");
		expect(header).toContain("bd-stable: met");
		expect(header).toContain("clients-compatible: met");
		expect(header).toContain(`backup-verified: met — native backup synced at ${backup}`);
		expect(header).toContain("designated-migrator: met");
		expect(header).toContain("post-verification: after");
		expect(header).toContain("MIGRATE, then stop.");
		expect(header).toContain("bd migrate --force");
		expect(header).not.toContain("STOP.");
		expect(header).not.toContain("skill://");
		expect(header).not.toContain("Work in waves");
	});

	test("an admitted session runs the bounded route and nothing else: no ledger, no dispatch", async () => {
		const { root } = migratable();
		const { call } = await session(root, "mig-tools", met());
		expect(await call("bash", { command: "bd export > issues.jsonl" })).toEqual({
			input: { command: "bd export > issues.jsonl", env: { BEADS_ACTOR: "omp/mig-tools" } },
		});
		expect((await call("bash", { command: "bd migrate --force" }))?.block).toBeUndefined();
		expect((await call("bash", { command: "bd dolt push" }))?.block).toBeUndefined();
		for (const command of ["bd delete omp-1", "bd update omp-1 --claim", "bd migrate schema", "bd${IFS}delete x", "b\\d delete x", "b''d delete x", ["bd " + String.fromCharCode(92), "delete x"].join("\n"), ".bea\\ds/metadata.json > /tmp/x", ".be''ads/metadata.json > /tmp/x", "bd $(echo close) omp-1", "rm -rf .beads", "mv .beads /tmp/x", "git status && rm -rf .beads"]) {
			const blocked = await call("bash", { command });
			expect(blocked?.block, command).toBe(true);
			expect(blocked?.reason, command).toBe(MIGRATION_REFUSAL);
		}
		for (const tool of ["task", "orc_bind", "orc_claim", "orc_finish", "orc_status"]) {
			const blocked = await call(tool, tool === "task" ? { tasks: [] } : { bead: "omp-1" });
			expect(blocked?.block, tool).toBe(true);
			expect(blocked?.reason, tool).toBe(MIGRATION_REFUSAL);
		}
		// The two files that carry `dolt_mode` and `dolt.shared-server` may be written; no other store file may.
		expect(await call("write", { path: join(root, ".beads", "metadata.json"), content: "{}" })).toBeUndefined();
		expect(await call("edit", { path: join(root, ".beads", "config.yaml"), content: "x" })).toBeUndefined();
		expect((await call("write", { path: join(root, ".beads", "dolt-backup.json"), content: "{}" }))?.block).toBe(true);
		expect(await call("read", { path: join(root, ".beads", "config.yaml") })).toBeUndefined();
	});

	test("one unmet gate keeps the STOP header, names it, and refuses everything", async () => {
		const { root } = migratable();
		const { header, call } = await session(root, "mig-no", { ...met(), BEADS_MIGRATION_CLIENTS: "1.2.2" });
		expect(header).toContain("STOP.");
		expect(header).toContain("Unmet migration gates");
		expect(header).toContain("clients-compatible");
		expect(header).not.toContain("MIGRATE, then stop.");
		expect(header).not.toContain("skill://");
		expect((await call("bash", { command: "bd export > issues.jsonl" }))?.reason).toBe(STOP_REFUSAL);
		expect((await call("write", { path: join(root, ".beads", "metadata.json"), content: "{}" }))?.block).toBe(true);
		expect(await call("bash", { command: "git status" })).toEqual({ input: { command: "git status", env: { BEADS_ACTOR: "omp/mig-no" } } });
	});

	test("a checkout with no readable store is never admitted, however the gates would measure", async () => {
		const { header, call } = await session(fixture(null), "mig-nostore", met());
		expect(header).toContain("STOP.");
		expect(header).not.toContain("migration gates:");
		expect((await call("bash", { command: "bd migrate --force" }))?.reason).toBe(STOP_REFUSAL);
	});

	test("two concurrent sessions on one checkout: only one is the designated migrator", async () => {
		const { root } = migratable();
		const { pi, seen } = recordingApi();
		orchestrateWithBd(pi);
		const handler = seen.eventHandlers.get("before_agent_start")?.[0];
		expect(handler).toBeDefined();
		const contents = await withEnv(met(), async () => {
			const start = (id: string) =>
				handler?.({ type: "before_agent_start", prompt: "orchestrate epic x" }, { cwd: root, sessionManager: { getSessionId: () => id }, models: { resolve: () => ({ id: "m" }) } }) as Promise<{
					message: { content: string };
				}>;
			// Both started before either awaits: the migrator slot must already be taken by then.
			const [first, second] = await Promise.all([start("race-a"), start("race-b")]);
			return [first.message.content, second.message.content];
		});
		expect(contents.filter(content => content.includes("MIGRATE, then stop.")).length).toBe(1);
		const refused = contents.find(content => !content.includes("MIGRATE, then stop."));
		expect(refused).toContain("STOP.");
		expect(refused).toContain("designated-migrator");
	});

	test("server mode is unchanged: the lead contract, no gate list, and dispatch allowed", async () => {
		const root = fixture("server");
		const { header, call } = await session(root, "server-ok", met());
		expect(header).toContain("skill://orchestrate-with-bd");
		expect(header).toContain("Work in waves");
		expect(header).not.toContain("migration gates:");
		expect(header).not.toContain("STOP.");
		expect(await call("task", { tasks: [] })).toBeUndefined();
		expect((await call("bash", { command: "bd list --json" }))?.block).toBeUndefined();
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
