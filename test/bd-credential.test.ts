import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { assembleBdEnv, bdCapabilities, bdShow } from "../src/bd";

describe("bd environment and authentication failures", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());

	test("assembles the shared server credential and process safety flags", async () => {
		let observed: Record<string, string | undefined> | undefined;
		spawn.mockImplementation(((_argv: string[], options: { env?: Record<string, string> }) => {
			observed = options.env;
			return { stdout: new Response("bd version 1.3.0").body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}) as unknown as typeof Bun.spawn);
		await bdCapabilities("/tmp/env-proof");
		expect(observed).toMatchObject({ BEADS_DOLT_SERVER_USER: "beads", BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1", BD_DOLT_AUTO_START: "false", NO_COLOR: "1" });
		expect(observed).not.toHaveProperty("BEADS_DIR");
		expect(assembleBdEnv({ BEADS_DOLT_SERVER_USER: "  ", BEADS_DIR: "/foreign" })).toMatchObject({ BEADS_DOLT_SERVER_USER: "beads" });
	});

	test("classifies Dolt authentication failures with the credential remediation", async () => {
		spawn.mockImplementation((() => ({ stdout: new Response("").body, stderr: new Response("Error 1045 (28000): Access denied for user 'root'").body, exited: Promise.resolve(1), kill: () => undefined })) as unknown as typeof Bun.spawn);
		await expect(bdShow("missing", "/tmp/auth-proof")).rejects.toThrow(/BEADS_DOLT_SERVER_USER=beads.*gastownhall\/beads#6598/);
	});
});
