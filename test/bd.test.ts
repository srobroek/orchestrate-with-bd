import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { asBead, assembleBdEnv, bdCapabilities, bdList, bdRun, bdShow, clearBdCapabilityCache, metadataRecord, parsePayload } from "../src/bd";
import { descendants, readyWave, tierOf, waveItem } from "../src/dag";

describe("parsePayload", () => {
	test("skips a warning line printed before the payload", () => {
		expect(parsePayload('Warning: cold server\n{"id":"a"}')).toEqual({ id: "a" });
	});
	test("accepts a complete final line after warnings but rejects JSON substrings", () => {
		expect(parsePayload("warning\n[1,2]\n")).toEqual([1, 2]);
		expect(parsePayload("warning {\"id\":\"wrong\"}\nnot-json")).toBeUndefined();
		expect(parsePayload('prefix {"id":"wrong"} suffix')).toBeUndefined();
	});

	test("unwraps the schema_version envelope and accepts a bare value", () => {
		expect(parsePayload('{"schema_version":1,"data":[{"id":"a"}]}')).toEqual([{ id: "a" }]);
		expect(parsePayload('[{"id":"a"}]')).toEqual([{ id: "a" }]);
	});

	test("folds null, an empty envelope, and non-JSON into undefined", () => {
		expect(parsePayload("null")).toBeUndefined();
		expect(parsePayload('{"schema_version":1,"data":null}')).toBeUndefined();
		expect(parsePayload("no json here")).toBeUndefined();
		expect(parsePayload("{not json")).toBeUndefined();
	});
});

describe("metadataRecord and asBead", () => {
	test("stringified metadata is parsed onto the bead", () => {
		const bead = asBead({ id: "x", metadata: JSON.stringify({ role: "implementer" }) });
		expect(bead?.metadata).toEqual({ role: "implementer" });
		expect(metadataRecord("[1]")).toBeUndefined();
	});

	test("a value without a string id is not a bead", () => {
		expect(asBead({ status: "open" })).toBeNull();
		expect(asBead(null)).toBeNull();
		expect(asBead({ id: 7 })).toBeNull();
	});
});

