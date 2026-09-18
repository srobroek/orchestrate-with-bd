import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { clearLedgerRootCache, registerLedger } from "../src/tools/ledger";

type Bead = { id: string; status: string; assignee?: string; lease_expires_at?: string; issue_type?: string; metadata?: Record<string, unknown> };
type Tool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> };

function setup(version: string, bead: Bead, options: { brandWriteFails?: boolean; alsoReport?: readonly { path: string; branch?: string }[] } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "orc-claim-")));
	mkdirSync(join(root, ".beads"));
	writeFileSync(join(root, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: "server", dolt_database: "test" }));
	// The worktree the agent created for this bead, as `git worktree list --porcelain -z` reports it.
	const worktree = realpathSync(mkdtempSync(join(tmpdir(), "orc-claim-wt-")));
	const state = { ...bead };
	const commands: string[][] = [];
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		// Only `bd` calls are the ledger's own protocol; git answers the worktree questions.
		if (cmd[0] === "git") {
			const argv = cmd.slice(1).join(" ");
			// `git worktree list --porcelain -z`: one record per worktree, each with its own branch,
			// every attribute NUL-terminated and every record closed by an empty one. An entry with
			// no branch is a detached tree, which is how git reports one. Without `-z` git writes
			// lines, and answering NUL anyway would hide a read that dropped the flag.
			const reported = [{ path: root, branch: "main" }, { path: worktree, branch: `omp/agent/${bead.id}` }, ...(options.alsoReport ?? [])];
			const records = reported.map(entry => [`worktree ${entry.path}`, "HEAD abc", entry.branch === undefined ? "detached" : `branch refs/heads/${entry.branch}`]);
			const separated = cmd.includes("-z") ? records.map(attributes => `${attributes.map(attribute => `${attribute}\0`).join("")}\0`).join("") : records.map(attributes => `${attributes.join("\n")}\n`).join("\n");
			const stdout = argv.startsWith("worktree list") ? separated : "";
			// No `rev-parse` answer: the temp root is not a repository, so the ledger falls back to
			// `ctx.cwd`, which is exactly what it does for a checkout git cannot describe.
			return { stdout: new Response(stdout).body, stderr: new Response("").body, exited: Promise.resolve(argv.startsWith("worktree list") ? 0 : 1), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}
		const args = cmd.slice(1).filter(arg => arg !== "--json");
		commands.push(args);
		const [verb] = args;
		let payload: unknown = state;
		let exitCode = 0;
		let stderr = "";
		if (verb === "--version") payload = `bd version ${version}`;
		if (verb === "update") {
			const assigneeGuard = args.indexOf("--if-assignee");
			const statusGuard = args.indexOf("--if-status");
			const brand = args.indexOf("--set-metadata");
			if (brand !== -1 && options.brandWriteFails === true) {
				exitCode = 1;
				stderr = "other bd commands are using this workspace: wait for them to finish and retry";
			} else if (brand !== -1) {
				const [key, ...rest] = (args[brand + 1] ?? "").split("=");
				state.metadata = { ...state.metadata, [key as string]: rest.join("=") };
			} else if ((assigneeGuard !== -1 && (state.assignee ?? "") !== args[assigneeGuard + 1]) || (statusGuard !== -1 && state.status !== args[statusGuard + 1])) {
				exitCode = 13;
				stderr = "guard mismatch";
			} else if (args.includes("--claim")) {
				state.assignee = "omp/claim-test";
				state.status = "in_progress";
			} else {
				state.assignee = args[args.indexOf("--assignee") + 1];
				state.status = args[args.indexOf("--status") + 1];
				state.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
			}
			payload = state;
		}
		if (verb === "unclaim") {
			state.assignee = undefined;
			state.status = "open";
			payload = state;
		}
		if (verb === "heartbeat") {
			state.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
			payload = state;
		}
		if (verb === "show") payload = state;
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); } });
		return { stdout: stream, stderr: new Response(stderr).body, exited: Promise.resolve(exitCode), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
	}) as unknown as typeof Bun.spawn);
	let zod: unknown;
	zod = new Proxy(() => zod, { get: () => zod, apply: () => zod });
	let tool: Tool | undefined;
	const pi = { zod, registerTool: (definition: Tool & { name?: string }) => { if (definition.name === "orc_claim") tool = definition; } } as unknown as ExtensionAPI;
	registerLedger(pi);
	if (!tool) throw new Error("claim tool was not registered");
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "claim-test" } };
	const branch = `omp/agent/${bead.id}`;
	return { tool, ctx, commands, state, spawn, root, worktree, branch, verbs: () => commands.map(command => command[0]) };
}

