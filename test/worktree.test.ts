import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandResult, type CommandRunner, forgeLanding, spawnCommand } from "../src/worktree";

describe("spawnCommand", () => {
	test("a timeout returns only after its descendant has left the process table", async () => {
		// This exercises real OS process lifetime; fake timers cannot advance or inspect a
		// separately spawned process.
		const root = mkdtempSync(join(tmpdir(), "orc-command-timeout-"));
		const pidFile = join(root, "child-pid");
		const child = "await Bun.sleep(10_000);";
		const parent = [
			`const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { stdout: "ignore", stderr: "ignore" });`,
			`await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));`,
			"await Bun.sleep(10_000);",
		].join("\n");
		let childPid: number | undefined;
		try {
			const result = await spawnCommand([process.execPath, "-e", parent], root, { timeoutMs: 300 });
			expect(result.code).toBe(124);
			childPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
			let alive = true;
			try {
				process.kill(childPid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
			}
			expect(alive).toBe(false);
		} finally {
			if (childPid !== undefined) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {
					// Already gone, as the assertion requires.
				}
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a foreground wrapper exit does not leave its same-group child alive", async () => {
		const child = "await Bun.sleep(10_000);";
		const parent = `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { stdout: "ignore", stderr: "ignore" }); child.unref(); console.log(child.pid);`;
		const result = await spawnCommand([process.execPath, "-e", parent], tmpdir(), { timeoutMs: 2_000 });
		expect(result.code).toBe(0);
		const childPid = Number.parseInt(result.stdout.trim(), 10);
		let alive = true;
		try {
			process.kill(childPid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
		}
		expect(alive).toBe(false);
	});

	test("a timeout does not await a never-settling proc.exited promise", async () => {
		const spawn = spyOn(Bun, "spawn").mockReturnValue({
			pid: 2_147_483_647,
			stdout: new Response("").body,
			stderr: new Response("").body,
			exited: new Promise<number>(() => {}),
			kill: () => undefined,
		} as never);
		try {
			const result = await spawnCommand(["never-settles"], tmpdir(), { timeoutMs: 20 });
			expect(result.code).toBe(124);
			expect(result.stderr).toContain("timed out after 20ms");
		} finally {
			spawn.mockRestore();
		}
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
