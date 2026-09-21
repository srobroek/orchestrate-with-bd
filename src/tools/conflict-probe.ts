/**
 * `orc_conflict_probe` — deterministic merge-conflict and CI probe for the Shepherd.
 *
 * Originally a shell script in the orchestrate skill. It predicts whether a branch
 * merges into a base WITHOUT mutating any tree (`git merge-tree`), whether two
 * branches touch overlapping files, and what CI says about a PR.
 *
 * Every answer is a tool result, never an exception: a missing `git`/`gh`, a bad
 * ref, a merge-tree the caller's git cannot classify, or a `gh` that failed before
 * reading any check all return text plus structured `details` with `isError` set, so
 * a probe failure degrades to "unknown" instead of bricking the tool call that asked
 * -- and instead of posing as an answer.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Exec, type ExecResult, spawnExec } from "./bot-review-probe";

/** Which question the probe answers. */
export type ProbeMode = "conflicts" | "pairwise" | "ci";

/** Structured result payload. `error` is set only when the probe could not answer. */
export interface ConflictProbeDetails {
 mode: ProbeMode;
 /** Merge/overlap verdict. Absent for `ci`, and whenever `error` is set. */
 clean?: boolean;
 /** Conflicting paths (`conflicts`). */
 paths?: string[];
 /** Paths both branches touch (`pairwise`). */
 overlap?: string[];
 /**
 * REST check-runs and commit-status responses are normalized to these same exit semantics:
 * 0 every check passed, 8 checks still pending, 1 with output at least one check failed.
 * A GitHub API failure is carried beside `error: "gh failed"` with exitCode 2.
 */
 exitCode?: number;
 error?: string;
 stderr?: string;
}

type Run = (argv: string[]) => Promise<ExecResult | null>;

const TIMEOUT_MS = 30_000;

/**
 * A git object id as `merge-tree` prints it. Width is not pinned to 40: a
 * SHA-256 repository emits 64 hex characters.
 */
const OID = /^[0-9a-f]{40,64}$/i;

/** `git rev-parse` for a ref, pinned to a commit so a tag or tree cannot slip through. */
export function revParseArgv(ref: string): string[] {
 return ["git", "rev-parse", "--verify", `${ref}^{commit}`];
}

/** Predict a merge without writing anything into the working tree. */
export function mergeTreeArgv(base: string, branch: string): string[] {
 return ["git", "merge-tree", "--write-tree", "--name-only", base, branch];
}

export function mergeBaseArgv(base: string, branch: string): string[] {
 return ["git", "merge-base", base, branch];
}

/** Paths a branch changed since its merge base. */
export function diffNamesArgv(from: string, to: string): string[] {
 return ["git", "diff", "--name-only", from, to];
}

/** Read the PR head once; repeated CI probes stay off GraphQL. */
export function ghChecksArgv(pr: string): string[] {
 return ["gh", "api", `repos/{owner}/{repo}/pulls/${pr}`];
}

export function ghCheckRunsArgv(sha: string): string[] {
 return ["gh", "api", "--paginate", "--slurp", `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`];
}

export function ghStatusArgv(sha: string): string[] {
 return ["gh", "api", "--paginate", "--slurp", `repos/{owner}/{repo}/commits/${sha}/status?per_page=100`];
}

/**
 * The tree oid on `git merge-tree --write-tree`'s first line, or `undefined` when the
 * output is not classifiable. Exported for the landing module, which commits that tree
 * when the merge is clean.
 */
export function mergeTreeOid(stdout: string): string | undefined {
 const head = (stdout.split("\n")[0] ?? "").trim();
 return OID.test(head) ? head : undefined;
}

/**
 * Parse `git merge-tree --write-tree --name-only` output.
 *
 * Line 1 is the resulting tree oid; on conflict the conflicting paths follow,
 * terminated by a blank line before git's informational messages. Output whose
 * first line is not an oid is not classifiable, and reports neither clean nor any
 * paths — the caller must treat that as unknown rather than as a clean merge.
 */
