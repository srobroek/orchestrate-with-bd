import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { assembleBdEnv, bdCapabilities, bdShow } from "../src/bd";

describe("bd environment and authentication failures", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());

	test("does not inject a retired server credential and preserves process safety flags", async () => {
		let observed: Record<string, string | undefined> | undefined;
		spawn.mockImplementation(((_argv: string[], options: { env?: Record<string, string> }) => {
			observed = options.env;
			return { stdout: new Response("bd version 1.3.0").body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		await bdCapabilities("/tmp/env-proof");
		expect(observed).not.toHaveProperty("BEADS_DOLT_SERVER_USER");
		expect(observed).toMatchObject({ BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1", BD_DOLT_AUTO_START: "false", NO_COLOR: "1" });

		expect(assembleBdEnv({ BEADS_DIR: "/foreign" })).not.toHaveProperty("BEADS_DOLT_SERVER_USER");
		expect(assembleBdEnv({ BEADS_DOLT_SERVER_USER: "custom", BEADS_DIR: "/foreign" })).toHaveProperty("BEADS_DOLT_SERVER_USER", "custom");
	});

	test("classifies a Dolt authentication failure and passes its message through unchanged", async () => {
		spawn.mockImplementation((() => ({ stdout: new Response("").body, stderr: new Response("Error 1045 (28000): Access denied for user 'root'").body, exited: Promise.resolve(1), kill: () => undefined })) as unknown as typeof Bun.spawn);
		// The retired server's remediation text is gone: bd's own stderr ends the message.
		await expect(bdShow("missing", "/tmp/auth-proof")).rejects.toThrow(/exited 1: Error 1045 \(28000\): Access denied for user 'root'$/);
		await expect(bdShow("missing", "/tmp/auth-proof")).rejects.not.toThrow(/credential|installation|BEADS_DOLT_SERVER_USER/);
	});

});