afterEach(() => {
	// `ledgerRoot` caches per cwd, and every test gets a fresh temp root, but the cache must not
	// outlive a mocked `Bun.spawn` that answered `git rev-parse` for it.
	clearLedgerRootCache();
});

describe("orc_claim native CAS and fallback", () => {
	test("uses both native guards and heartbeats a 1.3 claim", async () => {
		const f = setup("1.3.0", { id: "b-1", status: "open" });
		const result = await f.tool.execute("id", { bead: "b-1", worktree: f.worktree, branch: f.branch }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ claimed: true, bead: { assignee: "omp/claim-test" }, worktree: { path: f.worktree, branch: f.branch } });
		expect(f.commands[2]).toEqual(["update", "b-1", "--assignee", "omp/claim-test", "--status", "in_progress", "--if-assignee", "", "--if-status", "open"]);
		// Read first (the adopt-or-create decision), claim, read back, brand, then heartbeat.
		expect(f.verbs()).toEqual(["--version", "show", "update", "show", "update", "heartbeat"]);
	});

	test("reports a native guard loss without a second write", async () => {
		const f = setup("1.3.0", { id: "b-2", status: "in_progress", assignee: "other" });
		const result = await f.tool.execute("id", { bead: "b-2", worktree: f.worktree, branch: f.branch }, undefined, undefined, f.ctx);
		expect(result.isError).toBeFalsy();
		expect(result.details).toMatchObject({ claimed: false, bead: { assignee: "other" } });
		expect(f.verbs()).toEqual(["--version", "show", "update", "show"]);
	});

	test("keeps the old claim/readback path on a pre-1.3 client", async () => {
		const f = setup("1.2.2", { id: "b-old", status: "open" });
		const result = await f.tool.execute("id", { bead: "b-old", worktree: f.worktree, branch: f.branch }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ claimed: true, bead: { assignee: "omp/claim-test" } });
		expect(f.verbs()).toEqual(["--version", "show", "update", "show", "update"]);
		expect(f.commands[2]).toEqual(["update", "b-old", "--claim"]);
	});
});