export function parseMergeTreeOutput(stdout: string): { clean: boolean; paths: string[] } {
 if (mergeTreeOid(stdout) === undefined) return { clean: false, paths: [] };

 const seen = new Set<string>();
 for (const raw of stdout.split("\n").slice(1)) {
  const line = raw.trim();
  if (line === "") break;
  seen.add(line);
 }
 const paths = [...seen].sort();
 return { clean: paths.length === 0, paths };
}

/** Sorted, de-duplicated intersection of two path lists (the script's `comm -12`). */
export function intersectPaths(a: string[], b: string[]): string[] {
 const right = new Set(b);
 const both = new Set<string>();
 for (const path of a) {
  if (right.has(path)) both.add(path);
 }
 return [...both].sort();
}

/** Non-empty, trimmed lines of a git listing. */
function lines(stdout: string): string[] {
 const out: string[] = [];
 for (const raw of stdout.split("\n")) {
  const line = raw.trim();
  if (line !== "") out.push(line);
 }
 return out;
}
function jsonObject(stdout: string): Record<string, unknown> | null {
 try {
  const value: unknown = JSON.parse(stdout);
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
 } catch {
  return null;
 }
}

function jsonPages(stdout: string): Record<string, unknown>[] | null {
 try {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value)) return null;
  return value.every((page) => page !== null && typeof page === "object" && !Array.isArray(page))
   ? value as Record<string, unknown>[]
   : null;
 } catch {
  return null;
 }
}


function ok(text: string, details: ConflictProbeDetails): AgentToolResult<ConflictProbeDetails> {
 return { content: [{ type: "text", text }], details };
}

function fail(text: string, details: ConflictProbeDetails): AgentToolResult<ConflictProbeDetails> {
 return { content: [{ type: "text", text: `conflict-probe: ${text}` }], details, isError: true };
}

/** No complete subprocess answer is available. */
function missing(argv: string[], mode: ProbeMode): AgentToolResult<ConflictProbeDetails> {
 const bin = argv[0] ?? "git";
 return fail(`${bin} did not answer: unavailable, aborted, timed out, or output limit exceeded`, {
  mode,
  error: "unreadable subprocess evidence",
 });
}

/** A subprocess answered with a failure; its stderr is the only reason the operator gets. */
function failed(text: string, details: ConflictProbeDetails, result: ExecResult): AgentToolResult<ConflictProbeDetails> {
 const stderr = result.stderr.trim();
 if (stderr === "") return fail(text, details);
 return fail(`${text}: ${stderr}`, { ...details, stderr });
}

