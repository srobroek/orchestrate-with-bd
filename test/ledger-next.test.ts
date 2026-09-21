import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "./scratch";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { clearLedgerRootCache, registerLedger } from "../src/tools/ledger";
import { clearBdCapabilityCache } from "../src/bd";

type Bead = Record<string, unknown> & { id: string; status: string; assignee?: string };
type Result = { content: { text: string }[]; isError?: boolean; details?: unknown };
type Tool = { execute: (...args: unknown[]) => Promise<Result> };

const runMeta = { run: { owner: "omp/worker", root: "R", bound_at: "2026-01-01T00:00:00Z" } };
const edge = (id: string, type = "parent-child") => ({ id, dependency_type: type });

function setup(input: Bead[], options: { mismatch?: string; unreadable?: string; version?: string } = {}) {
	const root = realpathSync(scratchDir("orc-next-"));
	mkdirSync(join(root, ".beads"));
	// The mocked `--git-common-dir` answer below points here, and the hardened resolver
	// now verifies that the directory exists rather than trusting the string.
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: "embedded", dolt_database: "next" }));
	const beads = new Map(input.map(bead => [bead.id, structuredClone(bead)]));
	const commands: string[][] = [];
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
    const args = cmd.slice(1).filter(arg => arg !== "--json" && arg !== "--brief" && arg !== "--brief-deps");
    if (cmd[0] === "bd") commands.push(args);
		let body: unknown = null;
		let code = 0;
		let stderr = "";
		if (cmd[0] === "git") {
			body = cmd.includes("--git-common-dir") ? `${root}/.git\n` : `${opts?.cwd ?? root}\n`;
		} else {
			const [verb, id] = args;
			if (verb === "--version") body = `bd version ${options.version ?? "1.3.0"}`;
			else if (verb === "show") {
				if (id === options.unreadable) { code = 1; stderr = "cannot read run"; }
				else body = beads.get(id as string) ?? null;
			} else if (verb === "list") {
				const parent = args[args.indexOf("--parent") + 1];
				body = [...beads.values()].filter(bead => Array.isArray(bead.dependencies) && (bead.dependencies as Record<string, string>[]).some(dep => dep.id === parent && dep.dependency_type === "parent-child"));
			} else if (verb === "ready") {
				const parent = args[args.indexOf("--parent") + 1];
				// A queued bead is assigned to its `pool:<agent>` alias and is still ready; only a
				// bead held by a real actor is not.
				body = [...beads.values()].filter(bead => bead.status === "open" && (bead.assignee === undefined || String(bead.assignee).startsWith("pool:")) && Array.isArray(bead.dependencies) && (bead.dependencies as Record<string, string>[]).some(dep => dep.id === parent && dep.dependency_type === "parent-child") && (bead.dependencies as Record<string, string>[]).every(dep => dep.dependency_type === "parent-child" || beads.get(dep.id)?.status === "closed"));
            } else if (verb === "update") {
              const bead = beads.get(id as string);
              if (bead === undefined) { code = 1; stderr = "missing bead"; }
              else if (args.includes("--claim")) {
                const expiry = typeof bead.lease_expires_at === "string" ? Date.parse(bead.lease_expires_at) : Number.NaN;
                const held = typeof bead.assignee === "string" && bead.assignee !== "omp/worker" && (Number.isNaN(expiry) || expiry > Date.now());
                if (options.mismatch === id || held) {
                  code = 1;
                  stderr = `issue already claimed by ${bead.assignee ?? "(unassigned)"}`;
                } else {
                  bead.assignee = "omp/worker";
                  bead.status = "in_progress";
                  bead.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
                }
              } else {
                const assigneeGuard = args.indexOf("--if-assignee");
                const statusGuard = args.indexOf("--if-status");
                if ((options.mismatch === id) || (assigneeGuard >= 0 && (bead.assignee ?? "") !== args[assigneeGuard + 1]) || (statusGuard >= 0 && bead.status !== args[statusGuard + 1])) { code = 13; stderr = "guard mismatch"; }
                else {
                  const a = args.indexOf("--assignee");
                  if (a >= 0) bead.assignee = args[a + 1] || undefined;
                  const s = args.indexOf("--status");
                  if (s >= 0) bead.status = args[s + 1] as string;
                }
              }
              body = bead;
            }
		}
		// git speaks plain text. JSON-encoding its answer wraps the path in quotes, and the
		// resolver then rightly refuses a common directory that is not absolute.
		const payload = cmd[0] === "git" ? String(body) : JSON.stringify(body);
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } });
		return { stdout: stream, stderr: new Response(stderr).body, exited: Promise.resolve(code), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
	}) as unknown as typeof Bun.spawn);
	let zod: unknown; zod = new Proxy(() => zod, { get: () => zod, apply: () => zod });
	let tool: Tool | undefined;
	const pi = { zod, registerTool: (definition: Tool & { name?: string }) => { if (definition.name === "orc_next") tool = definition; } } as unknown as ExtensionAPI;
	registerLedger(pi);
	if (!tool) throw new Error("orc_next was not registered");
	return { root, tool, ctx: { cwd: root, sessionManager: { getSessionId: () => "worker" } }, beads, commands, spawn };
}

