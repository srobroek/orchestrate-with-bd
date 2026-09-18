/**
 * D-5: the stale-worktree sweep, run once per session.
 *
 * Every agent bead's work happens in an `omp/agent/<bead>` worktree that `orc_finish` reclaims
 * at closure. A session that died between the close and the reclaim leaves the tree behind, so
 * a session start collects those leftovers — and only those.
 *
 * Two things keep it from destroying work. First, it never runs `wt step prune`: prune is
 * repository-wide, and this repository holds worktrees that belong to nobody in this run. The
 * dry run is used as a *precondition* — when it names anything at all, another party's tree is
 * due for collection and this sweep stands down and reports instead of racing it. Second, it
 * removes only a worktree whose branch names a bead the ledger reports **closed**, through
 * `wt remove` with neither `-f` nor `-D`, and it reads back what was actually released. An open
 * bead's tree, a dirty tree, and an unmerged branch all survive by construction.
 */

import { asBead, parsePayload } from "./bd";
import { agentBeadOf, type CommandRunner, isInside, parseWorktreeEntries, pruneCandidates, removalResidue, removeWorktree, residueRemediation, spawnCommand } from "./worktree";

export interface SweepResult {
	/** `<branch>` of every worktree this sweep released, tree and branch both confirmed gone. */
	swept: string[];
	/** `<branch> <why>` for a candidate that was attempted and survived; the lead remediates it. */
	retained: string[];
	/** Why the sweep did nothing, when it stood down before attempting anything. */
	stoodDown?: string;
}

/**
 * Whether the ledger reports `bead` closed. It goes through the same runner as `git` and `wt`
 * rather than the ledger's `bd` helper: this is one read with no actor and no guards, and the
 * whole sweep is then one injectable seam. Anything unreadable is *not* closed, so its tree
 * stays — a sweep that guessed here would delete the tree of a bead still being worked.
 */
async function isClosed(bead: string, root: string, run: CommandRunner): Promise<boolean> {
	const result = await run(["bd", "show", bead, "--json"], root);
	if (result.code !== 0) return false;
	try {
		const payload = parsePayload(result.stdout);
		return asBead(Array.isArray(payload) ? payload[0] : payload)?.status === "closed";
	} catch {
		return false;
	}
}

/**
 * Collect the worktrees of closed agent beads. `root` is the canonical checkout: the git common
 * directory's parent, which is where `wt` and the ledger both resolve.
 */
export async function sweepStaleWorktrees(root: string, run: CommandRunner = spawnCommand): Promise<SweepResult> {
	const listing = await run(["git", "worktree", "list", "--porcelain"], root);
	if (listing.code !== 0) return { swept: [], retained: [], stoodDown: "git worktree list failed; nothing was swept" };
	// A detached or bare entry carries no branch, and a sweep addresses a worktree by branch.
	const candidates = parseWorktreeEntries(listing.stdout)
		.filter(entry => !isInside(entry.path, root))
		.map(entry => ({ path: entry.path, branch: entry.branch, bead: entry.branch === null ? null : agentBeadOf(entry.branch) }))
		.filter((entry): entry is { path: string; branch: string; bead: string } => entry.bead !== null);
	if (candidates.length === 0) return { swept: [], retained: [] };
	const prune = await pruneCandidates(root, run);
	if (!prune.clear) {
		return { swept: [], retained: [], stoodDown: `wt step prune --dry-run names ${prune.named.join(", ")}; a sweep here could race another party's worktree, so ${candidates.length} agent worktree(s) were left alone` };
	}
	const result: SweepResult = { swept: [], retained: [] };
	for (const candidate of candidates) {
		if (!(await isClosed(candidate.bead, root, run))) continue;
		const removal = await removeWorktree(root, candidate.branch, run);
		const residue = removal.code === 0 ? await removalResidue(root, candidate.path, candidate.branch, run) : { worktree: true, branch: true };
		if (!residue.worktree && !residue.branch) {
			result.swept.push(candidate.branch);
			continue;
		}
		const failure = removal.code === 0 ? undefined : removal.stderr.trim() || removal.stdout.trim() || `wt remove exited ${removal.code}`;
		const remediation = residueRemediation(root, candidate.path, candidate.branch, residue);
		result.retained.push(`${candidate.branch}: ${failure === undefined ? remediation : `${failure} — ${remediation}`}`);
	}
	return result;
}

/** The session-start notice for a sweep, or `undefined` when there is nothing to tell the lead. */
export function sweepMessage(result: SweepResult): string | undefined {
	const parts: string[] = [];
	if (result.swept.length > 0) parts.push(`stale worktree sweep: reclaimed ${result.swept.join(", ")} (their beads are closed)`);
	if (result.retained.length > 0) parts.push(`stale worktree sweep: these survived and need you — ${result.retained.join("; ")}`);
	if (result.stoodDown !== undefined) parts.push(`stale worktree sweep stood down: ${result.stoodDown}`);
	return parts.length === 0 ? undefined : parts.join("\n");
}
