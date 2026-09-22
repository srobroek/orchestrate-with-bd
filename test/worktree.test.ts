import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type CommandResult, type CommandRunner, forgeLanding, spawnCommand } from "../src/worktree";

let spawnSpy: { mockRestore(): void } | undefined;

describe("spawnCommand", () => {
	afterEach(() => {
		spawnSpy?.mockRestore();
	});

	test("kills a child that exceeds the timeout", async () => {
		const kill = mock();
		const exited = new Promise<number>(() => {});
		spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream(),
			stderr: new ReadableStream(),
			exited,
			kill,
		} as never);

		const result = await spawnCommand(["never-exits"], "/tmp", { timeoutMs: 20 });
		expect(result.code).toBe(124);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("timed out after 20ms");
		expect(kill).toHaveBeenCalledTimes(1);
		expect(spawnSpy).toHaveBeenCalledWith(["never-exits"], { cwd: "/tmp", stdout: "pipe", stderr: "pipe" });
	});
});

describe("forgeLanding", () => {
	const answer = (result: Partial<CommandResult>): CommandRunner => async () => ({ code: 0, stdout: "", stderr: "", ...result });

	test("a MERGED pull request on this head is landing, and names itself", async () => {
		expect(await forgeLanding("/repo", "omp/agent/T", answer({ stdout: '[{"number":471,"state":"MERGED"}]' }))).toEqual({ kind: "merged", pr: 471 });
	});

	test("asks the forge about one head, and reads the state rather than the count", async () => {
		const seen: string[][] = [];
		const run: CommandRunner = async argv => {
			seen.push([...argv]);
			return { code: 0, stdout: '[{"number":9,"state":"OPEN"},{"number":8,"state":"CLOSED"}]', stderr: "" };
		};
		// An unmerged pull request, and a closed one that never merged, are both not landing.
		expect(await forgeLanding("/repo", "omp/agent/T", run)).toEqual({ kind: "unlanded" });
		expect(seen).toEqual([["gh", "pr", "list", "--head", "omp/agent/T", "--state", "all", "--json", "number,state", "--limit", "20"]]);
	});

	test("no pull request at all is unlanded, not unknown", async () => {
		expect(await forgeLanding("/repo", "omp/agent/T", answer({ stdout: "[]" }))).toEqual({ kind: "unlanded" });
	});

	// Every remaining case must be `unknown`: calling unlanded work landed is the one loss that
	// cannot be undone, so nothing but an explicit MERGED state may produce `merged`.
	test("an absent gh names itself as the cause", async () => {
		expect(await forgeLanding("/repo", "b", answer({ code: 127, stderr: "gh: command not found" }))).toEqual({ kind: "unknown", detail: "gh is not installed" });
	});

	test("a refusal is carried through flattened, so a multi-line error reads as one notice", async () => {
		expect(await forgeLanding("/repo", "b", answer({ code: 4, stderr: "gh: not logged in\nrun: gh auth login\n" }))).toEqual({ kind: "unknown", detail: "gh: not logged in run: gh auth login" });
	});

	test("output that is not a list of records is unknown, never landing", async () => {
		expect(await forgeLanding("/repo", "b", answer({ stdout: "not json" }))).toMatchObject({ kind: "unknown" });
		expect(await forgeLanding("/repo", "b", answer({ stdout: '{"state":"MERGED"}' }))).toMatchObject({ kind: "unknown" });
		// A record whose number is missing cannot be named in remediation, so it is not landing.
		expect(await forgeLanding("/repo", "b", answer({ stdout: '[{"state":"MERGED"}]' }))).toEqual({ kind: "unlanded" });
	});
});