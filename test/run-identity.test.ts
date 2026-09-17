import { describe, expect, spyOn, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { OMP_EXCLUSION, scopeCi, scopeWorkflowText } from "../src/ci-scope";
import { readRunOwnership, readWorktreeBrand, setMetadata } from "../src/types";
import { canonicalRoot, checkWorktree, isInside, parseWorktreeList } from "../src/worktree";
import { clearLedgerRootCache, registerLedger } from "../src/tools/ledger";

afterEach(() => {
	clearLedgerRootCache();
});

describe("worktree membership", () => {
	test("parses every worktree path and ignores the rest of the porcelain record", () => {
		const porcelain = "worktree /a/canonical\nHEAD abc\nbranch refs/heads/main\n\nworktree /b/linked\nHEAD def\ndetached\n\nworktree /c/bare\nbare\n";
		expect(parseWorktreeList(porcelain)).toEqual(["/a/canonical", "/b/linked", "/c/bare"]);
		expect(parseWorktreeList("")).toEqual([]);
	});

	test("containment follows symlinks, so a link inside a worktree cannot smuggle a canonical path", () => {
		const canonical = realpathSync(mkdtempSync(join(tmpdir(), "wt-canonical-")));
		const worktree = realpathSync(mkdtempSync(join(tmpdir(), "wt-linked-")));
		mkdirSync(join(canonical, "src"));
		symlinkSync(join(canonical, "src"), join(worktree, "link"));
		expect(isInside(join(worktree, "file.ts"), worktree)).toBe(true);
		expect(isInside(join(canonical, "src", "file.ts"), canonical)).toBe(true);
		// Lexically `<worktree>/link/probe.ts` is inside the worktree; physically it is canonical.
		expect(isInside(join(worktree, "link", "probe.ts"), canonical)).toBe(true);
		expect(isInside(join(worktree, "link", "probe.ts"), worktree)).toBe(false);
		// A sibling whose name merely starts with the root's name is not inside it.
		expect(isInside(`${worktree}-other/file.ts`, worktree)).toBe(false);
	});

	test("a worktree is accepted only when git reports it for this repository", () => {
		const canonical = "/repo";
		const worktrees = ["/repo", "/wt/omp-agent-b-1"];
		expect(checkWorktree({ bead: "b-1", worktree: "/wt/omp-agent-b-1", branch: "omp/agent/b-1", canonical, worktrees })).toEqual({ ok: true, path: "/wt/omp-agent-b-1" });
		// A worktree of a different repository: absolute, outside canonical, and still refused.
		const foreign = checkWorktree({ bead: "b-1", worktree: "/elsewhere/other-repo-wt", branch: "omp/agent/b-1", canonical, worktrees });
		expect(foreign.ok).toBe(false);
		expect(canonical).not.toBe("/elsewhere/other-repo-wt");
		const inCanonical = checkWorktree({ bead: "b-1", worktree: "/repo/sub", branch: "omp/agent/b-1", canonical, worktrees });
		expect(inCanonical).toMatchObject({ ok: false });
		if (!inCanonical.ok) expect(inCanonical.reason).toContain("canonical checkout");
	});

	test("a non-absolute answer from git is no root at all", async () => {
		// `--path-format=absolute` promises absolute; a mock or a shim printing anything else must
		// not be turned into a root, or every `bd` call would resolve against a fabricated path.
		const zero = async () => ({ code: 0, stdout: '{"id":"b-1"}\n', stderr: "" });
		expect(await canonicalRoot("/anywhere", zero)).toBeNull();
		const failed = async () => ({ code: 128, stdout: "", stderr: "not a git repository" });
		expect(await canonicalRoot("/anywhere", failed)).toBeNull();
		const good = async () => ({ code: 0, stdout: "/repo/.git\n", stderr: "" });
		expect(await canonicalRoot("/repo/wt", good)).toBe("/repo");
	});
});

describe("metadata records", () => {
	test("a run record needs an owner, and reads back from the JSON string bd stores", () => {
		const value = JSON.stringify({ owner: "omp/a", bound_at: "2026-01-01T00:00:00Z", root: "R", ci_scoped: true });
		expect(readRunOwnership({ id: "R", metadata: { run: value } })).toEqual({ owner: "omp/a", bound_at: "2026-01-01T00:00:00Z", root: "R", ci_scoped: true });
		// A real object reads identically, so a value written with `--metadata` is not a new shape.
		expect(readRunOwnership({ id: "R", metadata: { run: { owner: "omp/a", root: "R", ci_scoped: false, bound_at: "" } } })).toMatchObject({ owner: "omp/a", ci_scoped: false });
		expect(readRunOwnership({ id: "R", metadata: {} })).toBeNull();
		// Present but ownerless is not ownership: nobody holds it, so a bind may take it.
		expect(readRunOwnership({ id: "R", metadata: { run: JSON.stringify({ root: "R" }) } })).toBeNull();
		expect(readRunOwnership({ id: "R", metadata: { run: "{not json" } })).toBeNull();
		// A missing `root` falls back to the epic itself, never to undefined.
		expect(readRunOwnership({ id: "R", metadata: { run: JSON.stringify({ owner: "omp/a" }) } })).toMatchObject({ root: "R" });
	});

	test("a half-written worktree brand is no brand, so a successor is never sent to an empty branch", () => {
		expect(readWorktreeBrand({ id: "b", metadata: { worktree: JSON.stringify({ path: "/wt/b", branch: "omp/agent/b" }) } })).toEqual({ path: "/wt/b", branch: "omp/agent/b" });
		expect(readWorktreeBrand({ id: "b", metadata: { worktree: JSON.stringify({ path: "/wt/b" }) } })).toBeNull();
		expect(readWorktreeBrand({ id: "b", metadata: { worktree: JSON.stringify({ branch: "omp/agent/b" }) } })).toBeNull();
		expect(readWorktreeBrand({ id: "b", metadata: {} })).toBeNull();
		expect(readWorktreeBrand({ id: "b", metadata: { worktree: JSON.stringify({ path: "/wt/b", branch: "omp/agent/b", orphaned: true, removal_error: "dirty" }) } })).toMatchObject({ orphaned: true, removal_error: "dirty" });
	});

	test("a set-metadata argument carries JSON, because bd stores the value verbatim", () => {
		expect(setMetadata("run", { owner: "omp/a" })).toBe('run={"owner":"omp/a"}');
	});
});

describe("CI scoping", () => {
	test("extends a plain and a wrapped pull-request condition, and is idempotent", () => {
		const source = ["jobs:", "  gate:", "    steps:", "      - name: expensive", "        if: github.event_name == 'pull_request'", "      - name: wrapped", "        if: ${{ github.event_name == 'pull_request' && matrix.os == 'linux' }}", ""].join("\n");
		const first = scopeWorkflowText(source);
		expect(first.changed).toEqual([5, 7]);
		expect(first.text).toContain(`if: github.event_name == 'pull_request' && ${OMP_EXCLUSION}`);
		expect(first.text).toContain(`if: \${{ github.event_name == 'pull_request' && matrix.os == 'linux' && ${OMP_EXCLUSION} }}`);
		// Second pass: every condition already excludes omp/**, so nothing is rewritten.
		const second = scopeWorkflowText(first.text);
		expect(second.changed).toEqual([]);
		expect(second.already).toEqual([5, 7]);
		expect(second.text).toBe(first.text);
	});

	test("leaves conditions that are not pull-request-only alone", () => {
		const source = ["    steps:", "      - if: github.event_name != 'pull_request'", "      - if: github.event_name == 'push'", "      - if: always()", ""].join("\n");
		const result = scopeWorkflowText(source);
		expect(result.changed).toEqual([]);
		expect(result.unhandled).toEqual([]);
		expect(result.text).toBe(source);
	});

	test("refuses to rewrite a shape it cannot rewrite unambiguously, and reports it", () => {
		const folded = ["    steps:", "      - if: >-", "          github.event_name == 'pull_request'", ""].join("\n");
		const foldedResult = scopeWorkflowText(folded);
		expect(foldedResult.changed).toEqual([]);
		expect(foldedResult.unhandled).toEqual([{ line: 2, why: "folded or block scalar condition" }]);
		expect(foldedResult.text).toBe(folded);
		// A trailing comment: appending after it would land inside the comment.
		const commented = ["    steps:", "      - if: github.event_name == 'pull_request' # only on PRs", ""].join("\n");
		const commentedResult = scopeWorkflowText(commented);
		expect(commentedResult.changed).toEqual([]);
		expect(commentedResult.unhandled[0]).toMatchObject({ line: 2, why: "trailing comment after the condition" });
		// Literal text around an expression span: there is no single expression to extend.
		const mixed = ["    steps:", "      - if: prefix ${{ github.event_name == 'pull_request' }} suffix", ""].join("\n");
		const mixedResult = scopeWorkflowText(mixed);
		expect(mixedResult.changed).toEqual([]);
		expect(mixedResult.unhandled[0]).toMatchObject({ line: 2 });
	});

	test("scopeCi rewrites the repository's workflows in place and reports what it could not do", () => {
		const root = mkdtempSync(join(tmpdir(), "ci-scope-"));
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		writeFileSync(join(root, ".github", "workflows", "ci.yml"), "jobs:\n  a:\n    steps:\n      - if: github.event_name == 'pull_request'\n");
		writeFileSync(join(root, ".github", "workflows", "folded.yaml"), "jobs:\n  b:\n    steps:\n      - if: |\n          github.event_name == 'pull_request'\n");
		writeFileSync(join(root, ".github", "workflows", "notes.md"), "not a workflow\n");
		const report = scopeCi(root);
		expect(report.changed).toEqual([join(".github", "workflows", "ci.yml")]);
		expect(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")).toContain(OMP_EXCLUSION);
		// A shape it will not touch keeps `scoped` false: the lead is told, not lied to.
		expect(report.unhandled).toHaveLength(1);
		expect(report.unhandled[0]).toContain("folded.yaml");
		expect(report.scoped).toBe(false);
		// A second pass changes nothing, and the untouched file is still untouched.
		const again = scopeCi(root);
		expect(again.changed).toEqual([]);
		expect(again.already).toEqual([join(".github", "workflows", "ci.yml") + ":4"]);
	});

	test("a repository with no workflows is scoped by having nothing to scope", () => {
		const report = scopeCi(mkdtempSync(join(tmpdir(), "ci-none-")));
		expect(report).toMatchObject({ scoped: true, changed: [], unhandled: [] });
	});
});

/** A tool harness over a tiny stateful bd store, one `wt` answer, and no git repository. */
function ledger(beads: Record<string, Record<string, unknown>>, options: { wtExit?: number; wtStderr?: string } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "orc-run-")));
	mkdirSync(join(root, ".beads"));
	writeFileSync(join(root, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: "embedded", dolt_database: "fx" }));
	const argv: string[][] = [];
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		argv.push(cmd);
		if (cmd[0] === "git") return { stdout: new Response("").body, stderr: new Response("").body, exited: Promise.resolve(1), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		if (cmd[0] === "wt") {
			return { stdout: new Response("").body, stderr: new Response(options.wtStderr ?? "").body, exited: Promise.resolve(options.wtExit ?? 0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}
		const args = cmd.slice(1).filter(arg => arg !== "--json");
		const [verb, id] = args;
		let body: unknown = null;
		if (verb === "--version") body = "bd version 1.3.0";
		else if (verb === "show") body = beads[id as string];
		else if (verb === "list" && args.includes("--has-metadata-key")) {
			const key = args[args.indexOf("--has-metadata-key") + 1];
			const type = args.includes("-t") ? args[args.indexOf("-t") + 1] : undefined;
			body = Object.values(beads).filter(bead => {
				const metadata = bead.metadata;
				const has = metadata !== null && typeof metadata === "object" && key !== undefined && key in metadata;
				return has && (type === undefined || bead.issue_type === type);
			});
		} else if (verb === "list") {
			const parent = args[args.indexOf("--parent") + 1];
			body = Object.values(beads).filter(bead => edges(bead).some(edge => edge.type === "parent-child" && edge.id === parent));
		} else if (verb === "ready") {
			const parent = args[args.indexOf("--parent") + 1];
			body = Object.values(beads).filter(bead => bead.status === "open" && !bead.assignee && edges(bead).some(edge => edge.type === "parent-child" && edge.id === parent) && edges(bead).every(edge => edge.type === "parent-child" || beads[edge.id]?.status === "closed"));
		} else if (verb === "close") {
			const bead = beads[id as string];
			if (bead !== undefined) bead.status = "closed";
			body = bead;
		} else if (verb === "update") {
			const bead = beads[id as string];
			if (bead !== undefined) {
				for (let i = 2; i < args.length; i++) {
					if (args[i] === "--status") bead.status = args[++i];
					else if (args[i] === "--set-metadata") {
						const [key, ...rest] = (args[++i] ?? "").split("=");
						bead.metadata = { ...(bead.metadata as Record<string, unknown>), [key as string]: rest.join("=") };
					}
				}
			}
			body = bead;
		} else if (verb === "comment") body = null;
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); } });
		return { stdout: stream, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
	}) as unknown as typeof Bun.spawn);
	let zod: unknown;
	zod = new Proxy(() => zod, { get: () => zod, apply: () => zod });
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> }>();
	const pi = { zod, registerTool: (definition: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details?: unknown }> }) => tools.set(definition.name, definition) } as unknown as ExtensionAPI;
	registerLedger(pi);
	return { tools, root, argv, spawn, ctx: (session: string) => ({ cwd: root, sessionManager: { getSessionId: () => session } }) };
}

