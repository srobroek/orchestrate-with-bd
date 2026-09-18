import { describe, expect, spyOn, test, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../src/bd";
import { OMP_EXCLUSION, OMP_JOB_CONDITION, scopeCi, scopeWorkflowText } from "../src/ci-scope";
import { readRunOwnership, readWorktreeBrand, setMetadata } from "../src/types";
import { canonicalRoot, checkLeadWorktree, checkWorktree, isInside, parseWorktreeEntries } from "../src/worktree";
import { clearLedgerRootCache, discoverRun, registerLedger } from "../src/tools/ledger";

afterEach(() => {
	clearLedgerRootCache();
});

/**
 * `git worktree list --porcelain`, in the format the flags ask for: `-z` NUL-terminates every
 * attribute and closes every record with an empty one, and without it git writes lines. A mock
 * that answers NUL whatever it was asked would hide a parser reading the other format.
 */
function porcelain(records: readonly (readonly string[])[], nul = true): string {
	if (nul) return records.map(attributes => `${attributes.map(attribute => `${attribute}\0`).join("")}\0`).join("");
	return records.map(attributes => `${attributes.join("\n")}\n`).join("\n");
}

describe("worktree membership", () => {
	test("parses every worktree with the branch of its own record, detached and bare included", () => {
		const stream = porcelain([
			["worktree /a/canonical", "HEAD abc", "branch refs/heads/main"],
			["worktree /b/linked", "HEAD def", "detached"],
			["worktree /c/bare", "bare"],
		]);
		expect(parseWorktreeEntries(stream)).toEqual([
			{ path: "/a/canonical", branch: "main" },
			{ path: "/b/linked", branch: null },
			{ path: "/c/bare", branch: null },
		]);
		// A branch attribute can only describe the worktree it follows, so a stray one before any
		// record, or a second one inside a record, never lands on another worktree's entry.
		expect(parseWorktreeEntries(porcelain([["branch refs/heads/orphan"], ["worktree /a", "branch refs/heads/one", "branch refs/heads/two"]]))).toEqual([{ path: "/a", branch: "one" }]);
		expect(parseWorktreeEntries("")).toEqual([]);
	});

	test("a worktree path containing a newline is one record, so it cannot inject a second", () => {
		// git allows a newline in a path, and a line-based reader sees `worktree <path>` twice: the
		// phantom entry absorbs the real record's branch, and a claimant naming that phantom path
		// gets a real branch attributed to a directory that is no worktree at all.
		const real = "/wt/t\nworktree /wt/attacker";
		const stdout = porcelain([[`worktree ${real}`, "HEAD abc", "branch refs/heads/omp/agent/b-1"]]);
		expect(parseWorktreeEntries(stdout)).toEqual([{ path: real, branch: "omp/agent/b-1" }]);
		// The claim the injection was for: refused, because no record carries that path.
		const refused = checkWorktree({ bead: "b-1", worktree: "/wt/attacker", branch: "omp/agent/b-1", canonical: "/repo", worktrees: parseWorktreeEntries(stdout) });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reason).toContain("is not a worktree of this repository");
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
		const worktrees = [
			{ path: "/repo", branch: "main" },
			{ path: "/wt/omp-agent-b-1", branch: "omp/agent/b-1" },
		];
		expect(checkWorktree({ bead: "b-1", worktree: "/wt/omp-agent-b-1", branch: "omp/agent/b-1", canonical, worktrees })).toEqual({ ok: true, path: "/wt/omp-agent-b-1" });
		// A worktree of a different repository: absolute, outside canonical, and still refused.
		const foreign = checkWorktree({ bead: "b-1", worktree: "/elsewhere/other-repo-wt", branch: "omp/agent/b-1", canonical, worktrees });
		expect(foreign.ok).toBe(false);
		expect(canonical).not.toBe("/elsewhere/other-repo-wt");
		const inCanonical = checkWorktree({ bead: "b-1", worktree: "/repo/sub", branch: "omp/agent/b-1", canonical, worktrees });
		expect(inCanonical).toMatchObject({ ok: false });
		if (!inCanonical.ok) expect(inCanonical.reason).toContain("canonical checkout");
	});

	test("the accepted record must carry both halves, so a transposed path and branch is refused", () => {
		const canonical = "/repo";
		// Two concurrent workers, each with a real worktree on a real `omp/agent/` branch.
		const worktrees = [
			{ path: "/repo", branch: "main" },
			{ path: "/wt/omp-agent-b-1", branch: "omp/agent/b-1" },
			{ path: "/wt/omp-agent-b-2", branch: "omp/agent/b-2" },
			{ path: "/wt/detached", branch: null },
		];
		// b-1 claims with b-2's path: the branch it names is right and the path is a worktree of
		// this repository, but not of the same record. Accepting it would send b-1's worker into
		// b-2's tree while every later cleanup addressed the branch b-1 recorded.
		const transposed = checkWorktree({ bead: "b-1", worktree: "/wt/omp-agent-b-2", branch: "omp/agent/b-1", canonical, worktrees });
		expect(transposed.ok).toBe(false);
		if (!transposed.ok) {
			expect(transposed.reason).toContain("checked out on omp/agent/b-2");
			expect(transposed.reason).toContain("omp/agent/b-1");
		}
		// A detached tree is on no branch at all, so it cannot be the bead's branded worktree.
		const detached = checkWorktree({ bead: "b-1", worktree: "/wt/detached", branch: "omp/agent/b-1", canonical, worktrees });
		expect(detached.ok).toBe(false);
		if (!detached.ok) expect(detached.reason).toContain("detached HEAD");
	});

	test("a lead's CI worktree must match this epic's integration branch record", () => {
		const canonical = "/repo";
		const worktrees = [
			{ path: "/repo", branch: "main" },
			{ path: "/wt/integration", branch: "omp/integration/E" },
			{ path: "/wt/other-integration", branch: "omp/integration/other" },
			{ path: "/wt/agent", branch: "omp/agent/E.1" },
			{ path: "/wt/detached", branch: null },
		];
		expect(checkLeadWorktree({ epic: "E", worktree: "/wt/integration", canonical, worktrees })).toEqual({ ok: true, path: "/wt/integration" });
		for (const [target, branch] of [
			["/wt/other-integration", "omp/integration/other"],
			["/wt/agent", "omp/agent/E.1"],
			["/wt/detached", "a detached HEAD"],
		] as const) {
			const refused = checkLeadWorktree({ epic: "E", worktree: target, canonical, worktrees });
			expect(refused.ok).toBe(false);
			if (!refused.ok) {
				expect(refused.reason).toContain(branch);
				expect(refused.reason).toContain("omp/integration/E");
			}
		}
		const inside = checkLeadWorktree({ epic: "E", worktree: "/repo", canonical, worktrees });
		expect(inside.ok).toBe(false);
		if (!inside.ok) expect(inside.reason).toContain("canonical checkout");
		const unknown = checkLeadWorktree({ epic: "E", worktree: "/wt/elsewhere", canonical, worktrees });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.reason).toContain("git worktree list does not report it");
		const relative = checkLeadWorktree({ epic: "E", worktree: "wt/integration", canonical, worktrees });
		expect(relative.ok).toBe(false);
		if (!relative.ok) expect(relative.reason).toContain("absolute path");
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

describe("run discovery ownership", () => {
	test("rejects a live run record after the epic's assignee changes away from its owner", async () => {
		const epic: BdBead = {
			id: "E",
			issue_type: "epic",
			status: "in_progress",
			assignee: "omp/recovery",
			metadata: { run: JSON.stringify({ owner: "omp/lead", bound_at: "2026-01-01T00:00:00Z", root: "E" }) },
		};
		expect(await discoverRun("/repo", "omp/lead", async () => [epic])).toEqual({
			state: "stale",
			reason: "run epic E is assigned to omp/recovery, but metadata owner is omp/lead",
		});
	});
});

describe("CI scoping", () => {
	/** One workflow with one PR-only job: the pass would rewrite it if it were allowed to read it. */
	const workflowWithPrOnlyJob = ["on:", "  pull_request:", "jobs:", "  a:", "    steps:", "      - if: github.event_name == 'pull_request'", "        run: ./expensive", ""].join("\n");

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

	test("preserves YAML scalar semantics when extending quoted pull-request conditions", () => {
		const cases = [
			{ scalar: "github.event_name == 'pull_request'", expected: `github.event_name == 'pull_request' && ${OMP_EXCLUSION}`, style: "plain" },
			{ scalar: `"github.event_name == 'pull_request'"`, expected: `github.event_name == 'pull_request' && ${OMP_EXCLUSION}`, style: "double" },
			{ scalar: `'github.event_name == ''pull_request'''`, expected: `github.event_name == 'pull_request' && ${OMP_EXCLUSION}`, style: "single" },
			{ scalar: String.raw`"github.event_name == \"pull_request\""`, expected: `github.event_name == "pull_request" && ${OMP_EXCLUSION}`, style: "double" },
			{ scalar: `'\${{ github.event_name == ''pull_request'' }}'`, expected: `\${{ github.event_name == 'pull_request' && ${OMP_EXCLUSION} }}`, style: "single" },
		] as const;
		for (const { scalar, expected, style } of cases) {
			const source = ["steps:", `  - if: ${scalar}`, ""].join("\n");
			const result = scopeWorkflowText(source);
			expect(result.changed).toEqual([2]);
			expect(result.unhandled).toEqual([]);
			const parsed = Bun.YAML.parse(result.text) as { steps: { if: string }[] };
			expect(parsed.steps[0]?.if).toBe(expected);
			const rendered = result.text.split("\n")[1]?.slice("  - if: ".length) ?? "";
			if (style === "single") expect(rendered.startsWith("'") && rendered.endsWith("'")).toBe(true);
			else if (style === "double") expect(rendered.startsWith('"') && rendered.endsWith('"')).toBe(true);
			else expect(rendered.startsWith("'") || rendered.startsWith('"')).toBe(false);
			const second = scopeWorkflowText(result.text);
			expect(second).toMatchObject({ changed: [], already: [2], text: result.text });
		}
		expect(scopeWorkflowText(["steps:", `  - if: 'github.event_name == ''pull_request'''`, ""].join("\n")).text.split("\n")[1]).toBe(
			`  - if: 'github.event_name == ''pull_request'' && !startsWith(github.head_ref, ''omp/'')'`,
		);
	});

	test("leaves unsupported inline YAML scalar escapes and shapes byte-identical", () => {
		const cases = [
			{ scalar: String.raw`"github.event_name == 'pull_request'\q"`, why: "unsupported YAML condition scalar" },
			{ scalar: `[github.event_name == 'pull_request']`, why: "unsupported YAML condition scalar" },
			{ scalar: `"github.event_name == 'pull_request'" # only on PRs`, why: "trailing comment after the condition" },
			{ scalar: `"github.event_name == 'pull_request'`, why: "unsupported YAML condition scalar" },
		] as const;
		for (const { scalar, why } of cases) {
			const source = ["steps:", `  - if: ${scalar}`, ""].join("\n");
			const result = scopeWorkflowText(source);
			expect(result).toMatchObject({ changed: [], unhandled: [{ line: 2, why }], text: source });
		}
	});

	test("preserves quoted job conditions when adding the whole-job guard", () => {
		const conditions = ["github.actor == 'octocat'", `"github.actor == 'octocat'"`, `'github.actor == ''octocat'''`];
		for (const condition of conditions) {
			const source = ["on:", "  pull_request:", "jobs:", "  gate:", `    if: ${condition}`, "    steps:", "      - run: ./expensive", ""].join("\n");
			const result = scopeWorkflowText(source);
			expect(result).toMatchObject({ changed: [5], unhandled: [] });
			const parsed = Bun.YAML.parse(result.text) as { jobs: { gate: { if: string } } };
			expect(parsed.jobs.gate.if).toBe(`github.actor == 'octocat' && (${OMP_JOB_CONDITION})`);
		}
		const unsupported = ["on:", "  pull_request:", "jobs:", "  gate:", String.raw`    if: "github.actor == 'octocat'\q"`, "    steps:", "      - run: ./expensive", ""].join("\n");
		expect(scopeWorkflowText(unsupported)).toMatchObject({ changed: [], unhandled: [{ line: 5, why: "unsupported YAML condition scalar" }], text: unsupported });
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

	test("only a real negated prefix predicate counts as already scoped", () => {
		// A comparison against one literal branch names `omp/` and excludes exactly that branch, so
		// reading it as scoped would leave every other agent branch running the job while the report
		// claimed the repository was scoped.
		const oneBranch = ["    steps:", "      - if: github.event_name == 'pull_request' && github.head_ref != 'omp/special'", ""].join("\n");
		const narrow = scopeWorkflowText(oneBranch);
		expect(narrow.already).toEqual([]);
		expect(narrow.changed).toEqual([2]);
		expect(narrow.text).toContain(OMP_EXCLUSION);
		// The predicate itself is recognised however it is spaced and quoted, and negated either way,
		// so a hand-written exclusion is never doubled.
		for (const exclusion of [OMP_EXCLUSION, `! startsWith( github . head_ref , "omp/" )`, "startsWith(github.head_ref, 'omp/') == false"]) {
			const already = scopeWorkflowText(["    steps:", `      - if: github.event_name == 'pull_request' && ${exclusion}`, ""].join("\n"));
			expect(already.changed).toEqual([]);
			expect(already.already).toEqual([2]);
		}
	});

	test("an exclusion the condition's logic does not carry through is reported, never counted as scoped", () => {
		// The shape that made a `scoped: true` report a lie: the exclusion is named, and the job
		// still runs its whole matrix on every agent pull request whenever `failure()` holds.
		const partial = ["on:", "  pull_request:", "jobs:", "  py:", "    steps:", "      - if: github.event_name == 'pull_request' && (failure() || !startsWith(github.head_ref, 'omp/'))", "      - run: ./expensive", ""].join("\n");
		const reported = scopeWorkflowText(partial);
		expect(reported.already).toEqual([]);
		expect(reported.changed).toEqual([]);
		expect(reported.unhandled).toEqual([{ line: 6, why: "the omp/** exclusion does not cover every path through this condition" }]);
		expect(reported.text).toBe(partial);
		// A job's own condition of that shape is reported once, not once per pass.
		const job = ["on:", "  pull_request:", "jobs:", "  py:", "    if: github.event_name == 'pull_request' && (failure() || !startsWith(github.head_ref, 'omp/'))", "    steps:", "      - run: ./expensive", ""].join("\n");
		expect(scopeWorkflowText(job).unhandled).toEqual([{ line: 5, why: "the omp/** exclusion does not cover every path through this condition" }]);
		// An exclusion that does dominate still counts, however much else the condition says: a
		// reader that reported every compound condition would leave a scoped repository unscopeable.
		const dominates = ["on:", "  pull_request:", "jobs:", "  py:", "    steps:", "      - if: github.event_name == 'pull_request' && (failure() || matrix.os == 'linux') && !startsWith(github.head_ref, 'omp/')", "      - run: ./expensive", ""].join("\n");
		const credited = scopeWorkflowText(dominates);
		expect(credited.unhandled).toEqual([]);
		expect(credited.changed).toEqual([]);
		expect(credited.already).toEqual([6]);
	});

	test("a step naming the exclusion without covering every path leaves its job needing the guard", () => {
		// No PR-only condition anywhere, so nothing above reaches this job: the step's own mention
		// is all there is, and reading it as the author's differentiation would bill every wave.
		const partial = ["on:", "  pull_request:", "jobs:", "  py:", "    steps:", "      - if: failure() || !startsWith(github.head_ref, 'omp/')", "      - run: ./expensive", ""].join("\n");
		const guarded = scopeWorkflowText(partial);
		expect(guarded.changed).toEqual([5]);
		expect(guarded.text.split("\n")[4]).toBe(`    if: ${OMP_JOB_CONDITION}`);
		// A step that really does exclude `omp/**` is that differentiation, and keeps its job alone.
		const real = ["on:", "  pull_request:", "jobs:", "  py:", "    steps:", "      - if: !startsWith(github.head_ref, 'omp/')", "      - run: ./expensive", ""].join("\n");
		expect(scopeWorkflowText(real)).toMatchObject({ changed: [], unhandled: [] });
	});

	test("an `on:` block behind a YAML alias is reported rather than read as no pull request", () => {
		// The trigger read is textual, so an alias hides the real event list behind an anchor
		// elsewhere in the file. Concluding "no pull_request" there would skip the job pass and
		// still report the repository scoped.
		const aliased = ["x-on: &pr", "  pull_request:", "on: [*pr]", "jobs:", "  a:", "    steps:", "      - run: ./expensive", ""].join("\n");
		const result = scopeWorkflowText(aliased);
		expect(result.changed).toEqual([]);
		expect(result.unhandled).toEqual([{ line: 3, why: "the `on:` block resolves a YAML alias, so whether this workflow triggers on pull_request cannot be read from its text" }]);
		expect(result.text).toBe(aliased);
		// A literal trigger list is still read literally, and a merge key is reported like an alias.
		expect(scopeWorkflowText(["on:", "  pull_request:", "jobs:", "  a:", "    steps:", "      - run: ./expensive", ""].join("\n")).changed).toEqual([5]);
		expect(scopeWorkflowText(["on:", "  <<: *triggers", "jobs:", "  a:", "    steps:", "      - run: ./x", ""].join("\n")).unhandled).toHaveLength(1);
	});

	test("scopeCi rewrites the repository's workflows in place and reports what it could not do", () => {
		const root = mkdtempSync(join(tmpdir(), "ci-scope-"));
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		writeFileSync(join(root, ".github", "workflows", "ci.yml"), "jobs:\n  a:\n    steps:\n      - if: github.event_name == 'pull_request'\n");
		writeFileSync(join(root, ".github", "workflows", "folded.yaml"), "jobs:\n  b:\n    steps:\n      - if: |\n          github.event_name == 'pull_request'\n");
		writeFileSync(join(root, ".github", "workflows", "notes.md"), "not a workflow\n");
		const report = scopeCi(root, "apply");
		expect(report.changed).toEqual([join(".github", "workflows", "ci.yml")]);
		expect(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")).toContain(OMP_EXCLUSION);
		// A shape it will not touch keeps `scoped` false: the lead is told, not lied to.
		expect(report.unhandled).toHaveLength(1);
		expect(report.unhandled[0]).toContain("folded.yaml");
		expect(report.scoped).toBe(false);
		// A second pass changes nothing, and the untouched file is still untouched.
		const again = scopeCi(root, "apply");
		expect(again.changed).toEqual([]);
		expect(again.already).toEqual([join(".github", "workflows", "ci.yml") + ":4"]);
	});

	test("a repository with no workflows is scoped by having nothing to scope", () => {
		const report = scopeCi(mkdtempSync(join(tmpdir(), "ci-none-")), "apply");
		expect(report).toMatchObject({ scoped: true, changed: [], unhandled: [] });
	});

	test("a pull-request job with no condition anywhere gets one: extending steps never reaches it", () => {
		const source = [
			"on:",
			"  pull_request:",
			"  push:",
			"jobs:",
			"  ts:",
			"    steps:",
			"      - name: cheap",
			"        run: bun test",
			"      - name: expensive",
			"        if: github.event_name == 'pull_request'",
			"  py:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: uv run pytest",
			"",
		].join("\n");
		const first = scopeWorkflowText(source);
		// `ts` keeps its unconditional cheap step and only its PR-only step is extended; `py`,
		// which had no condition at all, gains the whole-job one.
		expect(first.text).toContain(`if: github.event_name == 'pull_request' && ${OMP_EXCLUSION}`);
		expect(first.text.split("\n")[11]).toBe(`    if: ${OMP_JOB_CONDITION}`);
		expect(first.text).not.toContain(`  ts:\n    if:`);
		const second = scopeWorkflowText(first.text);
		expect(second.changed).toEqual([]);
		expect(second.text).toBe(first.text);
	});

	test("a workflow that never runs on a pull request keeps every job unconditional", () => {
		const source = ["on:", "  push:", "    branches: [main]", "jobs:", "  release:", "    steps:", "      - run: ./publish", ""].join("\n");
		const result = scopeWorkflowText(source);
		expect(result.changed).toEqual([]);
		expect(result.text).toBe(source);
	});

	test("an unconditional pull-request job keeps scopeCi honest instead of reporting a clean pass", () => {
		const root = mkdtempSync(join(tmpdir(), "ci-job-"));
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		writeFileSync(join(root, ".github", "workflows", "ci.yml"), "on:\n  pull_request:\njobs:\n  py:\n    steps:\n      - run: uv run pytest\n");
		const report = scopeCi(root, "apply");
		expect(report).toMatchObject({ scoped: true, unhandled: [] });
		expect(report.changed).toEqual([join(".github", "workflows", "ci.yml")]);
		expect(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")).toContain(`    if: ${OMP_JOB_CONDITION}`);
		expect(scopeCi(root, "apply").changed).toEqual([]);
	});

	test("a job's unrelated condition survives: the whole-job guard is conjoined to it", () => {
		// The shape `pr-body-prose.yml` actually uses: a folded scalar wrapping one `${{ }}` span
		// over more-indented continuation lines, under a comment. The job carries no PR-only
		// condition, so it runs whole on every agent PR, and replacing the author's bot exemption
		// would change who the workflow gates. Both must hold at once.
		const source = [
			"on:",
			"  pull_request:",
			"    types: [opened, edited]",
			"jobs:",
			"  prose:",
			"    # GitHub REST author IDs: renovate[bot] (#13), release-bot[bot] (#22).",
			"    if: >-",
			"      ${{ !(github.event.pull_request.user.type == 'Bot'",
			"        && (github.event.pull_request.user.id == 29139614",
			"          || github.event.pull_request.user.id == 301724168)) }}",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: uvx --from slopvac python scripts/check-prose-report.py",
			"",
		].join("\n");
		const first = scopeWorkflowText(source);
		expect(first.unhandled).toEqual([]);
		expect(first.changed).toEqual([7]);
		expect(first.text.split("\n").slice(6, 11)).toEqual([
			"    if: >-",
			"      ${{ !(github.event.pull_request.user.type == 'Bot'",
			"        && (github.event.pull_request.user.id == 29139614",
			"          || github.event.pull_request.user.id == 301724168))",
			`        && (${OMP_JOB_CONDITION}) }}`,
		]);
		// The nested `||` sits inside parentheses, so no extra pair is added; the guard's own
		// `||` is parenthesized because a bare one would let `&&` bind to its left half only.
		const second = scopeWorkflowText(first.text);
		expect(second.changed).toEqual([]);
		expect(second.already).toEqual([7]);
		expect(second.text).toBe(first.text);
	});

	test("this repository's own pr-body-prose job is a shape this module scopes, not one it reports", () => {
		const result = scopeWorkflowText(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "pr-body-prose.yml"), "utf8"));
		expect(result.unhandled).toEqual([]);
		// Scoped by this pass or by a previous one, but never reported clean while the prose job
		// still runs its whole matrix on agent PRs — and the author's bot exemption is still there.
		expect(result.changed.length + result.already.length).toBeGreaterThan(0);
		expect(result.text).toContain(OMP_EXCLUSION);
		expect(result.text).toContain("github.event.pull_request.user.type == 'Bot'");
	});

	test("a top-level `||` in a job's condition is parenthesized, so the guard cannot be swallowed", () => {
		const inline = ["on:", "  pull_request:", "jobs:", "  gate:", "    if: github.actor == 'a' || github.actor == 'b'", "    steps:", "      - run: ./x", ""].join("\n");
		const inlined = scopeWorkflowText(inline);
		expect(inlined.text.split("\n")[4]).toBe(`    if: (github.actor == 'a' || github.actor == 'b') && (${OMP_JOB_CONDITION})`);
		// A literal block keeps its lines and gains one: a newline is whitespace to the expression.
		const block = ["on:", "  pull_request:", "jobs:", "  gate:", "    if: |", "      github.actor == 'a'", "        || github.actor == 'b'", "    steps:", "      - run: ./x", ""].join("\n");
		const blocked = scopeWorkflowText(block);
		expect(blocked.unhandled).toEqual([]);
		expect(blocked.changed).toEqual([5]);
		expect(blocked.text.split("\n").slice(4, 8)).toEqual(["    if: |", "      (github.actor == 'a'", "        || github.actor == 'b')", `        && (${OMP_JOB_CONDITION})`]);
	});

	test("a job condition with no unambiguous rewrite is reported, and one report leaves the repository unscoped", () => {
		const refusals: [string, string][] = [
			["    if: github.actor == 'a' # only for a", "trailing comment after the condition"],
			["    if: prefix ${{ github.actor == 'a' }} suffix", "condition mixes literal text with an expression span"],
			["    if: ${{ github.actor == 'a' }} && ${{ github.actor == 'b' }}", "condition mixes literal text with an expression span"],
			["    if: github.actor == 'a' && (github.actor == 'b'", "unbalanced quotes or parentheses in the condition"],
			["    if:", "`if:` with no expression to extend"],
		];
		for (const [condition, why] of refusals) {
			const result = scopeWorkflowText(["on:", "  pull_request:", "jobs:", "  gate:", condition, "    steps:", "      - run: ./x", ""].join("\n"));
			expect(result.unhandled).toEqual([{ line: 5, why }]);
			// Refusing must never fall through to inserting a second `if:` into the same mapping.
			expect(result.changed).toEqual([]);
		}
		const root = mkdtempSync(join(tmpdir(), "ci-refuse-"));
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		const relative = join(".github", "workflows", "ci.yml");
		writeFileSync(join(root, relative), ["on:", "  pull_request:", "jobs:", "  gate:", "    if: github.actor == 'a' # only for a", "    steps:", "      - run: ./x", ""].join("\n"));
		const report = scopeCi(root, "apply");
		expect(report.scoped).toBe(false);
		expect(report.changed).toEqual([]);
		expect(report.unhandled).toEqual([`${relative}:5 trailing comment after the condition`]);
	});

	test("a pull_request_target workflow gets no guard, because the one this module writes cannot fire there", () => {
		// `github.event_name` is `pull_request_target`, so the `!=` half is always true: inserting
		// the guard would change nothing while reporting the job as scoped.
		const source = ["on:", "  pull_request_target:", "    types: [opened]", "jobs:", "  merge:", "    if: github.event.pull_request.user.login == 'dependabot[bot]'", "    steps:", "      - run: gh pr merge", ""].join("\n");
		const result = scopeWorkflowText(source);
		expect(result).toMatchObject({ changed: [], unhandled: [] });
		expect(result.text).toBe(source);
	});

	test("a job whose steps carry the PR-only conditions keeps its own unrelated condition untouched", () => {
		const source = ["on:", "  pull_request:", "jobs:", "  ts:", "    if: github.actor != 'nobody'", "    steps:", "      - run: bun test", "      - if: github.event_name == 'pull_request'", "        run: ./expensive", ""].join("\n");
		const result = scopeWorkflowText(source);
		expect(result.changed).toEqual([8]);
		expect(result.text.split("\n")[4]).toBe("    if: github.actor != 'nobody'");
		expect(result.text.split("\n")[7]).toBe(`      - if: github.event_name == 'pull_request' && ${OMP_EXCLUSION}`);
	});

	test("an insertion above a reported condition moves its line number with the text", () => {
		const source = ["on:", "  pull_request:", "jobs:", "  first:", "    steps:", "      - run: ./cheap", "  second:", "    steps:", "      - if: >-", "          github.event_name == 'pull_request'", ""].join("\n");
		const result = scopeWorkflowText(source);
		const lines = result.text.split("\n");
		expect(result.changed).toEqual([5]);
		expect(lines[4]).toBe(`    if: ${OMP_JOB_CONDITION}`);
		const [entry] = result.unhandled;
		// A line number a human uses to find the condition has to survive the insertion above it.
		expect(lines[(entry?.line ?? 0) - 1]).toContain("if: >-");
	});

	test("a workflow that is not a regular file is never rewritten, and the pass does not claim to be scoped", () => {
		// `writeFileSync` follows a symlink, so rewriting a linked workflow writes through it —
		// possibly outside the checkout this pass was handed. The link is reported, never followed.
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "ci-outside-")));
		const target = join(outside, "shared.yml");
		writeFileSync(target, workflowWithPrOnlyJob);
		const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-link-")));
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		symlinkSync(target, join(root, ".github", "workflows", "linked.yml"));
		const report = scopeCi(root, "apply");
		expect(report.scoped).toBe(false);
		expect(report.changed).toEqual([]);
		expect(report.unhandled).toEqual([".github/workflows/linked.yml is not a regular file; a symlinked workflow is never rewritten"]);
		expect(readFileSync(target, "utf8")).toBe(workflowWithPrOnlyJob);
	});

	test("a workflow directory that leaves the checkout is reported, not written through", () => {
		// The entries are regular files, but `.github/workflows` itself is a link out of the tree.
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "ci-elsewhere-")));
		writeFileSync(join(outside, "ci.yml"), workflowWithPrOnlyJob);
		const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-escape-")));
		mkdirSync(join(root, ".github"), { recursive: true });
		symlinkSync(outside, join(root, ".github", "workflows"));
		const report = scopeCi(root, "apply");
		expect(report.scoped).toBe(false);
		expect(report.changed).toEqual([]);
		expect(report.unhandled).toEqual([`${join(".github", "workflows", "ci.yml")} resolves outside ${root}; nothing was read or written`]);
		expect(readFileSync(join(outside, "ci.yml"), "utf8")).toBe(workflowWithPrOnlyJob);
	});

	test("a workflow directory this process cannot read is a pass that saw nothing, not a scoped repository", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-unreadable-")));
		const dir = join(root, ".github", "workflows");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "ci.yml"), workflowWithPrOnlyJob);
		chmodSync(dir, 0o000);
		try {
			const report = scopeCi(root, "apply");
			// An absent directory is a clean pass; one that cannot be enumerated is not, because
			// `scoped: true` is what `orc_bind` persists as the run's CI state.
			expect(report.scoped).toBe(false);
			expect(report.unhandled[0]).toContain(".github/workflows could not be read");
		} finally {
			chmodSync(dir, 0o755);
		}
	});

	test("a job whose body is an inline mapping is reported, so a repository that still runs it is never called scoped", () => {
		// The whole job is on the key line: there is no line to insert an `if:` before and no step
		// to extend, so this pass cannot reach it. Dropping it silently is what made `scoped: true`
		// a lie — `orc_bind` persists that as the run's CI state while the job bills every agent PR.
		const job = ["on:", "  pull_request:", "jobs:", "  build: { runs-on: ubuntu-latest, steps: [{ run: echo hi }] }", ""].join("\n");
		const perJob = scopeWorkflowText(job);
		expect(perJob.changed).toEqual([]);
		expect(perJob.text).toBe(job);
		expect(perJob.unhandled).toEqual([{ line: 4, why: expect.stringContaining("not a block mapping") }]);
		// The same holds one level up, where `jobs:` itself carries every job on its own line.
		const wholeMapping = ["on:", "  pull_request:", "jobs: { build: { runs-on: ubuntu-latest } }", ""].join("\n");
		const perFile = scopeWorkflowText(wholeMapping);
		expect(perFile.changed).toEqual([]);
		expect(perFile.unhandled).toEqual([{ line: 3, why: expect.stringContaining("inline on the `jobs:` line") }]);
		// What the lead is actually gated on: the repository-level pass refuses to claim a scope.
		const root = mkdtempSync(join(tmpdir(), "ci-inline-"));
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		writeFileSync(join(root, ".github", "workflows", "ci.yml"), job);
		const report = scopeCi(root, "apply");
		expect(report.scoped).toBe(false);
		expect(report.changed).toEqual([]);
		expect(report.unhandled[0]).toContain(`${join(".github", "workflows", "ci.yml")}:4`);
		expect(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")).toBe(job);
	});

	test("a comment after `jobs:` is not an inline mapping, and a workflow no pull request triggers is not reported at all", () => {
		// Reporting either would hold every repository that writes one of them permanently
		// unscopable, and neither hides a job from this pass.
		const commented = ["on:", "  pull_request:", "jobs:  # the matrix", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo hi", ""].join("\n");
		const result = scopeWorkflowText(commented);
		expect(result.unhandled).toEqual([]);
		expect(result.text.split("\n")[4]).toBe(`    if: ${OMP_JOB_CONDITION}`);
		const pushOnly = ["on:", "  push:", "jobs:", "  build: { runs-on: ubuntu-latest }", ""].join("\n");
		expect(scopeWorkflowText(pushOnly)).toMatchObject({ changed: [], unhandled: [] });
	});
});

