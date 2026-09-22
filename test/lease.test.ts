import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearBdCapabilityCache } from "../src/bd";
import { observeLifecycle, recordDispatch, startedHoldings } from "../src/dispatch";
import { lostLeases, renewStartedHoldings } from "../src/lease";

/**
 * A `bd` double that records argv and answers `show` from a bead table.
 *
 * Every assertion here is about which `bd` verbs reach the store, because that is the whole
 * behaviour: renewing a lease is a `heartbeat` argv, and refusing to steal live work is the
 * absence of a `reclaim` argv.
 */
function fakeBd(beads: Record<string, unknown>): { argv: string[][]; restore: () => void } {
	const argv: string[][] = [];
	const spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[]) => {
		if (command[0] === "git") {
			const body = command.includes("--git-common-dir") ? "/repo/.git\n" : "/repo\n";
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}
		const rest = command.slice(1);
		if (command[0] === "bd") argv.push(rest);
		let body = "[]";
		if (rest[0] === "--version") body = "bd version 1.3.0";
		if (rest[0] === "show" && rest[1] !== undefined) body = JSON.stringify(beads[rest[1]] ?? {});
		if (rest[0] === "reclaim") body = JSON.stringify([{ id: rest[rest.indexOf("--id") + 1] }]);
		return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
	}) as unknown as typeof Bun.spawn);
	return { argv, restore: () => spawn.mockRestore() };
}

/** A dispatch whose worker is `started` and whose Beads actor is recoverable from a transcript. */
function dispatchStartedWorker(bead: string, sessionId = "0192f0a1-b2c3-7d4e-8f90-123456789abc"): string {
	const dir = mkdtempSync(path.join(tmpdir(), "orc-lease-"));
	const worker = "0192f0a1-b2c3-7d4e-8f90-aaaaaaaaaaaa";
	const file = path.join(dir, `${worker}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
	recordDispatch({ toolCallId: `call-${bead}`, sessionId: "lead", cwd: "/repo", actor: "omp/lead", beadsByIndex: [[bead]], workers: new Map() });
	observeLifecycle({ id: worker, agent: "orc-implementer", status: "started", sessionFile: file, parentToolCallId: `call-${bead}`, index: 0 });
	return `omp/${sessionId}`;
}

describe("lease renewal", () => {
	afterEach(() => {
		clearBdCapabilityCache();
	});

	test("renews the lease of a bead whose worker is still running and whose assignee still matches", async () => {
		const actor = dispatchStartedWorker("T1");
		const fake = fakeBd({ T1: { id: "T1", status: "in_progress", assignee: actor } });
		try {
			const outcomes = await renewStartedHoldings(async () => "/repo");
			expect(outcomes.get("T1")).toBe("renewed");
			expect(fake.argv.some(args => args[0] === "heartbeat" && args[1] === "T1")).toBe(true);
			expect(lostLeases().some(entry => entry.bead === "T1")).toBe(false);
		} finally {
			fake.restore();
		}
	});

	test("never heartbeats a bead the recorded assignee no longer holds, and records the loss", async () => {
		dispatchStartedWorker("T2");
		// `bd heartbeat` refreshes a lease for any actor, so a stale dispatch record would otherwise
		// keep another holder's claim alive. The assignee comparison is the only thing preventing it.
		const fake = fakeBd({ T2: { id: "T2", status: "in_progress", assignee: "omp/someone-else" } });
		try {
			const outcomes = await renewStartedHoldings(async () => "/repo");
			expect(outcomes.get("T2")).toBe("lease-lost");
			expect(fake.argv.some(args => args[0] === "heartbeat")).toBe(false);
			expect(lostLeases().find(entry => entry.bead === "T2")?.reason).toContain("omp/someone-else");
		} finally {
			fake.restore();
		}
	});

	test("a bead reclaimed out of in_progress is lease-lost, so the worker learns to stop", async () => {
		const actor = dispatchStartedWorker("T3");
		const fake = fakeBd({ T3: { id: "T3", status: "open", assignee: undefined } });
		try {
			const outcomes = await renewStartedHoldings(async () => "/repo");
			expect(outcomes.get("T3")).toBe("lease-lost");
			expect(fake.argv.some(args => args[0] === "heartbeat")).toBe(false);
			expect(lostLeases().find(entry => entry.bead === "T3")?.reason).toContain("open");
			expect(actor.startsWith("omp/")).toBe(true);
		} finally {
			fake.restore();
		}
	});

	test("a worker whose Beads actor cannot be recovered is never renewed on a guess", () => {
		recordDispatch({ toolCallId: "call-T4", sessionId: "lead", cwd: "/repo", actor: "omp/lead", beadsByIndex: [["T4"]], workers: new Map() });
		observeLifecycle({ id: "no-transcript", agent: "orc-implementer", status: "started", parentToolCallId: "call-T4", index: 0 });
		expect(startedHoldings().some(holding => holding.bead === "T4")).toBe(false);
	});
});