function edges(bead: Record<string, unknown>): { id: string; type: string }[] {
	const deps = Array.isArray(bead.dependencies) ? bead.dependencies : [];
	const out: { id: string; type: string }[] = [];
	for (const dep of deps) {
		if (dep === null || typeof dep !== "object") continue;
		const id = "id" in dep ? dep.id : undefined;
		const type = "dependency_type" in dep ? dep.dependency_type : undefined;
		if (typeof id === "string" && typeof type === "string") out.push({ id, type });
	}
	return out;
}

/** A run epic already bound to `omp/lead`, plus the closed DAG review that ungates waves. */
function boundRun(): Record<string, Record<string, unknown>> {
	return {
		E: { id: "E", issue_type: "epic", status: "in_progress", assignee: "omp/lead", metadata: { run: JSON.stringify({ owner: "omp/lead", bound_at: "2026-01-01T00:00:00Z", root: "E", ci_scoped: true }) }, dependencies: [] },
		"E.0": { id: "E.0", issue_type: "task", title: "Review the DAG", status: "closed", metadata: { role: "dag-reviewer" }, dependencies: [{ id: "E", dependency_type: "parent-child" }] },
	};
}

describe("orc_status newly_ready", () => {
	test("reports what became ready since this session's last call, and not again", async () => {
		const beads = boundRun();
		beads.A = { id: "A", issue_type: "task", title: "A", status: "open", dependencies: [{ id: "E", dependency_type: "parent-child" }] };
		beads.B = { id: "B", issue_type: "task", title: "B", status: "open", dependencies: [{ id: "E", dependency_type: "parent-child" }] };
		// C is unblocked only by A, which is the whole point: it must not wait for B.
		beads.C = { id: "C", issue_type: "task", title: "C", status: "open", dependencies: [{ id: "E", dependency_type: "parent-child" }, { id: "A", dependency_type: "blocks" }] };
		const f = ledger(beads);
		const status = async (session: string) => (await f.tools.get("orc_status")?.execute("x", {}, undefined, undefined, f.ctx(session)))?.details as { ready: string[]; newly_ready: string[] };
		try {
			const first = await status("lead");
			expect(first.ready).toEqual(["A A", "B B"]);
			expect(first.newly_ready).toEqual(["A A", "B B"]);
			// Nothing changed: the same wave is not newly ready a second time.
			expect((await status("lead")).newly_ready).toEqual([]);
			// A finishes while B is still running. C is dispatchable now, and it is the only new one.
			beads.A!.status = "closed";
			const afterA = await status("lead");
			expect(afterA.ready).toEqual(["B B", "C C"]);
			expect(afterA.newly_ready).toEqual(["C C"]);
			expect((await status("lead")).newly_ready).toEqual([]);
			// A session that does not own the run gets no status at all, so no baseline of its own
			// can be consumed: run ownership and the newly-ready baseline are both per-session.
			const foreign = await f.tools.get("orc_status")?.execute("x", {}, undefined, undefined, f.ctx("other-lead"));
			expect(foreign?.isError).toBe(true);
			expect(foreign?.content[0]?.text).toContain("no run bound");
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a bead that leaves the wave and returns is newly ready again", async () => {
		const beads = boundRun();
		beads.A = { id: "A", issue_type: "task", title: "A", status: "open", dependencies: [{ id: "E", dependency_type: "parent-child" }] };
		const f = ledger(beads);
		const status = async () => (await f.tools.get("orc_status")?.execute("x", {}, undefined, undefined, f.ctx("lead")))?.details as { newly_ready: string[] };
		try {
			expect((await status()).newly_ready).toEqual(["A A"]);
			// Dispatched: claimed beads drop out of `bd ready`.
			beads.A!.assignee = "omp/worker";
			expect((await status()).newly_ready).toEqual([]);
			// A fix round reopens and unassigns it, so it is a new arrival in the wave.
			beads.A!.assignee = undefined;
			expect((await status()).newly_ready).toEqual(["A A"]);
		} finally {
			f.spawn.mockRestore();
		}
	});
});

describe("orc_finish reclaims the bead's worktree", () => {
	const branded = (extra: Record<string, unknown> = {}) => ({
		id: "T",
		issue_type: "task",
		status: "in_progress",
		assignee: "omp/worker",
		metadata: { worktree: JSON.stringify({ path: "/wt/omp-agent-T", branch: "omp/agent/T", run: "E", ...extra }) },
		dependencies: [{ id: "E", dependency_type: "parent-child" }],
	});

	test("a clean close removes the worktree, and never passes --force or --force-delete", async () => {
		const beads = { ...boundRun(), T: branded() };
		const f = ledger(beads);
		try {
			const done = await f.tools.get("orc_finish")?.execute("x", { bead: "T", state: "done", reason: "criteria met" }, undefined, undefined, f.ctx("worker"));
			expect(done?.isError ?? false).toBe(false);
			expect(done?.details).toMatchObject({ state: "done", worktree: { path: "/wt/omp-agent-T", branch: "omp/agent/T", removed: true } });
			const wt = f.argv.find(cmd => cmd[0] === "wt");
			expect(wt).toEqual(["wt", "-C", f.root, "remove", "-y", "--foreground", "omp/agent/T"]);
			expect(wt).not.toContain("-f");
			expect(wt).not.toContain("--force");
			expect(wt).not.toContain("-D");
			expect(wt).not.toContain("--force-delete");
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a refused removal marks the bead orphaned with wt's own words and still reports the close", async () => {
		const beads = { ...boundRun(), T: branded() };
		const f = ledger(beads, { wtExit: 1, wtStderr: "worktree has uncommitted changes; use --force to remove it anyway\n" });
		try {
			const done = await f.tools.get("orc_finish")?.execute("x", { bead: "T", state: "done", reason: "criteria met" }, undefined, undefined, f.ctx("worker"));
			// The close landed; the worktree is the lead's problem, not a failed tool call.
			expect(done?.isError ?? false).toBe(false);
			expect(beads.T.status).toBe("closed");
			expect(done?.details).toMatchObject({ worktree: { removed: false, error: "worktree has uncommitted changes; use --force to remove it anyway" } });
			expect(done?.content[0]?.text).toContain("marked orphaned");
			expect(readWorktreeBrand({ id: "T", metadata: beads.T.metadata })).toMatchObject({ orphaned: true, removal_error: "worktree has uncommitted changes; use --force to remove it anyway" });
			// A second attempt is not made, and it is never retried with a destructive flag.
			expect(f.argv.filter(cmd => cmd[0] === "wt")).toHaveLength(1);
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a blocked bead keeps its worktree for whoever picks it up next", async () => {
		const beads = { ...boundRun(), T: branded() };
		const f = ledger(beads);
		try {
			const blocked = await f.tools.get("orc_finish")?.execute("x", { bead: "T", state: "blocked", reason: "prerequisite missing" }, undefined, undefined, f.ctx("worker"));
			expect(blocked?.details).toMatchObject({ state: "blocked" });
			expect(blocked?.details).not.toMatchObject({ worktree: { removed: true } });
			expect(f.argv.some(cmd => cmd[0] === "wt")).toBe(false);
			// The brand survives untouched, so the successor's claim adopts this tree.
			expect(readWorktreeBrand({ id: "T", metadata: beads.T.metadata })).toMatchObject({ path: "/wt/omp-agent-T", branch: "omp/agent/T" });
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a bead with no worktree closes with nothing to reclaim", async () => {
		const beads = { ...boundRun(), T: { id: "T", issue_type: "task", status: "in_progress", dependencies: [{ id: "E", dependency_type: "parent-child" }] } };
		const f = ledger(beads);
		try {
			const done = await f.tools.get("orc_finish")?.execute("x", { bead: "T", state: "done", reason: "criteria met" }, undefined, undefined, f.ctx("worker"));
			expect(done?.details).toMatchObject({ state: "done" });
			expect((done?.details as { worktree?: unknown }).worktree).toBeUndefined();
			expect(f.argv.some(cmd => cmd[0] === "wt")).toBe(false);
		} finally {
			f.spawn.mockRestore();
		}
	});
});