describe("bd capability detection", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => {
		spawn.mockReset();
		clearBdCapabilityCache();
	});

	test("detects native primitives once for a checkout", async () => {
		let versions = 0;
		spawn.mockImplementation(((argv: string[]) => {
			if (argv[1] === "--version") versions++;
			return { stdout: new Response("bd version 1.3.0").body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		const first = await bdCapabilities("/tmp/cap-native");
		const second = await bdCapabilities("/tmp/cap-native");
		expect(first).toEqual({ leases: true, cas: true, brief: true, briefDeps: true });
		expect(second).toBe(first);
		expect(versions).toBe(1);
	});

	test("falls back when the client is older than 1.3", async () => {
		spawn.mockImplementation((() => ({ stdout: new Response("bd version 1.2.2").body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined })) as unknown as typeof Bun.spawn);
		expect(await bdCapabilities("/tmp/cap-old")).toEqual({ leases: false, cas: false, brief: false, briefDeps: false });
	});

	test("adds brief only on the native ready path", async () => {
		const commands: string[][] = [];
		spawn.mockImplementation(((argv: string[]) => {
			const args = argv.slice(1);
			commands.push(args);
			const body = args[0] === "--version" ? "bd version 1.3.0" : "[{\"id\":\"e-1\",\"issue_type\":\"task\",\"status\":\"open\"}]";
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		await readyWave("e", [], "/tmp/cap-brief");
		expect(commands[1]).toContain("--brief");
	});
});

describe("bdRun store routing", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());

	/**
	 * This plugin's store is one embedded Dolt database in the canonical checkout. A stale inherited
	 * server override can outrank the store's own `dolt_mode` and redirect every ledger call to the
	 * retired backend, where the database is absent or credentials are wrong.
	 */
	test("drops an inherited retired-server override, so the embedded store answers", async () => {
		const before = process.env.BEADS_DOLT_SHARED_SERVER;
		process.env.BEADS_DOLT_SHARED_SERVER = "true";
		const spawned: Array<Record<string, string | undefined> | undefined> = [];
		spawn.mockImplementation(((_argv: string[], options?: { env?: Record<string, string | undefined> }) => {
			spawned.push(options?.env);
			return { stdout: new Response("[]").body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		try {
			await bdRun(["list"], "/tmp/routing");
			expect(spawned[0]).not.toHaveProperty("BEADS_DOLT_SHARED_SERVER");
			expect(spawned[0]?.PATH).toBe(process.env.PATH);
			expect(process.env.BEADS_DOLT_SHARED_SERVER).toBe("true");
		} finally {
			if (before === undefined) delete process.env.BEADS_DOLT_SHARED_SERVER;
			else process.env.BEADS_DOLT_SHARED_SERVER = before;
		}
	});
	test("retries exact lock contention and returns the succeeding result", async () => {
		let calls = 0;
		spawn.mockImplementation((() => {
			calls++;
			const locked = calls === 1;
			return { stdout: new Response(locked ? "" : "ok").body, stderr: new Response(locked ? "lock busy: held by another process" : "").body, exited: Promise.resolve(locked ? 1 : 0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		expect(await bdRun(["update", "bead"], "/tmp/retry")).toEqual({ code: 0, stdout: "ok", stderr: "" });
		expect(calls).toBe(2);
	});

	/**
	 * Dolt's own wording, recorded verbatim from this project's store evidence. bd passes it
	 * through rather than rewriting it into one of the gate phrases above, so a predicate built
	 * only from those phrases returns immediately on the contention a pull loop actually meets.
	 */
	test("retries the Dolt lock message bd passes through unchanged", async () => {
		const dolt = "database dolt is locked by another process; either clone the database to run a second server, or stop the dolt process which currently holds an exclusive write lock.";
		let calls = 0;
		spawn.mockImplementation((() => {
			calls++;
			const locked = calls === 1;
			return { stdout: new Response(locked ? "" : "ok").body, stderr: new Response(locked ? dolt : "").body, exited: Promise.resolve(locked ? 1 : 0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		expect(await bdRun(["update", "bead"], "/tmp/retry")).toEqual({ code: 0, stdout: "ok", stderr: "" });
		expect(calls).toBe(2);
	});

	/** A failure that merely mentions locking is not contention, so it must surface at once. */
	test("does not retry a failure that only mentions a lock", async () => {
		spawn.mockImplementation((() => ({ stdout: new Response("").body, stderr: new Response("cannot acquire write lock: schema is out of date").body, exited: Promise.resolve(1), kill: () => undefined })) as unknown as typeof Bun.spawn);
		await bdRun(["update", "bead"], "/tmp/retry");
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	test("exhausts lock retries and returns the original failure", async () => {
		let calls = 0;
		spawn.mockImplementation((() => {
			calls++;
			return { stdout: new Response("").body, stderr: new Response("lock already held by another process").body, exited: Promise.resolve(1), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		const started = performance.now();
		expect(await bdRun(["update", "bead"], "/tmp/retry")).toEqual({ code: 1, stdout: "", stderr: "lock already held by another process" });
		expect(calls).toBe(4);
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	test("does not retry a guard mismatch", async () => {
		spawn.mockImplementation((() => ({ stdout: new Response("").body, stderr: new Response("guard mismatch").body, exited: Promise.resolve(13), kill: () => undefined })) as unknown as typeof Bun.spawn);
		await bdRun(["update", "bead"], "/tmp/retry");
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	test("does not retry an unrelated failure", async () => {
		spawn.mockImplementation((() => ({ stdout: new Response("").body, stderr: new Response("missing bead").body, exited: Promise.resolve(1), kill: () => undefined })) as unknown as typeof Bun.spawn);
		await bdRun(["update", "bead"], "/tmp/retry");
		expect(spawn).toHaveBeenCalledTimes(1);
	});
 });

describe("BEADS_DIR pinning", () => {
	// One spy for the whole describe, reset between tests. NEVER mockRestore() here: this
	// file installs a spy per describe, and restoring puts the real Bun.spawn back for
	// every later describe, which sends the rest of the suite at the real `bd` binary.
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());

	test("preserves an inherited pin and lets a call-specific value overlay it", () => {
		const before = process.env.BEADS_DIR;
		process.env.BEADS_DIR = "/tmp/inherited/.beads";
		try {
			expect(assembleBdEnv()).toHaveProperty("BEADS_DIR", "/tmp/inherited/.beads");
			expect(assembleBdEnv({ BEADS_DIR: "/tmp/call/.beads" })).toHaveProperty("BEADS_DIR", "/tmp/call/.beads");
		} finally {
			if (before === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = before;
		}
	});

	test("rejects a pin from a different repository", async () => {
		// The identity probe answers a different common dir for the pinned path than for the
		// checkout, which is exactly what makes the pin foreign.
		spawn.mockImplementation(((argv: string[]) => {
			const target = argv[2] ?? "";
			const common = target === "/tmp/foreign" ? "/foreign/.git\n" : "/ledger/.git\n";
			return { stdout: new Response(common).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		await expect(bdRun(["list"], process.cwd(), { BEADS_DIR: "/tmp/foreign/.beads" })).rejects.toThrow("BEADS_DIR points at");
	});
});

describe("bdShow", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());
	function answer(stdout: string): void {
		spawn.mockImplementation(
			(() => ({
				stdout: new Response(stdout).body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => undefined,
			})) as unknown as typeof Bun.spawn,
		);
	}

	test("accepts an object or a one-element array", async () => {
		answer('{"id":"a","status":"open"}');
		expect((await bdShow("a", "/tmp")).status).toBe("open");
		answer('[{"id":"a","status":"closed"}]');
		expect((await bdShow("a", "/tmp")).status).toBe("closed");
	});

	test("throws when the payload yields no bead", async () => {
		answer("[]");
		expect(bdShow("a", "/tmp")).rejects.toThrow("returned no bead");
	});

	test("passes brief dependency flags to show", async () => {
		const argvs: string[][] = [];
		spawn.mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			return { stdout: new Response('{"id":"a","status":"open"}').body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		await bdShow("a", "/tmp", {}, ["--brief-deps"]);
		expect(argvs[0]?.slice(1)).toEqual(["show", "a", "--brief-deps", "--json"]);
	});
});

describe("readyWave", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());

	test("three-tier: ready child epics, minus those whose open tasks are all gated", async () => {
		const argvs: string[][] = [];
		spawn.mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			const args = argv.slice(1).join(" ");
			let body = "[]";
			// Epic tier: bd says R.1, R.2 and R.4 are unblocked (R.3 is blocked by R.1; a bound
			// epic would be in_progress and absent). Task tier: R.1 has a ready task; R.2's only
			// task waits on an open decision; R.4 has no tasks at all.
			if (args.startsWith("ready --type epic")) body = '[{"id":"R.1","issue_type":"epic","status":"open"},{"id":"R.2","issue_type":"epic","status":"open"},{"id":"R.4","issue_type":"epic","status":"open"},{"id":"R.1.9","issue_type":"epic","status":"open"}]';
			else if (args.startsWith("ready --parent R.1 ")) body = '[{"id":"R.1.1","issue_type":"task","status":"open"}]';
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		const child = (id: string, parent: string, type = "epic", status = "open") => ({ id, issue_type: type, status, dependencies: [{ depends_on_id: parent, type: "parent-child" }] });
		const beads = [child("R.1", "R"), child("R.2", "R"), child("R.3", "R"), child("R.4", "R"), child("R.1.1", "R.1", "task"), child("R.2.1", "R.2", "task"), child("R.3.1", "R.3", "task")];
		const wave = await readyWave("R", beads, "/tmp");
		expect(wave.map(bead => bead.id)).toEqual(["R.1", "R.4"]);
		expect(argvs[1]?.slice(1)).toEqual(["ready", "--type", "epic", "--parent", "R", "--unassigned", "--limit", "0", "--json"]);
		// The task-tier check ran for the two epics with open tasks and not for the empty one.
		expect(argvs.slice(2).map(a => a[3])).toEqual(["R.1", "R.2"]);
	});

	test("two-tier: ready task beads only; an open decision under the epic is never dispatched", async () => {
		spawn.mockImplementation((() => ({
			stdout: new Response('[{"id":"E.1","issue_type":"task","status":"open"},{"id":"E.2","issue_type":"decision","status":"open"},{"id":"E.3","issue_type":"task","status":"open"}]').body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
			kill: () => undefined,
		})) as unknown as typeof Bun.spawn);
		const child = (id: string, type: string) => ({ id, issue_type: type, status: "open", dependencies: [{ depends_on_id: "E", type: "parent-child" }] });
		const wave = await readyWave("E", [child("E.1", "task"), child("E.2", "decision"), child("E.3", "task")], "/tmp");
		expect(wave.map(bead => bead.id)).toEqual(["E.1", "E.3"]);
	});

	test("three-tier, all child epics closed: the wave is the ready tasks directly under the run epic", async () => {
		const argvs: string[][] = [];
		spawn.mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			// bd ready lists the root-level review and a stray ready task inside a closed epic.
			return {
				stdout: new Response('[{"id":"R.9","issue_type":"task","status":"open"},{"id":"R.1.7","issue_type":"task","status":"open"},{"id":"R.8","issue_type":"decision","status":"open"}]').body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => undefined,
			};
		}) as unknown as typeof Bun.spawn);
		const child = (id: string, parent: string, type: string, status: string) => ({ id, issue_type: type, status, dependencies: [{ depends_on_id: parent, type: "parent-child" }] });
		const beads = [child("R.1", "R", "epic", "closed"), child("R.2", "R", "epic", "closed"), child("R.9", "R", "task", "open"), child("R.1.7", "R.1", "task", "closed"), child("R.8", "R", "decision", "open")];
		const wave = await readyWave("R", beads, "/tmp");
		// R.8, an open root decision, is the lead's to close and never a reviewer's wave item.
		expect(wave.map(bead => bead.id)).toEqual(["R.9"]);
		// No epic-tier query: the epics are done, the wave is the run epic's own tasks.
		expect(argvs.map(a => a.slice(1).join(" "))).toEqual(["ready --parent R --unassigned --limit 0 --json"]);
	});

	test("three-tier: a closed child epic with an open descendant keeps the run's own tasks out of the wave", async () => {
		const argvs: string[][] = [];
		spawn.mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			return { stdout: new Response("[]").body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		const child = (id: string, parent: string, type: string, status: string) => ({ id, issue_type: type, status, dependencies: [{ depends_on_id: parent, type: "parent-child" }] });
		const beads = [child("R.1", "R", "epic", "closed"), child("R.9", "R", "task", "open"), child("R.1.3", "R.1", "task", "open")];
		const wave = await readyWave("R", beads, "/tmp");
		expect(wave).toEqual([]);
		// Still the epic tier: the query asked for epics, and none is ready.
		expect(argvs[0]?.slice(1, 3)).toEqual(["ready", "--type"]);
	});

	test("two-tier: asks bd ready for unassigned descendants and drops epics", async () => {
		const argvs: string[][] = [];
		spawn.mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			return {
				stdout: new Response('[{"id":"e-1","issue_type":"task","title":"a"},{"id":"e-2","issue_type":"epic","title":"child"},{"id":"e-3","issue_type":"task","title":"c"}]').body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => undefined,
			};
		}) as unknown as typeof Bun.spawn);
		const wave = await readyWave("e", [], "/tmp");
		expect(argvs[0]?.slice(1)).toEqual(["ready", "--parent", "e", "--unassigned", "--limit", "0", "--json"]);
		expect(wave.map(bead => bead.id)).toEqual(["e-1", "e-3"]);
	});
});

describe("bdList", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());

	function answer(stdout: string): void {
		spawn.mockImplementation(
			(() => ({
				stdout: new Response(stdout).body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => undefined,
			})) as unknown as typeof Bun.spawn,
		);
	}

	test("an explicit empty array is the only empty list", async () => {
		answer("[]");
		expect(await bdList(["--parent", "x"], "/tmp")).toEqual([]);
		answer('{"id":"only"}');
		expect((await bdList([], "/tmp")).map(bead => bead.id)).toEqual(["only"]);
	});

	test("no payload, a truncated payload, or a row without an id throws", async () => {
		answer("");
		expect(bdList([], "/tmp")).rejects.toThrow("no JSON array");
		answer('[{"id":"a"},{"id":"b"');
		expect(bdList([], "/tmp")).rejects.toThrow("no JSON array");
		answer('[{"id":"a"},{"title":"no id"}]');
		expect(bdList([], "/tmp")).rejects.toThrow("without an id");
	});
});

describe("waveItem", () => {
	const bead = (over: Record<string, unknown>) => ({ id: "e-1", title: "t", issue_type: "task", ...over }) as Parameters<typeof waveItem>[0];

	test("tier: missing is basic, unrecognised is deep, never routes hard work down", () => {
		expect(tierOf(undefined)).toBe("basic");
		expect(tierOf({ tier: "" })).toBe("basic");
		expect(tierOf({ tier: "max" })).toBe("max");
		expect(tierOf({ tier: "MAX" })).toBe("deep");
		expect(tierOf({ tier: 3 })).toBe("deep");
	});

	test("routes by issue type, role, and tier", () => {
		expect(waveItem(bead({ issue_type: "epic" }))).toMatchObject({ role: "lead", agent: "orc-lead" });
		expect(waveItem(bead({}))).toMatchObject({ role: "implementer", tier: "basic", agent: "orc-implementer" });
		expect(waveItem(bead({ metadata: { tier: "deep" } }))).toMatchObject({ tier: "deep", agent: "orc-implementer-deep" });
		expect(waveItem(bead({ metadata: '{"tier":"max","role":"implementer"}' }))).toMatchObject({ tier: "max", agent: "orc-implementer-max" });
		expect(waveItem(bead({ metadata: { role: "reviewer", tier: "max" } }))).toMatchObject({ role: "reviewer", agent: "orc-reviewer" });
		expect(waveItem(bead({ metadata: { role: "reviewer" } })).tier).toBeUndefined();
		expect(waveItem(bead({ metadata: { role: "researcher" } }))).toMatchObject({ agent: "orc-researcher" });
		expect(waveItem(bead({ metadata: { role: "shepherd" } }))).toMatchObject({ agent: "orc-shepherd" });
		expect(waveItem(bead({ metadata: { role: "unknown-role" } }))).toMatchObject({ role: "unknown-role", agent: "orc-implementer" });
	});
});
