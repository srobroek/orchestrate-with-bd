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

		await expect(spawnCommand(["never-exits"], "/tmp", { timeoutMs: 20 })).resolves.toEqual({
			code: 124,
			stdout: "",
			stderr: "timeout",
		});
		expect(kill).toHaveBeenCalledTimes(1);
		expect(spawnSpy).toHaveBeenCalledWith(["never-exits"], { cwd: "/tmp", stdout: "pipe", stderr: "pipe" });
	});
});
