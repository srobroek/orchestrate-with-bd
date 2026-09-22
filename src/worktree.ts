/**
 * Worktree facts the ledger needs: which checkout is canonical, which worktrees belong to
 * this repository, and whether a claimant's worktree is one of them.
 *
 * Every agent works in its own Worktrunk-created linked worktree, so `ctx.cwd` is a worktree
 * and the store, the workflows, and the git common directory are all in the canonical
 * checkout. Membership is *checked* rather than assumed: `git worktree list --porcelain -z` is
 * repo-scoped, so a worktree of a different repository is not a worktree of this one, and a
 * path is compared by realpath because a symlink inside a worktree can point at canonical.
 *
 * `git worktree list --porcelain` is used rather than `wt list --format json`: the latter is
 * richer but took 22 s in this repository, and a claim must not wait that long. `-z` is not a
 * refinement of it: without it a worktree path containing a newline is indistinguishable from
 * the start of a second record, so a claimant could name a path that is no worktree at all and
 * have a real record's branch attributed to it.
 */

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { agentBranch, integrationBranch } from "./types";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Every git/worktree probe must finish well inside the 30 s tool/session_start budget. */
export const GIT_PROBE_TIMEOUT_MS = 5_000;

/** Optional execution bound for probes that must not hold up session startup. */
export interface CommandOptions {
	timeoutMs?: number;
}

/** Runs one argv and waits. Injected so tests drive the ledger without a git repository. */
export type CommandRunner = (argv: readonly string[], cwd: string, options?: CommandOptions) => Promise<CommandResult>;
/** The caller must distinguish an unanswerable probe from an empty answer. */
function commandFailure(argv: readonly string[], cwd: string, result: CommandResult): string {
	const detail = result.stderr.trim() || result.stdout.trim();
	return detail.length > 0 ? detail : `${argv.join(" ")} in ${cwd} exited ${result.code}`;
}

/** The real runner. Failure to spawn is a result with a non-zero code, never a throw. */
export const spawnCommand: CommandRunner = async (argv, cwd, options) => {
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(argv as string[], { cwd, stdout: "pipe", stderr: "pipe" });
	} catch {
		return { code: 127, stdout: "", stderr: `${argv[0]} is not installed or not executable in ${cwd}` };
	}
	const result = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }));
	// No default bound. Every probe in this file passes its own, and a generic command must stay
	// unbounded: a ledger write legitimately outlives any probe budget. Defaulting to the probe
	// bound killed queued writes at 5 s and reported them as probe timeouts.
	const timeoutMs = options?.timeoutMs;
	if (timeoutMs === undefined) return result;
	const timeout = new Promise<CommandResult>(resolve => {
		const timer = setTimeout(() => {
			proc.kill();
			resolve({ code: 124, stdout: "", stderr: `${argv[0]} timed out after ${timeoutMs}ms in ${cwd}` });
		}, timeoutMs);
		void result.finally(() => clearTimeout(timer));
	});
	return Promise.race([result, timeout]);
};

export type RootResolution = { kind: "known"; root: string } | { kind: "unknown"; reason: string };

function unknownRoot(argv: readonly string[], cwd: string, result: CommandResult): RootResolution {
	return { kind: "unknown", reason: commandFailure(argv, cwd, result) };
}

function gitOverride(): string | undefined {
	for (const name of ["GIT_DIR", "GIT_WORK_TREE"] as const) {
		const value = process.env[name]?.trim();
		if (value !== undefined && value.length > 0) return `${name}=${value}`;
	}
	return undefined;
}

/**
 * The absolute canonical checkout containing `cwd`: the parent of the git common directory,
 * which every linked worktree of a repository shares. An unknown result is never a root: callers
 * must refuse rather than silently redirecting a ledger operation to `cwd`.
 */
