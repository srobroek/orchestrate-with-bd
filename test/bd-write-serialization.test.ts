import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { BdAuthenticationError, bdJson } from "../src/bd";

type Spawn = typeof Bun.spawn;

type MockProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

function processResult(stdout: string, code: number, stderr = ""): MockProcess {
	return {
		stdout: new Response(stdout).body,
		stderr: new Response(stderr).body,
		exited: Promise.resolve(code),
		kill: () => undefined,
	} as unknown as MockProcess;
}

function deferredProcess(
	stdout: string,
	code: number,
	stderr = "",
): MockProcess & { finish: () => void } {
	let resolveExit: (code: number) => void = () => undefined;
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	return {
		stdout: new Response(stdout).body,
		stderr: new Response(stderr).body,
		exited,
		kill: () => resolveExit(-1),
		finish: () => resolveExit(code),
	} as MockProcess & { finish: () => void };
}

/** A promise plus its resolver, so a case awaits an event the mock fires. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>(settle => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe("bd write scheduling", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());

	test("serialises concurrent writes in one process", async () => {
		const events: string[] = [];
		const processes: Array<MockProcess & { finish: () => void }> = [];
		const arrivals = [deferred(), deferred()] as const;
		spawn.mockImplementation(((argv: string[]) => {
			// Answer the capability probe the way the sibling cases below do. Without it the probe
			// takes processes[0], so finishing that index completes the probe instead of the first
			// write and neither deferred write ever resolves. Relying on another case to warm the
			// per-process capability cache first makes this one order-dependent.
			if (argv[1] === "--version") return processResult("bd version 1.3.0", 0);
			const bead = argv[2] ?? "unknown";
			events.push(`start:${bead}`);
			const result = deferredProcess(JSON.stringify({ id: bead }), 0);
			const finish = result.finish;
			result.finish = () => {
				events.push(`end:${bead}`);
				finish();
			};
			processes.push(result);
			arrivals[processes.length - 1]?.resolve();
			return result;
		}) as unknown as Spawn);

		const first = bdJson(
			["update", "first", "--status", "blocked", "--json"],
			"/tmp/bd-queue",
		);
		const second = bdJson(
			["update", "second", "--status", "blocked", "--json"],
			"/tmp/bd-queue",
		);
		// Await the spawn itself rather than a tick count: `bdJson` awaits repository identity
		// before it spawns, so how many microtasks pass first is not part of this contract.
		await arrivals[0].promise;
		processes[0]?.finish();
		await first;
		await arrivals[1].promise;
		processes[1]?.finish();
		await second;

		expect(events).toEqual([
			"start:first",
			"end:first",
			"start:second",
			"end:second",
		]);
	});

	test("retries a workspace-gate refusal with backoff", async () => {
		let attempts = 0;
		spawn.mockImplementation(((argv: string[]) => {
			if (argv[1] === "--version") return processResult("bd version 1.3.0", 0);
			attempts++;
			return attempts < 3
				? processResult(
						"",
						1,
						"workspace gate refused: another writer holds the lock",
					)
				: processResult(JSON.stringify({ id: "gate" }), 0);
		}) as unknown as Spawn);

		const result = bdJson(["close", "gate", "--json"], "/tmp/bd-gate");
		await expect(result).resolves.toEqual({ id: "gate" });
		expect(attempts).toBe(3);
	});

	test("does not retry access denial", async () => {
		let attempts = 0;
		spawn.mockImplementation((() => {
			attempts++;
			return processResult("", 1, "access denied: credentials rejected");
		}) as unknown as Spawn);

		await expect(
			bdJson(["close", "denied", "--json"], "/tmp/bd-denied"),
		).rejects.toThrow("access denied");
		expect(attempts).toBe(1);
	});
	test("does not retry a comment after a gate refusal", async () => {
		let attempts = 0;
		spawn.mockImplementation((() => {
			attempts++;
			return processResult(
				"",
				1,
				"workspace gate refused: another writer holds the lock",
			);
		}) as unknown as Spawn);

		await expect(
			bdJson(["comment", "note", "once"], "/tmp/bd-comment"),
		).rejects.toThrow("workspace gate refused");
		expect(attempts).toBe(1);
	});

	test("reconciles an indeterminate write with a read-back", async () => {
		const commands: string[] = [];
		spawn.mockImplementation(((argv: string[]) => {
			const [verb] = argv.slice(1);
			commands.push(verb ?? "");
			if (verb === "update")
				return processResult(
					"",
					1,
					"commit result indeterminate: the transaction may have committed",
				);
			if (verb === "show")
				return processResult(
					JSON.stringify({ id: "ambiguous", status: "blocked" }),
					0,
				);
			return processResult("", 1, "unexpected command");
		}) as unknown as Spawn);

		await expect(
			bdJson(
				["update", "ambiguous", "--status", "blocked", "--json"],
				"/tmp/bd-ambiguous",
			),
		).resolves.toEqual({ id: "ambiguous", status: "blocked" });
		expect(commands).toEqual(["update", "show"]);
	});

	test("a credential failure on a write still raises BdAuthenticationError", async () => {
		// This serialisation path replaced the bdJson that classified authentication failures,
		// so without this assertion the credential path can be dropped by a merge and every
		// caller silently receives a generic BdError instead.
		spawn.mockImplementation((() =>
			processResult("", 1, "ERROR 1045 (28000): Access denied for user 'beads'")) as unknown as Spawn);

		const failure = bdJson(["close", "bd-1", "--json"], "/tmp/bd-auth");
		await expect(failure).rejects.toBeInstanceOf(BdAuthenticationError);
		// A gate refusal is retried; a credential refusal must not be, so exactly one spawn.
		expect(spawn).toHaveBeenCalledTimes(1);
	});
});