function run(children: Bead[] = [], extra: Bead = { id: "R", issue_type: "epic", status: "in_progress", assignee: "omp/worker", lease_expires_at: "2999-01-01T00:00:00Z", metadata: runMeta }) {
 // `readyWave` keeps only tasks in a two-tier wave, so a child with no `issue_type` is filtered
 // out and every fixture would look like an empty run.
 return [extra, { id: "R.0", issue_type: "task", status: "closed", metadata: { role: "dag-reviewer" }, dependencies: [edge("R")] }, ...children.map(bead => ({ issue_type: "task", ...bead, dependencies: bead.dependencies ?? [edge("R")] }))];
}

afterEach(() => { clearLedgerRootCache(); clearBdCapabilityCache(); });
describe("orc_next", () => {
  test("claims a ready bead with native --claim and lease", async () => {
    const f = setup(run([{ id: "R.1", status: "in_progress", assignee: "dead", lease_expires_at: "2020-01-01T00:00:00Z", title: "work" }]));
    const result = await f.tool.execute("x", { run: "R" }, undefined, undefined, f.ctx);
    expect(result.details).toMatchObject({ claimed: true, bead: { id: "R.1", assignee: "omp/worker", lease_expires_at: expect.any(String) } });
    expect(f.spawn.mock.calls.some(([cmd]) => Array.isArray(cmd) && cmd[0] === "git" && cmd.includes("--git-common-dir"))).toBe(true);
    const claim = f.commands.find(command => command[0] === "update" && command[1] === "R.1");
    expect(claim).toEqual(expect.arrayContaining(["--claim"]));
    expect(claim).not.toEqual(expect.arrayContaining(["--if-assignee", "--if-status"]));
  });

  test("skips an existing-holder refusal and claims the next candidate", async () => {
    const expired = { status: "in_progress", assignee: "dead", lease_expires_at: "2020-01-01T00:00:00Z" };
    const f = setup(run([{ id: "R.1", ...expired }, { id: "R.2", ...expired }]), { mismatch: "R.1" });
    const result = await f.tool.execute("x", { run: "R" }, undefined, undefined, f.ctx);
    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ claimed: true, bead: { id: "R.2" } });
  });

  test("skips an existing-holder refusal for an open candidate", async () => {
    const f = setup(run([{ id: "R.1", status: "open" }, { id: "R.2", status: "open" }]), { mismatch: "R.1" });
    const result = await f.tool.execute("x", { run: "R" }, undefined, undefined, f.ctx);
    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ claimed: true, bead: { id: "R.2" } });
  });

  test("filters queued candidates by agent while unqueued work remains eligible", async () => {
    const f = setup(run([{ id: "R.1", status: "open", assignee: "pool:orc-implementer" }, { id: "R.2", status: "open" }]));
    const result = await f.tool.execute("x", { run: "R", agent: "orc-reviewer" }, undefined, undefined, f.ctx);
    expect(result.details).toMatchObject({ claimed: true, bead: { id: "R.2" } });
  });

  test("reports ready zero but inflight siblings and poll-again reason", async () => {
    const f = setup(run([{ id: "R.1", status: "in_progress", assignee: "other" }]));
    const result = await f.tool.execute("x", { run: "R" }, undefined, undefined, f.ctx);
    expect(result.details).toMatchObject({ claimed: false, ready: 0, inflight: 1, reason: expect.stringContaining("poll again") });
  });

  test("reports exit when nothing is ready or running", async () => {
    const f = setup(run([{ id: "R.1", status: "closed" }]));
    const result = await f.tool.execute("x", { run: "R" }, undefined, undefined, f.ctx);
    expect(result.details).toMatchObject({ claimed: false, inflight: 0, reason: expect.stringContaining("exit") });
  });

  test("claims an expired native lease with --claim", async () => {
    const f = setup(run([{ id: "R.1", status: "in_progress", assignee: "dead", lease_expires_at: "2020-01-01T00:00:00Z" }]));
    const result = await f.tool.execute("x", { run: "R" }, undefined, undefined, f.ctx);
    expect(result.details).toMatchObject({ claimed: true, bead: { id: "R.1" } });
    const update = f.commands.find(command => command[0] === "update" && command[1] === "R.1");
    expect(update).toEqual(expect.arrayContaining(["--claim"]));
    expect(update).not.toEqual(expect.arrayContaining(["--if-assignee", "--if-status"]));
  });

  test("does not reclaim a live lease", async () => {
    const f = setup(run([{ id: "R.1", status: "in_progress", assignee: "live", lease_expires_at: "2999-01-01T00:00:00Z" }]));
    const result = await f.tool.execute("x", { run: "R" }, undefined, undefined, f.ctx);
    expect(result.details).toMatchObject({ claimed: false, inflight: 1 });
    expect(f.commands.some(command => command[0] === "update" && command[1] === "R.1")).toBe(false);
  });

  test("refuses unreadable, non-epic, unowned, dead, and truncated runs", async () => {
    const cases: Array<[string, Bead[], string, { unreadable?: string }?]> = [
      ["unreadable", run(), "run unreadable", { unreadable: "R" }],
      ["non-epic", [{ id: "R", issue_type: "task", status: "in_progress", assignee: "omp/worker" }], "not an epic"],
      ["without metadata.run", [{ id: "R", issue_type: "epic", status: "in_progress", assignee: "omp/worker" }], "metadata.run"],
      ["dead lease", run([], { id: "R", issue_type: "epic", status: "in_progress", assignee: "omp/worker", lease_expires_at: "2020-01-01T00:00:00Z", metadata: runMeta }), "lease is not live"],
    ];
    for (const [, beads, phrase, options] of cases) {
      const f = setup(beads, options);
      const result = await f.tool.execute("x", { run: "R" }, undefined, undefined, f.ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(phrase);
    }
    const many = run(Array.from({ length: 1001 }, (_, i) => ({ id: `R.${i}`, status: "closed" })));
    const truncated = setup(many);
    const result = await truncated.tool.execute("x", { run: "R" }, undefined, undefined, truncated.ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("subtree exceeds");
  });

  test("shares readyWave DAG-review gating with orc_status", async () => {
    const epic = { id: "R", issue_type: "epic", status: "in_progress", assignee: "omp/worker", lease_expires_at: "2999-01-01T00:00:00Z", metadata: runMeta };
    const review = { id: "R.0", issue_type: "task", status: "open", metadata: { role: "dag-reviewer" }, dependencies: [edge("R")] };
    const f = setup([epic, review, { id: "R.1", issue_type: "task", status: "open", dependencies: [edge("R")] }]);
    const result = await f.tool.execute("x", { run: "R" }, undefined, undefined, f.ctx);
    expect(result.details).toMatchObject({ claimed: true, bead: { id: "R.0" } });
    expect(f.commands.some(command => command[0] === "update" && command[1] === "R.1")).toBe(false);
  });
});
