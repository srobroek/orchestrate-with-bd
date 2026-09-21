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
 * bead's tree, a dirty tree, and an unmerged branch all survive by construction. Every candidate's
 * status comes from one `bd show` of all of them: a session start holds a handler budget, and a
 * read per candidate spends seconds each against an embedded store. That read goes through
 * `bd.ts` so an inherited `BEADS_DIR` cannot answer it from another project's database.
 */

import { asBead, bdJson } from "./bd";
import { agentBeadOf, type CommandRunner, GIT_PROBE_TIMEOUT_MS, isInside, parseWorktreeEntries, pruneCandidates, removalResidue, removeWorktree, residueRemediation, spawnCommand, WORKTREE_LIST_ARGV } from "./worktree";

export interface SweepResult {
	/** `<branch>` of every worktree this sweep released, tree and branch both confirmed gone. */
	swept: string[];
	/** `<branch> <why>` for a candidate that was attempted and survived; the lead remediates it. */
	retained: string[];
	/** Why the sweep did nothing, when it stood down before attempting anything. */
	stoodDown?: string;
}

/**
 * How the sweep reads the status of every candidate at once. Injected so tests drive the sweep
 * without a store.
 *
 * It is deliberately *not* the runner that drives `git` and `wt`: that runner inherits the whole
 * environment, and `BEADS_DIR` is the highest-priority branch of bd's store discovery. A session
 * launched with a pin would answer for another project's store, where a bead of the same id may
 * be closed, and this sweep would remove the worktree of a bead that is open here. `bd.ts` is the
 * only path that strips the pin, so the status read goes through it.
 */
export type BeadStatusReader = (beads: readonly string[], root: string) => Promise<ReadonlyMap<string, string>>;

/**
 * The real reader. `bd show` takes every id in one call and reports an id it does not know on
 * stdout without failing, so an absent or unreadable bead is simply missing from the map — and a
 * missing entry is no status at all, so the worktree stays.
 */
export const bdStatusReader: BeadStatusReader = async (beads, root) => {
	const statuses = new Map<string, string>();
	try {
		const payload = await bdJson(["show", ...beads, "--json"], root);
		for (const entry of Array.isArray(payload) ? payload : [payload]) {
			const bead = asBead(entry);
			if (bead !== null && typeof bead.status === "string") statuses.set(bead.id, bead.status);
		}
	} catch {
		// An unreadable store answers for nothing, and a candidate with no status keeps its tree.
	}
	return statuses;
};

/**
 * Collect the worktrees of closed agent beads. `root` is the canonical checkout: the git common
 * directory's parent, which is where `wt`, `bd` and the ledger all resolve.
 */
export async function sweepStaleWorktrees(root: string, run: CommandRunner = spawnCommand, readStatus: BeadStatusReader = bdStatusReader): Promise<SweepResult> {
	const listing = await run(WORKTREE_LIST_ARGV, root, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	if (listing.code !== 0) {
		const detail = listing.stderr.trim() || listing.stdout.trim() || `exit ${listing.code}`;
		return { swept: [], retained: [], stoodDown: `git worktree list failed in ${root}: ${detail}` };
	}
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
	const statuses = await readStatus(candidates.map(candidate => candidate.bead), root);
	const result: SweepResult = { swept: [], retained: [] };
	for (const candidate of candidates) {
		// Anything but a closed bead keeps its tree, including a status this read could not get.
		if (statuses.get(candidate.bead) !== "closed") continue;
		// Re-read immediately before removing. The batch read above can be minutes old by the time
		// this iteration runs, and these bead ids are deterministic: a verdict can reopen the bead
		// and a successor can adopt the same branch name inside that window. The non-force flags
		// below protect a dirty or unmerged tree, but a successor that has claimed and not yet
		// written anything has a clean one.
		const fresh = await readStatus([candidate.bead], root);
		if (fresh.get(candidate.bead) !== "closed") {
			result.retained.push(`${candidate.branch}: reopened during the sweep, so its worktree was left alone`);
			continue;
		}
		// The branch must still name the path this sweep listed. `wt remove` addresses a worktree by
		// branch, so a branch that moved to another checkout would remove the wrong tree.
		const relisted = await run(WORKTREE_LIST_ARGV, root, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
		const stillThere = relisted.code === 0 && parseWorktreeEntries(relisted.stdout).some(entry => entry.branch === candidate.branch && entry.path === candidate.path);
		if (!stillThere) {
			result.retained.push(`${candidate.branch}: no longer names ${candidate.path}, so nothing was removed`);
			continue;
		}
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
