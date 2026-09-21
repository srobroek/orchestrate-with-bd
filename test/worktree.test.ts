import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCommand } from "../src/worktree";

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
