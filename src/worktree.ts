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

import { realpathSync } from "node:fs";
import path from "node:path";
import { agentBranch, integrationBranch } from "./types";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs one argv and waits. Injected so tests drive the ledger without a git repository. */
export type CommandRunner = (argv: readonly string[], cwd: string) => Promise<CommandResult>;

/** The real runner. Failure to spawn is a result with a non-zero code, never a throw. */
export const spawnCommand: CommandRunner = async (argv, cwd) => {
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(argv as string[], { cwd, stdout: "pipe", stderr: "pipe" });
	} catch {
		return { code: 127, stdout: "", stderr: `${argv[0]} is not installed or not executable` };
	}
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
};

/**
 * The absolute canonical checkout containing `cwd`: the parent of the git common directory,
 * which every linked worktree of a repository shares. `null` when `cwd` is in no repository,
 * and every caller treats that as "assume `cwd` is canonical" rather than guessing a root.
 */
export async function canonicalRoot(cwd: string, run: CommandRunner = spawnCommand): Promise<string | null> {
	const result = await run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	if (result.code !== 0) return null;
	const common = result.stdout.trim();
	// `--path-format=absolute` promises an absolute path, so anything else is not a common dir
	// and must not be turned into a root: a guessed root would send every `bd` call elsewhere.
	if (!path.isAbsolute(common)) return null;
	return path.dirname(common);
}

/**
 * The absolute root of the working tree containing `cwd`: the linked worktree an agent works
 * in, which is *not* canonical. `null` when `cwd` is in no repository, and every caller then
 * treats `cwd` itself as the tree rather than guessing one.
 */
export async function worktreeRoot(cwd: string, run: CommandRunner = spawnCommand): Promise<string | null> {
	const result = await run(["git", "rev-parse", "--path-format=absolute", "--show-toplevel"], cwd);
	if (result.code !== 0) return null;
	const top = result.stdout.trim();
	// As in `canonicalRoot`: `--path-format=absolute` promises an absolute path, and anything
	// else is not a working tree and must not be turned into one.
	return path.isAbsolute(top) ? top : null;
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
	const result = await run(["wt", "-C", canonical, "step", "prune", "--dry-run", "--format", "json"], canonical);
	if (result.code !== 0) return { clear: false, named: [`wt step prune --dry-run failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`] };
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

/** Every worktree of the repository containing `cwd`; empty when git cannot answer. */
export async function projectWorktreeEntries(cwd: string, run: CommandRunner = spawnCommand): Promise<WorktreeEntry[]> {
	const result = await run(WORKTREE_LIST_ARGV, cwd);
	return result.code === 0 ? parseWorktreeEntries(result.stdout) : [];
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
	if (isInside(input.worktree, input.canonical)) {
		return { ok: false, reason: `${input.worktree} is inside the canonical checkout ${input.canonical}; a bead's work never mutates canonical` };
	}
	const match = input.worktrees.find(candidate => resolveDeepest(candidate.path) === resolveDeepest(input.worktree));
	if (match === undefined) {
		return {
			ok: false,
			reason: `${input.worktree} is not a worktree of this repository (git worktree list does not report it). Create it with \`wt switch -y --create --no-cd --base <base> --format json ${expected}\``,
		};
	}
	// The branch is read from the *same* porcelain record as the path, never checked apart from
	// it: two workers that transpose their paths and branches each name a real worktree and a
	// real branch, and a brand made of those halves sends the worker into the other bead's tree
	// while every later cleanup addresses the branch this bead recorded.
	if (match.branch !== expected) {
		const where = match.branch === null ? "a detached HEAD" : match.branch;
		return { ok: false, reason: `${input.worktree} is checked out on ${where}, not ${expected}; git worktree list must report this path and this branch in one record. Check you passed your own bead's worktree, not another worker's` };
	}
	return { ok: true, path: match.path };
}

/**
 * Validate a lead-supplied worktree for the run-level edits `orc_bind` applies. The path and
 * expected `omp/integration/<epic>` branch must occur in the same git worktree record: an
 * agent tree, another epic's integration tree, a detached head, and an unknown path are all
 * refused before the bind can write either CI or ledger state.
 */
export function checkLeadWorktree(input: { epic: string; worktree: string; canonical: string; worktrees: readonly WorktreeEntry[] }): WorktreeCheck {
	if (!path.isAbsolute(input.worktree)) return { ok: false, reason: `worktree must be an absolute path, not ${input.worktree}` };
	if (isInside(input.worktree, input.canonical)) {
		return { ok: false, reason: `${input.worktree} is inside the canonical checkout ${input.canonical}; canonical's working tree is never mutated` };
	}
	const match = input.worktrees.find(candidate => resolveDeepest(candidate.path) === resolveDeepest(input.worktree));
	if (match === undefined) {
		return { ok: false, reason: `${input.worktree} is not a worktree of this repository (git worktree list does not report it)` };
	}
	const expected = integrationBranch(input.epic);
	if (match.branch !== expected) {
		const where = match.branch === null ? "a detached HEAD" : match.branch;
		return { ok: false, reason: `${input.worktree} is checked out on ${where}, not ${expected}; git worktree list must report this exact path and integration branch in one record` };
	}
	return { ok: true, path: match.path };
}

/**
 * Remove a bead's worktree and delete its branch, relying on `wt`'s own safety rather than a
 * check of our own: without `-f` it fails on uncommitted changes, and without `-D` it refuses
 * to delete an unmerged branch, so a non-zero exit *is* the dirty-or-unmerged signal. Neither
 * flag is ever passed from here — an automated path must not be able to destroy work.
 */
export async function removeWorktree(canonical: string, branch: string, run: CommandRunner = spawnCommand): Promise<CommandResult> {
	return run(["wt", "-C", canonical, "remove", "-y", "--foreground", branch], canonical);
}

/** What a `wt remove` left behind. Either half is `true` when it could not be proven gone. */
export interface RemovalResidue {
	worktree: boolean;
	branch: boolean;
}

/**
 * What `wt remove` actually left, checked rather than inferred from its exit status: `wt
 * remove` exits **zero** while keeping an unmerged branch, so a zero exit proves the worktree
 * was released and says nothing about the branch. Both halves are read back from git.
 *
 * A half git cannot answer counts as retained, so an unreadable repository asks the lead for
 * remediation instead of reporting a clean reclaim that never happened.
 */
export async function removalResidue(canonical: string, worktreePath: string, branch: string, run: CommandRunner = spawnCommand): Promise<RemovalResidue> {
	const list = await run(WORKTREE_LIST_ARGV, canonical);
	const target = resolveDeepest(worktreePath);
	const worktree = list.code !== 0 || parseWorktreeEntries(list.stdout).some(entry => resolveDeepest(entry.path) === target);
	const branches = await run(["git", "branch", "--list", branch], canonical);
	return { worktree, branch: branches.code !== 0 || branches.stdout.trim().length > 0 };
}

/** The exact Worktrunk remediation for residue a close could not reclaim, for the lead to run. */
export function residueRemediation(canonical: string, worktreePath: string, branch: string, residue: RemovalResidue): string {
	const steps: string[] = [];
	if (residue.worktree) {
		steps.push(`the worktree ${worktreePath} is still registered: commit or discard its changes, then \`wt -C ${canonical} remove -y --foreground ${branch}\``);
	}
	if (residue.branch) {
		steps.push(`the branch ${branch} survives because it is unmerged: merge it, or drop it deliberately with \`wt -C ${canonical} remove -y -D ${branch}\``);
	}
	return steps.join("; ");
}