async function probeConflicts(base: string, branch: string, run: Run): Promise<AgentToolResult<ConflictProbeDetails>> {
 const mode: ProbeMode = "conflicts";
 const baseArgv = revParseArgv(base);
 const baseRev = await run(baseArgv);
 if (!baseRev) return missing(baseArgv, mode);
 if (baseRev.code !== 0) return failed(`bad base ${base}`, { mode, error: "bad ref" }, baseRev);

 const branchArgv = revParseArgv(branch);
 const branchRev = await run(branchArgv);
 if (!branchRev) return missing(branchArgv, mode);
 if (branchRev.code !== 0) return failed(`bad branch ${branch}`, { mode, error: "bad ref" }, branchRev);

 const baseSha = baseRev.stdout.trim();
 const branchSha = branchRev.stdout.trim();
 const argv = mergeTreeArgv(baseSha, branchSha);
 const merge = await run(argv);
 if (!merge) return missing(argv, mode);

 // Exit 0 is the only clean answer. A non-zero exit with conflicting paths is a
 // real conflict; a non-zero exit without them is unknown and must never be
 // reported clean, since the Shepherd would merge on that answer. git's stderr
 // ("unknown option" on a git too old for --write-tree, "refusing to merge unrelated
 // histories") is the one clue to why, so it travels with the refusal.
 if (merge.code === 0) return ok("clean", { mode, clean: true, paths: [] });

 const { paths } = parseMergeTreeOutput(merge.stdout);
 if (paths.length === 0) {
  return failed(`merge-tree could not classify ${base} and ${branch}`, { mode, error: "unclassified" }, merge);
 }
 return ok(paths.join("\n"), { mode, clean: false, paths });
}
async function probePairwise(
 base: string,
 branch: string,
 branchB: string,
 run: Run,
): Promise<AgentToolResult<ConflictProbeDetails>> {
 const mode: ProbeMode = "pairwise";
 const sides: string[] = [];
 for (const side of [branch, branchB]) {
  const mergeBaseArgs = mergeBaseArgv(base, side);
  const mergeBase = await run(mergeBaseArgs);
  if (!mergeBase) return missing(mergeBaseArgs, mode);
  if (mergeBase.code !== 0) {
   return failed(`cannot find merge base for ${base} and ${side}`, { mode, error: "no merge base" }, mergeBase);
  }
  const diffArgs = diffNamesArgv(mergeBase.stdout.trim(), side);
  const diff = await run(diffArgs);
  if (!diff) return missing(diffArgs, mode);
  if (diff.code !== 0) return failed(`cannot diff ${side}`, { mode, error: "diff failed" }, diff);
  sides.push(diff.stdout);
 }
 const overlap = intersectPaths(lines(sides[0] ?? ""), lines(sides[1] ?? ""));
 if (overlap.length === 0) return ok("disjoint", { mode, clean: true, overlap: [] });
 return ok(`overlap:\n${overlap.join("\n")}`, { mode, clean: false, overlap });
}
async function probeCi(pr: string, run: Run): Promise<AgentToolResult<ConflictProbeDetails>> {
 const mode: ProbeMode = "ci";
 const prArgv = ghChecksArgv(pr);
 const pull = await run(prArgv);
 if (!pull) return missing(prArgv, mode);
 if (pull.code !== 0) return failed(`gh api ${pr} failed`, { mode, exitCode: 2, error: "gh failed" }, pull);
 const pullValue = jsonObject(pull.stdout);
 const head = pullValue !== null && typeof pullValue.head === "object" && pullValue.head !== null
  ? (pullValue.head as Record<string, unknown>).sha
  : undefined;
 if (typeof head !== "string" || head === "") {
  return failed(`gh api ${pr} returned no head.sha`, { mode, exitCode: 2, error: "unreadable CI evidence" }, pull);
 }

 const [checkRuns, statuses] = await Promise.all([run(ghCheckRunsArgv(head)), run(ghStatusArgv(head))]);
 const checkArgv = ghCheckRunsArgv(head);
 if (!checkRuns) return missing(checkArgv, mode);
 if (checkRuns.code !== 0) return failed(`gh api ${head}/check-runs failed`, { mode, exitCode: 2, error: "gh failed" }, checkRuns);
 const statusArgv = ghStatusArgv(head);
 if (!statuses) return missing(statusArgv, mode);
 if (statuses.code !== 0) return failed(`gh api ${head}/status failed`, { mode, exitCode: 2, error: "gh failed" }, statuses);
 const runPages = jsonPages(checkRuns.stdout);
 const statusPages = jsonPages(statuses.stdout);
 if (runPages === null || statusPages === null) {
  return fail("REST CI response was not a paginated object", { mode, exitCode: 2, error: "unreadable CI evidence" });
 }
 let pending = false;
 let failing = false;
 const checkRows: unknown[] = [];
 const statusRows: unknown[] = [];
 for (const page of runPages) {
  if (!Array.isArray(page.check_runs)) return fail("REST check-runs response was malformed", { mode, exitCode: 2, error: "unreadable CI evidence" });
  for (const row of page.check_runs) {
   if (row === null || typeof row !== "object") return fail("REST check-runs response was malformed", { mode, exitCode: 2, error: "unreadable CI evidence" });
   const check = row as Record<string, unknown>;
   checkRows.push(check);
   const status = typeof check.status === "string" ? check.status.toLowerCase() : "";
   if (status !== "completed") pending = true;
   else if (!["success", "skipped", "neutral"].includes(typeof check.conclusion === "string" ? check.conclusion.toLowerCase() : "")) failing = true;
  }
 }
 for (const page of statusPages) {
  if (!Array.isArray(page.statuses)) return fail("REST commit-status response was malformed", { mode, exitCode: 2, error: "unreadable CI evidence" });
  for (const row of page.statuses) {
   if (row === null || typeof row !== "object") return fail("REST commit-status response was malformed", { mode, exitCode: 2, error: "unreadable CI evidence" });
   const status = row as Record<string, unknown>;
   statusRows.push(status);
   const state = typeof status.state === "string" ? status.state.toLowerCase() : "";
   if (state === "pending") pending = true;
   else if (state !== "success") failing = true;
  }
 }
	// Nothing at all was reported about this head, so an all-clear cannot be claimed. Map the
	// unknown to the existing waiting exit so callers hold instead of reading silence as a pass.
	// One-sided emptiness is normal and stays classified as before: GitHub exposes check runs
	// and commit statuses through separate, complementary endpoints, so a repository using only
	// one of them legitimately returns no rows from the other. No pages implies no rows, so this
	// covers a structurally empty response too.
	if (checkRows.length === 0 && statusRows.length === 0) {
		return fail("no CI evidence was reported for this head", { mode, exitCode: 8, error: "unreadable CI evidence" });
	}
	const exitCode = failing ? 1 : pending ? 8 : 0;
	return ok(JSON.stringify({ check_runs: checkRows, statuses: statusRows }), { mode, exitCode });
}

