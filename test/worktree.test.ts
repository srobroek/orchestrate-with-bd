import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnCommand } from "../src/worktree";

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