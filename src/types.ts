/**
 * The two metadata records this plugin writes on beads, and their readers.
 *
 * Run identity and worktree ownership live on the beads themselves, never on disk. A
 * checkout-scoped file cannot express either: `task` cannot change a child's cwd, so a root
 * lead and an epic lead resolve the same path and would read and write one another's state.
 *
 * Both records are written with `bd update --set-metadata <key>=<json>`, which stores the
 * value as a string rather than a nested object. That is deliberate: `--set-metadata` merges
 * one key and leaves every sibling key alone, where `--metadata` replaces the whole record
 * and would drop a concurrent `held`/`fix_round` write. `metadataRecord` accepts both a JSON
 * string and a real object, so a value written either way reads back the same.
 */

import { type BdBead, metadataRecord } from "./bd";

/** `metadata.run`, on the run epic: the bead that is the run locator. */
export const RUN_KEY = "run";
/** `metadata.worktree`, on a task bead: the worktree branded onto it at claim time. */
export const WORKTREE_KEY = "worktree";

/** The `omp/`-prefixed branch a bead's worktree must be on; one CI base-ref filter covers every one. */
export function agentBranch(bead: string): string {
	return `omp/agent/${bead}`;
}

/** The branch a lead's run-level integration worktree must use. */
export function integrationBranch(epic: string): string {
	return `omp/integration/${epic}`;
}

/**
 * Which run a lead owns, recorded on the run epic by `orc_bind`. `root` is the run's root
 * epic: the epic's own id for a root lead, the inherited root for a sub-lead that bound a
 * child epic, so a sub-lead's epic is never mistaken for a run root.
 */
export interface RunOwnership {
	owner: string;
	bound_at: string;
	/** Opaque generation that makes a DAG review valid only for this acquisition. */
	review_epoch: string;
	root: string;
	/** Whether this repository's CI excludes pull requests into `omp/**` from its PR-only jobs. */
	ci_scoped: boolean;
	/**
	 * The lead this run was taken from, when `orc_bind` transferred it because that lead's claim
	 * had lapsed. A record, not a permission: the transfer was authorized by the expired native
	 * claim, and this is what tells the next reader the run changed hands rather than started.
	 */
	transferred_from?: string;
}

/**
 * The worktree a bead's work happens in, branded by `orc_claim` and removed by `orc_finish`.
 * It belongs to the *bead*, not to an agent instance: a fix round and a retry re-dispatch the
 * same bead to its phase queue, and the successor adopts this record so the prior attempt's tree
 * is its starting point. A tier escalation is a different bead, which carries no brand and
 * creates its own tree from the predecessor's branch.
 */
export interface WorktreeBrand {
	path: string;
	branch: string;
	/** The run epic this bead resolved to at claim time; absent when the bead is under no bound run. */
	run?: string;
	claimed_at?: string;
	/** Set when `orc_finish` could not remove the worktree, so the lead must remediate. */
	orphaned?: boolean;
	/** `wt remove`'s stderr, or the residue description, kept beside `orphaned` so the lead sees why. */
	removal_error?: string;
	/** Independently observed registration, filesystem path, and branch residue. */
	retained?: {
		worktree: boolean;
		path: boolean;
		branch: boolean;
		registeredBranch?: string | null;
		branchCheckedOutAt?: string;
		branchMerged?: boolean;
		worktreeError?: string;
		branchError?: string;
		mergeError?: string;
		pathError?: string;
		quiescenceError?: string;
	};
}

function field(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `metadata.run`, or `null` when the epic carries none. A record without an `owner` is not
 * ownership and reads as `null`: nobody holds it, so a bind may take it.
 */
export function readRunOwnership(bead: BdBead): RunOwnership | null {
	const record = metadataRecord(metadataRecord(bead.metadata)?.[RUN_KEY]);
	if (record === undefined) return null;
	const owner = field(record, "owner");
	if (owner === undefined) return null;
	const boundAt = field(record, "bound_at") ?? "";
	const transferred = field(record, "transferred_from");
	return {
		owner,
		bound_at: boundAt,
		review_epoch: field(record, "review_epoch") ?? boundAt,
		root: field(record, "root") ?? bead.id,
		ci_scoped: record.ci_scoped === true,
		...(transferred === undefined ? {} : { transferred_from: transferred }),
	};
}

/**
 * `metadata.worktree`, or `null` when the bead carries none. Both `path` and `branch` are
 * required: a half-written brand would let a successor believe it had adopted a tree that
 * has no branch, and silently start from an empty one.
 */
export function readWorktreeBrand(bead: BdBead): WorktreeBrand | null {
	const record = metadataRecord(metadataRecord(bead.metadata)?.[WORKTREE_KEY]);
	if (record === undefined) return null;
	const path = field(record, "path");
	const branch = field(record, "branch");
	if (path === undefined || branch === undefined) return null;
	const brand: WorktreeBrand = { path, branch };
	const run = field(record, "run");
	if (run !== undefined) brand.run = run;
	const claimedAt = field(record, "claimed_at");
	if (claimedAt !== undefined) brand.claimed_at = claimedAt;
	if (record.orphaned === true) brand.orphaned = true;
	const removalError = field(record, "removal_error");
	if (removalError !== undefined) brand.removal_error = removalError;
	const retained = metadataRecord(record.retained);
	if (retained !== undefined) {
		const registeredBranch = retained.registeredBranch;
		const branchCheckedOutAt = field(retained, "branchCheckedOutAt");
		const worktreeError = field(retained, "worktreeError");
		const branchError = field(retained, "branchError");
		const mergeError = field(retained, "mergeError");
		const pathError = field(retained, "pathError");
		const quiescenceError = field(retained, "quiescenceError");
		brand.retained = {
			worktree: retained.worktree === true,
			path: retained.path === true || (retained.path === undefined && retained.worktree === true),
			branch: retained.branch === true,
			...(registeredBranch === null || typeof registeredBranch === "string" ? { registeredBranch } : {}),
			...(branchCheckedOutAt === undefined ? {} : { branchCheckedOutAt }),
			...(typeof retained.branchMerged === "boolean" ? { branchMerged: retained.branchMerged } : {}),
			...(worktreeError === undefined ? {} : { worktreeError }),
			...(branchError === undefined ? {} : { branchError }),
			...(mergeError === undefined ? {} : { mergeError }),
			...(pathError === undefined ? {} : { pathError }),
			...(quiescenceError === undefined ? {} : { quiescenceError }),
		};
	}
	return brand;
}

/** One `--set-metadata` argument: the value is JSON, because bd stores the string verbatim. */
export function setMetadata(key: string, value: unknown): string {
	return `${key}=${JSON.stringify(value)}`;
}