describe("orc_claim brands the bead's worktree", () => {
	test("claims first, then asks for the worktree: D10 order, so no branch exists unclaimed", async () => {
		const f = setup("1.3.0", { id: "b-3", status: "open" });
		const result = await f.tool.execute("id", { bead: "b-3" }, undefined, undefined, f.ctx);
		// Not an error: the claim landed, and creating the worktree is the claimant's next step.
		expect(result.isError ?? false).toBe(false);
		expect(result.details).toMatchObject({ claimed: true, needs_worktree: true });
		expect(result.content[0]?.text).toContain("wt switch -y --create --no-cd --base <base-branch> --format json omp/agent/b-3");
		expect(f.state.assignee).toBe("omp/claim-test");
		// Nothing is branded on a bead whose worktree does not exist yet.
		expect(f.commands.some(command => command.includes("--set-metadata"))).toBe(false);
	});

	test("brands on the follow-up call, so claim and worktree are two steps in D10's order", async () => {
		const f = setup("1.3.0", { id: "b-3b", status: "open" });
		await f.tool.execute("id", { bead: "b-3b" }, undefined, undefined, f.ctx);
		const branded = await f.tool.execute("id", { bead: "b-3b", worktree: f.worktree, branch: "omp/agent/b-3b" }, undefined, undefined, f.ctx);
		expect(branded.isError ?? false).toBe(false);
		expect(branded.details).toMatchObject({ claimed: true, worktree: { path: f.worktree, branch: "omp/agent/b-3b" } });
		expect(branded.details).not.toMatchObject({ needs_worktree: true });
	});

	test("refuses a worktree git does not report, a wrong branch, or one inside canonical — the claim stands", async () => {
		const f = setup("1.3.0", { id: "b-4", status: "open" });
		const foreign = await f.tool.execute("id", { bead: "b-4", worktree: "/tmp/not-a-worktree-of-this-repo", branch: f.branch }, undefined, undefined, f.ctx);
		expect(foreign.isError).toBe(true);
		expect(foreign.content[0]?.text).toContain("is not a worktree of this repository");
		const wrongBranch = await f.tool.execute("id", { bead: "b-4", worktree: f.worktree, branch: "feature/x" }, undefined, undefined, f.ctx);
		expect(wrongBranch.isError).toBe(true);
		expect(wrongBranch.content[0]?.text).toContain("branch must be omp/agent/b-4");
		const inCanonical = await f.tool.execute("id", { bead: "b-4", worktree: join(f.root, "src"), branch: f.branch }, undefined, undefined, f.ctx);
		expect(inCanonical.isError).toBe(true);
		expect(inCanonical.content[0]?.text).toContain("inside the canonical checkout");
		const relative = await f.tool.execute("id", { bead: "b-4", worktree: "some/relative/path", branch: f.branch }, undefined, undefined, f.ctx);
		expect(relative.isError).toBe(true);
		expect(relative.content[0]?.text).toContain("must be an absolute path");
		// The bead stays claimed by this actor and unbranded: a rejected path is not a lost claim.
		expect(f.state.assignee).toBe("omp/claim-test");
		expect(f.state.metadata?.worktree).toBeUndefined();
	});

	test("refuses a path git reports on another bead's branch: both halves must be one record", async () => {
		// A sibling worker's real worktree on its real `omp/agent/` branch. Accepting this pair
		// would put this worker in that tree while every later cleanup addressed the branch this
		// bead recorded, so the pair — not each half — is what is checked.
		const sibling = realpathSync(mkdtempSync(join(tmpdir(), "orc-claim-sibling-")));
		const f = setup("1.3.0", { id: "b-4b", status: "open" }, { alsoReport: [{ path: sibling, branch: "omp/agent/b-9" }] });
		const transposed = await f.tool.execute("id", { bead: "b-4b", worktree: sibling, branch: "omp/agent/b-4b" }, undefined, undefined, f.ctx);
		expect(transposed.isError).toBe(true);
		expect(transposed.content[0]?.text).toContain("checked out on omp/agent/b-9");
		expect(transposed.details).toMatchObject({ claimed: true, needs_worktree: true });
		// The claim stands and nothing is branded: a rejected pair is not a lost claim.
		expect(f.state.assignee).toBe("omp/claim-test");
		expect(f.state.metadata?.worktree).toBeUndefined();
		f.spawn.mockRestore();
	});

	test("keeps the claim when the brand cannot be written, and repeats bd's own words", async () => {
		const f = setup("1.3.0", { id: "b-5", status: "open" }, { brandWriteFails: true });
		const result = await f.tool.execute("id", { bead: "b-5", worktree: f.worktree, branch: f.branch }, undefined, undefined, f.ctx);
		expect(result.isError).toBe(true);
		// bd's own words reach the agent, so the contention retry rule can match them.
		expect(result.content[0]?.text).toContain("other bd commands are using this workspace: wait for them to finish and retry");
		// The claim is never given back: the worktree exists, and an unclaimed bead beside a real
		// tree is exactly what D10's order exists to prevent.
		expect(f.verbs()).not.toContain("unclaim");
		expect(f.state.assignee).toBe("omp/claim-test");
		expect(f.state.status).toBe("in_progress");
	});

	test("adopts the worktree a prior attempt left, without being given one", async () => {
		// The prior attempt's tree still exists and git still reports it, which is the case a tier
		// escalation lands in: a different agent, from a different pool, on the same bead.
		const prior = realpathSync(mkdtempSync(join(tmpdir(), "orc-claim-prior-")));
		const brand = JSON.stringify({ path: prior, branch: "omp/agent/b-6", run: "R", claimed_at: "2026-01-01T00:00:00Z" });
		const f = setup("1.3.0", { id: "b-6", status: "open", metadata: { worktree: brand } }, { alsoReport: [{ path: prior, branch: "omp/agent/b-6" }] });
		const result = await f.tool.execute("id", { bead: "b-6" }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ claimed: true, adopted: true, worktree: { path: prior, branch: "omp/agent/b-6", run: "R" } });
		expect(result.details).not.toMatchObject({ worktree_missing: true });
		expect(result.content[0]?.text).toContain("it holds the prior attempt");
		// Nothing is rewritten: the brand the bead already carries is the one that stands.
		expect(f.commands.some(command => command.includes("--set-metadata"))).toBe(false);
	});

	test("tells an adopting claimant when the recorded worktree is gone", async () => {
		const f = setup("1.3.0", { id: "b-7", status: "open", metadata: { worktree: JSON.stringify({ path: "/tmp/pruned-away", branch: "omp/agent/b-7" }) } });
		const result = await f.tool.execute("id", { bead: "b-7" }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ claimed: true, adopted: true, worktree_missing: true });
		expect(result.content[0]?.text).toContain("recreate it at the same branch");
	});

	test("an epic needs no worktree", async () => {
		const f = setup("1.3.0", { id: "E", status: "open", issue_type: "epic" });
		const result = await f.tool.execute("id", { bead: "E" }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ claimed: true });
		expect(f.commands.some(command => command.includes("--set-metadata"))).toBe(false);
	});

	test("every role that creates a worktree is branded, and only a planner and a DAG review are not", async () => {
		// The reviewer, researcher, and shepherd prompts all create an `omp/agent/<bead>` worktree
		// and pass it back, and the brand is what `orc_finish` reclaims and the next round adopts.
		for (const role of ["reviewer", "researcher", "shepherd"]) {
			const f = setup("1.3.0", { id: `r-${role}`, status: "open", metadata: { role } });
			const first = await f.tool.execute("id", { bead: `r-${role}` }, undefined, undefined, f.ctx);
			expect(first.details).toMatchObject({ claimed: true, needs_worktree: true });
			expect(first.content[0]?.text).toContain(`wt switch -y --create --no-cd --base <base-branch> --format json omp/agent/r-${role}`);
			const branded = await f.tool.execute("id", { bead: `r-${role}`, worktree: f.worktree, branch: `omp/agent/r-${role}` }, undefined, undefined, f.ctx);
			expect(branded.details).toMatchObject({ claimed: true, worktree: { path: f.worktree, branch: `omp/agent/r-${role}` } });
			expect(branded.details).not.toMatchObject({ needs_worktree: true });
			f.spawn.mockRestore();
		}
		// A planner writes beads and a DAG review reads the ledger: neither has a checkout at all.
		for (const role of ["planner", "dag-reviewer"]) {
			const f = setup("1.3.0", { id: `r-${role}`, status: "open", metadata: { role } });
			const result = await f.tool.execute("id", { bead: `r-${role}` }, undefined, undefined, f.ctx);
			expect(result.details).toMatchObject({ claimed: true });
			expect(result.details).not.toMatchObject({ needs_worktree: true });
			expect(f.commands.some(command => command.includes("--set-metadata"))).toBe(false);
			f.spawn.mockRestore();
		}
	});
});