/** Register `orc_conflict_probe`. The caller wires this from the extension entry point. */
export function registerConflictProbe(pi: ExtensionAPI, exec: Exec = spawnExec): void {
 const z = pi.zod;

 pi.registerTool({
  name: "orc_conflict_probe",
  label: "Conflict Probe",
  description:
   "Predict merge conflicts and read CI without touching any tree. " +
   "`conflicts`: does <branch> merge cleanly into <base>? " +
   "`pairwise`: do <branch> and <branchB> touch the same files since <base>? " +
   "`ci`: what does `gh pr checks <pr>` say? Its `exitCode` is gh's: 0 all checks passed, " +
   "8 checks still pending, 1 at least one check failed. A gh failure (not authenticated, no PR, " +
   "cancelled) is an error result with `error: \"gh failed\"`, never a CI verdict.",
  approval: "read",
  parameters: z.object({
   mode: z
    .enum(["conflicts", "pairwise", "ci"])
    .describe("conflicts: base vs branch merge prediction; pairwise: file overlap of two branches; ci: gh pr checks"),
   base: z.string().optional().describe("Base ref for `conflicts` and `pairwise` (required for both)"),
   branch: z.string().optional().describe("Branch ref to probe (required for `conflicts` and `pairwise`)"),
   branchB: z.string().optional().describe("Second branch ref, `pairwise` only"),
   pr: z.string().optional().describe("PR number or branch, `ci` only"),
   cwd: z.string().optional().describe("Repository directory to probe in; defaults to the session cwd"),
  }),
  async execute(
   _id: string,
   params: { mode: ProbeMode; base?: string; branch?: string; branchB?: string; pr?: string; cwd?: string },
   signal: AbortSignal | undefined,
   _onUpdate: unknown,
   ctx: ExtensionContext,
  ): Promise<AgentToolResult<ConflictProbeDetails>> {
   const cwd = params.cwd ?? ctx.cwd;
   const deadline = Date.now() + TIMEOUT_MS;
   const run: Run = async (argv) => {
    if (signal?.aborted || Date.now() >= deadline) return null;
    const result = await exec(argv, { cwd, signal, deadline, timeoutMs: TIMEOUT_MS });
    return signal?.aborted || Date.now() >= deadline ? null : result;
   };
   try {
    switch (params.mode) {
     case "conflicts": {
      if (!params.base || !params.branch) {
       return fail("conflicts needs base and branch", { mode: "conflicts", error: "missing arguments" });
      }
      return await probeConflicts(params.base, params.branch, run);
     }
     case "pairwise": {
      if (!params.base || !params.branch || !params.branchB) {
       return fail("pairwise needs base, branch and branchB", { mode: "pairwise", error: "missing arguments" });
      }
      return await probePairwise(params.base, params.branch, params.branchB, run);
     }
     case "ci": {
      if (!params.pr) return fail("ci needs pr", { mode: "ci", error: "missing arguments" });
      return await probeCi(params.pr, run);
     }
    }
   } catch (err) {
    // Defence in depth: an unexpected throw here would surface as a tool
    // crash, which reads to the model as "the repo is broken".
    return fail(String(err), { mode: params.mode, error: "probe failed" });
   }
  },
 });
}