export async function canonicalRoot(cwd: string, run: CommandRunner = spawnCommand): Promise<RootResolution> {
	const override = gitOverride();
	if (override !== undefined) return { kind: "unknown", reason: `refusing git environment override ${override}; it may identify a foreign repository` };
	const argv = ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"] as const;
	const result = await run(argv, cwd, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	if (result.code !== 0) return unknownRoot(argv, cwd, result);
	const common = result.stdout.trim();
	// `--path-format=absolute` promises an absolute path, so anything else is not a common dir
	// and must not be turned into a root: a guessed root would send every `bd` call elsewhere.
	if (!path.isAbsolute(common)) return { kind: "unknown", reason: `git returned a non-absolute common directory for ${cwd}: ${common || "(empty output)"}` };
	return { kind: "known", root: path.dirname(common) };
}

/**
 * The absolute root of the working tree containing `cwd`: the linked worktree an agent works
 * in, which is *not* canonical. An unknown result is never a working tree: callers must refuse
 * rather than guessing one.
 */
export async function worktreeRoot(cwd: string, run: CommandRunner = spawnCommand): Promise<RootResolution> {
	const argv = ["git", "rev-parse", "--path-format=absolute", "--show-toplevel"] as const;
	const result = await run(argv, cwd, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	if (result.code !== 0) return unknownRoot(argv, cwd, result);
	const top = result.stdout.trim();
	// As in `canonicalRoot`: `--path-format=absolute` promises an absolute path, and anything
	// else is not a working tree and must not be turned into one.
	return path.isAbsolute(top) ? { kind: "known", root: top } : { kind: "unknown", reason: `git returned a non-absolute worktree for ${cwd}: ${top || "(empty output)"}` };
}

/** One `git worktree list --porcelain -z` record: `branch` is `null` when detached or bare. */
export interface WorktreeEntry {
	path: string;
	branch: string | null;
}

/** The argv every worktree read uses. `-z` is load-bearing; see this module's header. */
export const WORKTREE_LIST_ARGV: readonly string[] = ["git", "worktree", "list", "--porcelain", "-z"];

/**
 * Every worktree `git worktree list --porcelain -z` reports, canonical included, in order, each
 * with the branch of *its own* record. Path and branch are never read apart: a claim that
 * matched them against two different records would brand a transposed pair.
 *
 * `-z` terminates every attribute with a NUL and ends each record with an empty attribute, so
 * a record boundary is a fact of the stream rather than a guess about which bytes in a path
 * might be a line break. An attribute arriving outside a record is dropped rather than
 * attributed to the record before it.
 */
export function parseWorktreeEntries(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | undefined;
	for (const attribute of stdout.split("\0")) {
		if (attribute.length === 0) {
			current = undefined;
			continue;
		}
		if (attribute.startsWith("worktree ")) {
			const value = attribute.slice("worktree ".length);
			current = value.length === 0 ? undefined : { path: value, branch: null };
			if (current !== undefined) entries.push(current);
			continue;
		}
		if (current === undefined || current.branch !== null || !attribute.startsWith("branch ")) continue;
		const ref = attribute.slice("branch ".length);
		const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		if (branch.length > 0) current.branch = branch;
	}
	return entries;
}

/** The bead an `omp/agent/<bead>` branch names, or `null` for any other branch. */
export function agentBeadOf(branch: string): string | null {
	const match = /^omp\/agent\/(?<bead>[^\s/]+(?:\/[^\s/]+)*)$/u.exec(branch);
	return match?.groups?.bead ?? null;
}

/**
 * What an unscoped `wt step prune` would remove, as its own JSON. This is a *precondition
 * probe*, never a removal: a repository whose prune would touch anything is a repository where
 * a sweep of ours could race a human's or another project's worktree, so the sweep stands down
 * and reports instead. `--dry-run --format json` prints `[]` when nothing is due.
 */
export async function pruneCandidates(canonical: string, run: CommandRunner = spawnCommand): Promise<{ clear: boolean; named: string[] }> {
	const argv = ["wt", "-C", canonical, "step", "prune", "--dry-run", "--format", "json"] as const;
	const result = await run(argv, canonical, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	if (result.code !== 0) return { clear: false, named: [`wt step prune --dry-run failed in ${canonical}: ${commandFailure(argv, canonical, result)}`] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout.trim() || "[]");
	} catch {
		return { clear: false, named: [`wt step prune --dry-run printed output this build cannot parse: ${result.stdout.trim().slice(0, 200)}`] };
	}
	if (!Array.isArray(parsed)) return { clear: false, named: ["wt step prune --dry-run printed a non-array payload"] };
	const named = parsed.map(entry => {
		if (entry !== null && typeof entry === "object") {
			const record = entry as Record<string, unknown>;
			for (const key of ["branch", "path", "worktree", "name"]) {
				const value = record[key];
				if (typeof value === "string" && value.length > 0) return value;
			}
		}
		return JSON.stringify(entry);
	});
	return { clear: named.length === 0, named };
}

/** A list probe has a typed failure so an empty repository cannot be confused with an unreadable one. */
export type WorktreeListResult = { kind: "known"; entries: WorktreeEntry[] } | { kind: "unknown"; reason: string };

export async function projectWorktreeEntries(cwd: string, run: CommandRunner = spawnCommand): Promise<WorktreeListResult> {
	const result = await run(WORKTREE_LIST_ARGV, cwd, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	return result.code === 0 ? { kind: "known", entries: parseWorktreeEntries(result.stdout) } : { kind: "unknown", reason: `git worktree list failed in ${cwd}: ${commandFailure(WORKTREE_LIST_ARGV, cwd, result)}` };
}

/**
 * `target` resolved through symlinks as far as it exists. A path that does not exist yet
 * still resolves its deepest existing ancestor, so containment cannot be defeated by naming
 * a file inside a symlinked directory.
 */
export function resolveDeepest(target: string): string {
	let current = path.resolve(target);
	const tail: string[] = [];
	for (;;) {
		try {
			return path.join(realpathSync(current), ...tail.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(target);
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

/** A registered path is usable only while its recorded directory still exists. */
function isExistingDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** Whether `target` is `root` or sits underneath it, compared by realpath, never lexically. */
export function isInside(target: string, root: string): boolean {
	const a = resolveDeepest(target);
	const b = resolveDeepest(root);
	return a === b || a.startsWith(b + path.sep);
}

export type WorktreeCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Validate a claimant-supplied worktree for `bead`. Nothing is created here: the agent
 * creates its worktree with `wt switch` and passes it in, so the ledger never has to guess a
 * base branch, and a claim can be refused before it is taken rather than rolled back after.
 */
export function checkWorktree(input: { bead: string; worktree: string; branch: string; canonical: string; worktrees: readonly WorktreeEntry[] }): WorktreeCheck {
	const expected = agentBranch(input.bead);
	if (input.branch !== expected) return { ok: false, reason: `branch must be ${expected}, not ${input.branch}` };
	if (!path.isAbsolute(input.worktree)) return { ok: false, reason: `worktree must be an absolute path, not ${input.worktree}` };
	if (isInside(input.worktree, input.canonical)) return { ok: false, reason: `${input.worktree} is inside the canonical checkout ${input.canonical}; a bead's work never mutates canonical` };
	const match = input.worktrees.find(candidate => resolveDeepest(candidate.path) === resolveDeepest(input.worktree));
	if (match === undefined) return { ok: false, reason: `${input.worktree} is not a worktree of this repository (git worktree list does not report it). Create it with \`wt switch -y --create --no-cd --base <base> --format json ${expected}\`` };
	if (!isExistingDirectory(match.path)) return { ok: false, reason: `${match.path} is a registered worktree, but its directory was deleted; recreate it before claiming ${expected}` };
	// The branch is read from the *same* porcelain record as the path, never checked apart from it.
	if (match.branch !== expected) {
		const where = match.branch === null ? "a detached HEAD" : match.branch;
		return { ok: false, reason: `${input.worktree} is checked out on ${where}, not ${expected}; git worktree list must report this path and this branch in one record. Check you passed your own bead's worktree, not another worker's` };
	}
	return { ok: true, path: match.path };
}

/** Validate a lead-supplied integration worktree before any bind writes. */
export function checkLeadWorktree(input: { epic: string; worktree: string; canonical: string; worktrees: readonly WorktreeEntry[] }): WorktreeCheck {
	if (!path.isAbsolute(input.worktree)) return { ok: false, reason: `worktree must be an absolute path, not ${input.worktree}` };
	if (isInside(input.worktree, input.canonical)) return { ok: false, reason: `${input.worktree} is inside the canonical checkout ${input.canonical}; canonical's working tree is never mutated` };
	const match = input.worktrees.find(candidate => resolveDeepest(candidate.path) === resolveDeepest(input.worktree));
	if (match === undefined) return { ok: false, reason: `${input.worktree} is not a worktree of this repository (git worktree list does not report it)` };
	if (!isExistingDirectory(match.path)) return { ok: false, reason: `${match.path} is a registered worktree, but its directory was deleted; recreate it before binding integration files` };
	const expected = integrationBranch(input.epic);
	if (match.branch !== expected) {
		const where = match.branch === null ? "a detached HEAD" : match.branch;
		return { ok: false, reason: `${input.worktree} is checked out on ${where}, not ${expected}; git worktree list must report this exact path and integration branch in one record` };
	}
	return { ok: true, path: match.path };
}

/** Remove a bead's worktree and branch without destructive force flags. */
export async function removeWorktree(canonical: string, branch: string, run: CommandRunner = spawnCommand): Promise<CommandResult> {
	return run(["wt", "-C", canonical, "remove", "-y", "--foreground", branch], canonical, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
}

/** What a `wt remove` left behind. Either half is `true` when it could not be proven gone. */
export interface RemovalResidue {
	worktree: boolean;
	branch: boolean;
}

/** Read back both halves of a removal, treating a failed probe as retained. */
export async function removalResidue(canonical: string, worktreePath: string, branch: string, run: CommandRunner = spawnCommand): Promise<RemovalResidue> {
	const list = await run(WORKTREE_LIST_ARGV, canonical, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	const target = resolveDeepest(worktreePath);
	const worktree = list.code !== 0 || parseWorktreeEntries(list.stdout).some(entry => resolveDeepest(entry.path) === target);
	const branches = await run(["git", "branch", "--list", branch], canonical, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	return { worktree, branch: branches.code !== 0 || branches.stdout.trim().length > 0 };
}

/**
 * What the forge knows about a branch that a git probe called unmerged.
 *
 * A squash merge rewrites the patch id of every commit it lands, so `git branch --list`,
 * `git cherry` and a merge-base diff all report a fully landed branch as outstanding. Measured
 * 2026-09-22 across srobroek/omp-plugins: seventeen branches whose pull requests were MERGED were
 * invisible to every git containment test in use, and only the pull request state revealed them.
 * The ledger cannot answer this either — `metadata.merge_sha` was present on 2 of 381 closed beads
 * — so the forge is the only source, and its silence is an answer in its own right.
 */
export type ForgeLanding = { kind: "merged"; pr: number } | { kind: "unlanded" } | { kind: "unknown"; detail: string };

/**
 * Ask the forge whether a MERGED pull request names this branch as its head.
 *
 * `unknown` is a first-class answer — `gh` absent, unauthenticated, offline, or a remote that is
 * not GitHub — and it is never read as landing. The failures are asymmetric: calling unlanded work
 * landed loses it, while keeping a branch too long costs one line of notice.
 */
export async function forgeLanding(canonical: string, branch: string, run: CommandRunner = spawnCommand): Promise<ForgeLanding> {
	const argv = ["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "number,state", "--limit", "20"];
	const result = await run(argv, canonical, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	// 127 is its own case only to name the cause: an absent `gh` is configuration, not a fault.
	if (result.code === 127) return { kind: "unknown", detail: "gh is not installed" };
	if (result.code !== 0) return { kind: "unknown", detail: commandFailure(argv, canonical, result).replace(/\s+/gu, " ") };
	let payload: unknown;
	try {
		payload = JSON.parse(result.stdout);
	} catch {
		return { kind: "unknown", detail: "gh pr list answered unparseable JSON" };
	}
	if (!Array.isArray(payload)) return { kind: "unknown", detail: "gh pr list answered something other than a list" };
	for (const entry of payload) {
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as { number?: unknown; state?: unknown };
		if (record.state === "MERGED" && typeof record.number === "number") return { kind: "merged", pr: record.number };
	}
	return { kind: "unlanded" };
}

/**
 * The exact Worktrunk remediation for residue a close could not reclaim, for the lead to run.
 *
 * Nothing here force-removes anything, and the branch sentence says only what was established:
 * "unmerged" is claimed when the forge agreed or could not be asked, never on a git probe alone,
 * because that probe cannot see a squash merge and telling a lead to "merge it" for work already
 * in main sends them to do nothing useful.
 */
export function residueRemediation(
	canonical: string,
	worktreePath: string,
	branch: string,
	residue: RemovalResidue,
	landing: ForgeLanding = { kind: "unknown", detail: "the forge was not asked" },
): string {
	const steps: string[] = [];
	if (residue.worktree) {
		steps.push(`the worktree ${worktreePath} is still registered: commit or discard its changes, then \`wt -C ${canonical} remove -y --foreground ${branch}\``);
	}
	if (residue.branch) {
		const drop = `drop it deliberately with \`wt -C ${canonical} remove -y -D ${branch}\``;
		if (landing.kind === "merged") {
			steps.push(
				`the branch ${branch} is already landed — pull request #${landing.pr} is MERGED — and survives only because squashing rewrote its patch id, which no git containment test can see: ${drop}`,
			);
		} else if (landing.kind === "unlanded") {
			steps.push(`the branch ${branch} survives because it is unmerged and no merged pull request names it: merge it, or ${drop}`);
		} else {
			steps.push(
				`the branch ${branch} survives because git reports it unmerged, and the forge could not be asked (${landing.detail}), so a squash-landed branch would look identical: check its pull request, then merge it or ${drop}`,
			);
		}
	}
	return steps.join("; ");
}