/**
 * A tool harness over a tiny stateful bd store, one `wt` answer, and a git that answers only
 * what the ledger asks it: where the common directory is (so `root` is canonical) and which
 * working tree a call was made in (so a lead's own worktree is distinguishable from canonical).
 */
function ledger(beads: Record<string, Record<string, unknown>>, options: { wtExit?: number; wtStderr?: string; stillListed?: readonly string[]; stillBranched?: readonly string[]; branched?: readonly { path: string; branch: string }[] } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "orc-run-")));
	mkdirSync(join(root, ".beads"));
	writeFileSync(join(root, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: "embedded", dolt_database: "fx" }));
	const argv: string[][] = [];
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], spawned?: { cwd?: string; env?: Record<string, string> }) => {
		argv.push(cmd);
		if (cmd[0] === "git") {
			// The residue read-back after a removal: what git still reports is what survived.
			const rest = cmd.slice(1).join(" ");
			// `git rev-parse`: canonical is `root` for every call, and the working tree is whichever
			// directory the call was made in — exactly what git prints for a linked worktree.
			if (rest.includes("--git-common-dir")) {
				return { stdout: new Response(`${join(root, ".git")}\n`).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
			}
			if (rest.includes("--show-toplevel")) {
				return { stdout: new Response(`${spawned?.cwd ?? root}\n`).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
			}
			if (rest.startsWith("worktree list")) {
				const records = [
					...(options.stillListed ?? []).map(path => [`worktree ${path}`, "HEAD abc"]),
					...(options.branched ?? []).map(entry => [`worktree ${entry.path}`, "HEAD abc", `branch refs/heads/${entry.branch}`]),
				];
				const listing = porcelain(records, cmd.includes("-z"));
				return { stdout: new Response(listing).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
			}
			if (rest.startsWith("branch --list")) {
				const branch = cmd[cmd.length - 1] ?? "";
				const listed = (options.stillBranched ?? []).includes(branch) ? `  ${branch}\n` : "";
				return { stdout: new Response(listed).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
			}
			return { stdout: new Response("").body, stderr: new Response("").body, exited: Promise.resolve(1), kill: () => undefined } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
		}
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
					else if (args[i] === "--claim") {
						bead.assignee = spawned?.env?.BEADS_ACTOR;
						bead.status = "in_progress";
					} else if (args[i] === "--assignee") {
						// A verdict returns its review bead to open *and unassigned*, which is what puts
						// it back in a wave; an empty value is bd's way of clearing the assignee.
						const value = args[++i] ?? "";
						bead.assignee = value.length === 0 ? undefined : value;
					} else if (args[i] === "--set-metadata") {
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
	return { tools, root, argv, spawn, ctx: (session: string, cwd: string = root) => ({ cwd, sessionManager: { getSessionId: () => session } }) };
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

describe("orc_bind and the run root a child lead inherits", () => {
	test("a child epic's own lead inherits the root run, so its implementation wave is not withheld", async () => {
		// The three-tier shape: the root lead owns E and dispatches the child epic E.1 to a second
		// `orc-lead`, whose session actor is its own. Nothing that session owns carries a run, so
		// the root has to come from the ancestry, not from the epic it was handed.
		const beads = boundRun();
		beads["E.1"] = { id: "E.1", issue_type: "epic", title: "Child epic", status: "open", dependencies: [{ id: "E", dependency_type: "parent-child" }] };
		beads["E.1.1"] = { id: "E.1.1", issue_type: "task", title: "Implement it", status: "open", dependencies: [{ id: "E.1", dependency_type: "parent-child" }] };
		const f = ledger(beads);
		try {
			const bound = await f.tools.get("orc_bind")?.execute("x", { epic: "E.1" }, undefined, undefined, f.ctx("child"));
			expect(bound?.isError ?? false).toBe(false);
			expect(bound?.details).toMatchObject({ run: "E.1", root: "E" });
			// The record on the child epic is what every later session reads.
			expect(readRunOwnership({ id: "E.1", metadata: beads["E.1"]?.metadata as Record<string, unknown> })).toMatchObject({ owner: "omp/child", root: "E" });
			// The consequence: the child is not a run root, so its wave is dispatched rather than
			// withheld for the second DAG review only the root run carries.
			const status = await f.tools.get("orc_status")?.execute("x", {}, undefined, undefined, f.ctx("child"));
			expect(status?.details).toMatchObject({ run: "E.1", ready: ["E.1.1 Implement it"] });
			expect(status?.content[0]?.text).not.toContain("DAG review required");
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a root epic with no ancestry is still its own root", async () => {
		const beads: Record<string, Record<string, unknown>> = { R: { id: "R", issue_type: "epic", title: "Run", status: "open", dependencies: [] } };
		const f = ledger(beads);
		try {
			const bound = await f.tools.get("orc_bind")?.execute("x", { epic: "R" }, undefined, undefined, f.ctx("lead"));
			expect(bound?.details).toMatchObject({ run: "R", root: "R" });
			expect(readRunOwnership({ id: "R", metadata: beads.R?.metadata as Record<string, unknown> })).toMatchObject({ owner: "omp/lead", root: "R" });
			expect(f.argv.some(command => command.includes("heartbeat") && command.includes("R"))).toBe(true);
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a dead run above an epic donates no root, so the mandatory DAG review is not switched off", async () => {
		// The inherited root is what `orc_status` compares the epic against to decide whether it is
		// a run root, and only a run root demands the DAG review. An epic parented under a run
		// nobody holds would otherwise inherit that root and dispatch its whole wave unreviewed.
		for (const above of [{ id: "E", issue_type: "epic", status: "closed", assignee: "omp/lead", metadata: { run: JSON.stringify({ owner: "omp/lead", bound_at: "2026-01-01T00:00:00Z", root: "E", ci_scoped: true }) }, dependencies: [] }, { id: "E", issue_type: "epic", status: "in_progress", assignee: "omp/lead", lease_expires_at: new Date(Date.now() - 1_000).toISOString(), metadata: { run: JSON.stringify({ owner: "omp/lead", bound_at: "2026-01-01T00:00:00Z", root: "E", ci_scoped: true }) }, dependencies: [] }]) {
			const beads: Record<string, Record<string, unknown>> = {
				E: above,
				"E.1": { id: "E.1", issue_type: "epic", title: "Child epic", status: "open", dependencies: [{ id: "E", dependency_type: "parent-child" }] },
				"E.1.1": { id: "E.1.1", issue_type: "task", title: "Implement it", status: "open", dependencies: [{ id: "E.1", dependency_type: "parent-child" }] },
			};
			const f = ledger(beads);
			try {
				const bound = await f.tools.get("orc_bind")?.execute("x", { epic: "E.1" }, undefined, undefined, f.ctx("child"));
				expect(bound?.details).toMatchObject({ run: "E.1", root: "E.1" });
				const status = await f.tools.get("orc_status")?.execute("x", {}, undefined, undefined, f.ctx("child"));
				expect(status?.details).toMatchObject({ run: "E.1", ready: [] });
				expect(status?.content[0]?.text).toContain("DAG review required");
			} finally {
				f.spawn.mockRestore();
				clearLedgerRootCache();
			}
		}
	});

	test("a run whose epic is claimed by someone other than its recorded lead donates no root either", async () => {
		// The lease above is in the future, so the claim is live — it is just not the claim of the
		// lead the record names. A recovery lead or a worker handed the epic refreshes that lease
		// forever over a record its author abandoned, and liveness alone would read that as the run
		// still running and hand its root, and its ungated wave, to every epic underneath.
		const beads: Record<string, Record<string, unknown>> = {
			E: {
				id: "E",
				issue_type: "epic",
				status: "in_progress",
				assignee: "omp/recovery",
				lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
				metadata: { run: JSON.stringify({ owner: "omp/lead", bound_at: "2026-01-01T00:00:00Z", root: "E", ci_scoped: true }) },
				dependencies: [],
			},
			"E.1": { id: "E.1", issue_type: "epic", title: "Child epic", status: "open", dependencies: [{ id: "E", dependency_type: "parent-child" }] },
			"E.1.1": { id: "E.1.1", issue_type: "task", title: "Implement it", status: "open", dependencies: [{ id: "E.1", dependency_type: "parent-child" }] },
		};
		const f = ledger(beads);
		try {
			const bound = await f.tools.get("orc_bind")?.execute("x", { epic: "E.1" }, undefined, undefined, f.ctx("child"));
			expect(bound?.details).toMatchObject({ run: "E.1", root: "E.1" });
			const status = await f.tools.get("orc_status")?.execute("x", {}, undefined, undefined, f.ctx("child"));
			expect(status?.details).toMatchObject({ run: "E.1", ready: [] });
			expect(status?.content[0]?.text).toContain("DAG review required");
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a sub-lead rebinds only inside the epic it owns, never sideways into a sibling", async () => {
		// The sub-lead inherited root E from a live ancestor, but it owns E.1 alone. Authorizing a
		// rebind against the *root* would let it stamp ownership on E.2 — which the ledger would
		// then refuse to E.2's own lead forever, because nothing clears an ownership record.
		const beads = boundRun();
		beads["E.1"] = { id: "E.1", issue_type: "epic", title: "Mine", status: "in_progress", assignee: "omp/child", metadata: { run: JSON.stringify({ owner: "omp/child", bound_at: "2026-01-02T00:00:00Z", root: "E", ci_scoped: true }) }, dependencies: [{ id: "E", dependency_type: "parent-child" }] };
		beads["E.2"] = { id: "E.2", issue_type: "epic", title: "A sibling's", status: "open", dependencies: [{ id: "E", dependency_type: "parent-child" }] };
		const f = ledger(beads);
		try {
			const sideways = await f.tools.get("orc_bind")?.execute("x", { epic: "E.2" }, undefined, undefined, f.ctx("child"));
			expect(sideways?.isError).toBe(true);
			expect(sideways?.content[0]?.text).toContain("a lead rebinds only within an epic it owns (E.1)");
			expect(readRunOwnership({ id: "E.2", metadata: beads["E.2"]?.metadata as Record<string, unknown> })).toBeNull();
		} finally {
			f.spawn.mockRestore();
		}
	});
});

describe("orc_bind scopes CI where a commit can carry it", () => {
	const workflow = "on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - if: github.event_name == 'pull_request'\n        run: ./expensive\n";

	/** `<root>/.github/workflows/ci.yml`, as both a canonical checkout and a worktree carry it. */
	function withWorkflow(root: string): string {
		const file = join(root, ".github", "workflows", "ci.yml");
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		writeFileSync(file, workflow);
		return file;
	}

	test("binding from the lead's worktree writes there and leaves canonical untouched", async () => {
		const beads = boundRun();
		const tree = realpathSync(mkdtempSync(join(tmpdir(), "orc-run-wt-")));
		const f = ledger(beads, { branched: [{ path: tree, branch: "omp/integration/E" }] });
		const canonicalCi = withWorkflow(f.root);
		const worktreeCi = withWorkflow(tree);
		try {
			const bound = await f.tools.get("orc_bind")?.execute("x", { epic: "E" }, undefined, undefined, f.ctx("lead", tree));
			expect(bound?.isError ?? false).toBe(false);
			expect(bound?.details).toMatchObject({ ci: { scoped: true, root: tree, changed: [join(".github", "workflows", "ci.yml")], pending: [] } });
			expect(readFileSync(worktreeCi, "utf8")).toContain(OMP_EXCLUSION);
			// The protected checkout is byte-for-byte what it was: the run's first change belongs on
			// the lead's branch, and canonical's working tree is never mutated.
			expect(readFileSync(canonicalCi, "utf8")).toBe(workflow);
			expect(bound?.content[0]?.text).toContain("commit this as the run's first change");
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("binding from canonical writes nothing and names what is still pending", async () => {
		const beads = boundRun();
		const f = ledger(beads);
		const canonicalCi = withWorkflow(f.root);
		try {
			const bound = await f.tools.get("orc_bind")?.execute("x", { epic: "E" }, undefined, undefined, f.ctx("lead"));
			expect(bound?.isError ?? false).toBe(false);
			expect(readFileSync(canonicalCi, "utf8")).toBe(workflow);
			expect(bound?.details).toMatchObject({ ci: { scoped: false, changed: [], pending: [join(".github", "workflows", "ci.yml")] } });
			// `ci_scoped` records the truth: the exclusion is not in place yet.
			expect(readRunOwnership({ id: "E", metadata: beads.E?.metadata as Record<string, unknown> })).toMatchObject({ ci_scoped: false });
			expect(bound?.content[0]?.text).toContain('call orc_bind again with worktree: "<that path>"');
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a lead binding from canonical names its integration worktree, and the edit lands there", async () => {
		// The shipped sequence binds from canonical, before the integration worktree exists, and a
		// second bind from that worktree would be another session and another actor, which the live
		// binding refuses. Naming the tree is therefore the only way a repository that needs the
		// edit can ever reach `ci_scoped: true`.
		const beads = boundRun();
		const tree = realpathSync(mkdtempSync(join(tmpdir(), "orc-run-integration-")));
		const f = ledger(beads, { branched: [{ path: tree, branch: "omp/integration/E" }] });
		const canonicalCi = withWorkflow(f.root);
		const integrationCi = withWorkflow(tree);
		try {
			const bound = await f.tools.get("orc_bind")?.execute("x", { epic: "E", worktree: tree }, undefined, undefined, f.ctx("lead"));
			expect(bound?.isError ?? false).toBe(false);
			expect(bound?.details).toMatchObject({ ci: { scoped: true, root: tree, changed: [join(".github", "workflows", "ci.yml")], pending: [] } });
			expect(readFileSync(integrationCi, "utf8")).toContain(OMP_EXCLUSION);
			expect(readFileSync(canonicalCi, "utf8")).toBe(workflow);
			expect(readRunOwnership({ id: "E", metadata: beads.E?.metadata as Record<string, unknown> })).toMatchObject({ ci_scoped: true });
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("agent and other integration branches are refused before either CI or ledger writes", async () => {
		const beads = boundRun();
		const agent = realpathSync(mkdtempSync(join(tmpdir(), "orc-run-agent-")));
		const other = realpathSync(mkdtempSync(join(tmpdir(), "orc-run-other-")));
		const f = ledger(beads, {
			branched: [
				{ path: agent, branch: "omp/agent/E.1" },
				{ path: other, branch: "omp/integration/other" },
			],
		});
		const agentCi = withWorkflow(agent);
		const otherCi = withWorkflow(other);
		try {
			const explicit = await f.tools.get("orc_bind")?.execute("x", { epic: "E", worktree: other }, undefined, undefined, f.ctx("lead"));
			expect(explicit?.isError).toBe(true);
			expect(explicit?.content[0]?.text).toContain("omp/integration/other, not omp/integration/E");
			const current = await f.tools.get("orc_bind")?.execute("x", { epic: "E" }, undefined, undefined, f.ctx("lead", agent));
			expect(current?.isError).toBe(true);
			expect(current?.content[0]?.text).toContain("omp/agent/E.1, not omp/integration/E");
			expect(readFileSync(agentCi, "utf8")).toBe(workflow);
			expect(readFileSync(otherCi, "utf8")).toBe(workflow);
			expect(f.argv.some(command => command[1] === "update")).toBe(false);
			expect(readRunOwnership({ id: "E", metadata: beads.E?.metadata as Record<string, unknown> })).toMatchObject({ bound_at: "2026-01-01T00:00:00Z" });
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a target git does not report as a worktree is refused, and nothing is bound", async () => {
		const beads = boundRun();
		const f = ledger(beads);
		const canonicalCi = withWorkflow(f.root);
		try {
			const bound = await f.tools.get("orc_bind")?.execute("x", { epic: "E", worktree: "/tmp/not-a-worktree" }, undefined, undefined, f.ctx("lead"));
			expect(bound?.isError).toBe(true);
			expect(bound?.content[0]?.text).toContain("is not a worktree of this repository");
			expect(bound?.content[0]?.text).toContain("nothing was bound");
			expect(readFileSync(canonicalCi, "utf8")).toBe(workflow);
			// The record on the epic is still the one the fixture bound, with its own timestamp: this
			// call wrote no ownership of its own.
			expect(readRunOwnership({ id: "E", metadata: beads.E?.metadata as Record<string, unknown> })).toMatchObject({ bound_at: "2026-01-01T00:00:00Z" });
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("canonical itself is refused as a target: its working tree is never mutated", async () => {
		const beads = boundRun();
		const f = ledger(beads);
		const canonicalCi = withWorkflow(f.root);
		try {
			const bound = await f.tools.get("orc_bind")?.execute("x", { epic: "E", worktree: f.root }, undefined, undefined, f.ctx("lead"));
			expect(bound?.isError).toBe(true);
			expect(bound?.content[0]?.text).toContain("is inside the canonical checkout");
			expect(readFileSync(canonicalCi, "utf8")).toBe(workflow);
		} finally {
			f.spawn.mockRestore();
		}
	});
});

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
			// `removed: true` is a read-back, not an inference from the exit status: both halves
			// were asked about.
			expect(f.argv.some(cmd => cmd[0] === "git" && cmd.includes("worktree") && cmd.includes("list"))).toBe(true);
			expect(f.argv.some(cmd => cmd[0] === "git" && cmd.includes("branch") && cmd.includes("omp/agent/T"))).toBe(true);
			// A tree proven gone stops being the bead's tree, so nothing later adopts its path.
			expect(readWorktreeBrand({ id: "T", metadata: beads.T.metadata })).toBeNull();
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a zero exit that keeps the unmerged branch is not a reclaim: the bead is orphaned", async () => {
		// `wt remove` exits zero after releasing the worktree while refusing to delete an
		// unmerged branch. Reporting that as "removed and deleted" is what FIX-1 was about.
		const beads = { ...boundRun(), T: branded() };
		const f = ledger(beads, { wtExit: 0, stillBranched: ["omp/agent/T"] });
		try {
			const done = await f.tools.get("orc_finish")?.execute("x", { bead: "T", state: "done", reason: "criteria met" }, undefined, undefined, f.ctx("worker"));
			expect(done?.isError ?? false).toBe(false);
			expect(beads.T.status).toBe("closed");
			expect(done?.details).toMatchObject({ worktree: { removed: false, retained: { worktree: false, branch: true } } });
			expect(done?.content[0]?.text).toContain("merge it, or drop it deliberately with `wt");
			expect(readWorktreeBrand({ id: "T", metadata: beads.T.metadata })).toMatchObject({ orphaned: true });
			expect(f.argv.filter(cmd => cmd[0] === "wt")).toHaveLength(1);
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a refused removal marks the bead orphaned with wt's own words and still reports the close", async () => {
		const beads = { ...boundRun(), T: branded() };
		const f = ledger(beads, { wtExit: 1, wtStderr: "worktree has uncommitted changes; use --force to remove it anyway\n", stillListed: ["/wt/omp-agent-T"], stillBranched: ["omp/agent/T"] });
		try {
			const done = await f.tools.get("orc_finish")?.execute("x", { bead: "T", state: "done", reason: "criteria met" }, undefined, undefined, f.ctx("worker"));
			// The close landed; the worktree is the lead's problem, not a failed tool call.
			expect(done?.isError ?? false).toBe(false);
			expect(beads.T.status).toBe("closed");
			expect(done?.details).toMatchObject({ worktree: { removed: false, retained: { worktree: true, branch: true } } });
			expect(done?.content[0]?.text).toContain("worktree has uncommitted changes; use --force to remove it anyway");
			expect(done?.content[0]?.text).toContain("marked orphaned");
			expect(readWorktreeBrand({ id: "T", metadata: beads.T.metadata })).toMatchObject({ orphaned: true, retained: { worktree: true, branch: true } });
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

	const review = (branch = "omp/agent/V") => ({
		id: "V",
		issue_type: "task",
		title: "Review it",
		status: "in_progress",
		assignee: "omp/reviewer",
		metadata: { role: "reviewer", worktree: JSON.stringify({ path: "/wt/omp-agent-V", branch, run: "E" }) },
		dependencies: [
			{ id: "E", dependency_type: "parent-child" },
			{ id: "T", dependency_type: "blocks" },
		],
	});

	test("a change verdict gives the review worktree back, so the next round is not handed the code it judged", async () => {
		const beads: Record<string, Record<string, unknown>> = { ...boundRun(), T: branded(), V: review() };
		const f = ledger(beads);
		try {
			const done = await f.tools.get("orc_finish")?.execute("x", { bead: "V", state: "done", reason: "criterion 2 fails", verdict: "change", criteria: [2], comment: "the check is missing" }, undefined, undefined, f.ctx("reviewer"));
			expect(done?.isError ?? false).toBe(false);
			// The review bead stays open for round two, and its tree is still given back.
			expect(beads.V?.status).toBe("open");
			expect(done?.details).toMatchObject({ worktree: { path: "/wt/omp-agent-V", branch: "omp/agent/V", removed: true } });
			expect(f.argv.filter(cmd => cmd[0] === "wt")).toEqual([["wt", "-C", f.root, "remove", "-y", "--foreground", "omp/agent/V"]]);
			// The brand goes with it: round two records the tree it creates at the new head instead
			// of adopting a path that no longer exists.
			expect(readWorktreeBrand({ id: "V", metadata: beads.V?.metadata as Record<string, unknown> })).toBeNull();
			const again = await f.tools.get("orc_claim")?.execute("x", { bead: "V" }, undefined, undefined, f.ctx("next"));
			expect(again?.details).toMatchObject({ claimed: true, needs_worktree: true });
			expect(again?.content[0]?.text).toContain("this bead has no worktree yet");
		} finally {
			f.spawn.mockRestore();
		}
	});

	test("a recorded branch that is not this bead's reaches no argv: it is handed to the lead instead", async () => {
		// The brand is validated when written, and again here, because here it becomes `wt remove`
		// argv — and metadata is editable by anything that can reach the store.
		const beads: Record<string, Record<string, unknown>> = { ...boundRun(), V: review("omp/agent/T") };
		const f = ledger(beads);
		try {
			const done = await f.tools.get("orc_finish")?.execute("x", { bead: "V", state: "done", reason: "approved", verdict: "approve" }, undefined, undefined, f.ctx("reviewer"));
			expect(done?.isError ?? false).toBe(false);
			expect(f.argv.some(cmd => cmd[0] === "wt")).toBe(false);
			expect(done?.details).toMatchObject({ worktree: { branch: "omp/agent/T", removed: false } });
			expect(done?.content[0]?.text).toContain("the recorded branch omp/agent/T is not this bead's omp/agent/V");
		} finally {
			f.spawn.mockRestore();
		}
	});
});
