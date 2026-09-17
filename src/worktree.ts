/**
 * Worktree facts the ledger needs: which checkout is canonical, which worktrees belong to
 * this repository, and whether a claimant's worktree is one of them.
 *
 * Every agent works in its own Worktrunk-created linked worktree, so `ctx.cwd` is a worktree
 * and the store, the workflows, and the git common directory are all in the canonical
 * checkout. Membership is *checked* rather than assumed: `git worktree list --porcelain` is
 * repo-scoped, so a worktree of a different repository is not a worktree of this one, and a
 * path is compared by realpath because a symlink inside a worktree can point at canonical.
 *
 * `git worktree list --porcelain` is used rather than `wt list --format json`: the latter is
 * richer but took 22 s in this repository, and a claim must not wait that long.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { agentBranch } from "./types";

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

/** Every worktree path `git worktree list --porcelain` reports, canonical included, in order. */
export function parseWorktreeList(stdout: string): string[] {
	const paths: string[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("worktree ")) continue;
		const value = line.slice("worktree ".length).trim();
		if (value.length > 0) paths.push(value);
	}
	return paths;
}

/** Every worktree of the repository containing `cwd`; empty when git cannot answer. */
export async function projectWorktrees(cwd: string, run: CommandRunner = spawnCommand): Promise<string[]> {
	const result = await run(["git", "worktree", "list", "--porcelain"], cwd);
	return result.code === 0 ? parseWorktreeList(result.stdout) : [];
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
export function checkWorktree(input: { bead: string; worktree: string; branch: string; canonical: string; worktrees: readonly string[] }): WorktreeCheck {
	const expected = agentBranch(input.bead);
	if (input.branch !== expected) return { ok: false, reason: `branch must be ${expected}, not ${input.branch}` };
	if (!path.isAbsolute(input.worktree)) return { ok: false, reason: `worktree must be an absolute path, not ${input.worktree}` };
	if (isInside(input.worktree, input.canonical)) {
		return { ok: false, reason: `${input.worktree} is inside the canonical checkout ${input.canonical}; a bead's work never mutates canonical` };
	}
	const match = input.worktrees.find(candidate => resolveDeepest(candidate) === resolveDeepest(input.worktree));
	if (match === undefined) {
		return {
			ok: false,
			reason: `${input.worktree} is not a worktree of this repository (git worktree list does not report it). Create it with \`wt switch -y --create --no-cd --base <base> --format json ${expected}\``,
		};
	}
	return { ok: true, path: match };
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
