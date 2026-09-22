import { bdJson, bdShow } from "./bd";
import { type Holding, startedHoldings } from "./dispatch";

/**
 * Lease renewal for the beads this host's workers are still running.
 *
 * A native claim carries a lease that expires after a TTL the client does not expose as a
 * configurable key — measured at 5 minutes on bd 1.3.0 — and nothing renews a task bead's lease on
 * its own. Left alone, every worker that runs longer than the TTL holds an expired lease, and
 * `bd reclaim --older-than 0s` strips a live worker's claim the moment it is asked to.
 *
 * Renewal is deliberately driven by `task:subagent:lifecycle` rather than by a bare timer. A timer
 * that renews unconditionally would keep a dead worker's lease fresh forever, which is strictly
 * worse than expiry: it makes the lease lie in the direction that suppresses recovery. Gating each
 * tick on a worker the host still sees as `started` ties the lease to the worker's real lifetime,
 * because lifecycle ends a worker on its event rather than after a timeout.
 *
 * Renewal also repairs a claimed-but-leaseless bead: a plain guarded `bd update --status` drops
 * `lease_expires_at` while leaving the claim in place, and only a heartbeat recreates it.
 */

/** Comfortably under the measured 5 minute TTL: a suspended host may miss two ticks and recover. */
const RENEW_INTERVAL_MS = 90_000;

export interface LostLease {
	bead: string;
	/** The actor that was expected to hold it. */
	holder: string;
	worker: string;
	reason: string;
	at: number;
}

const lost = new Map<string, LostLease>();

/** Beads a started worker no longer holds, newest first. Read by `orc_status`. */
export function lostLeases(): LostLease[] {
	return [...lost.values()].sort((left, right) => right.at - left.at);
}

function record(holding: Holding, reason: string): void {
	lost.set(holding.bead, { bead: holding.bead, holder: holding.actor, worker: holding.worker, reason, at: Date.now() });
}

/**
 * Renew one holding, or record why it cannot be renewed.
 *
 * `bd heartbeat` refreshes a lease for any actor — it does not enforce the owner-only rule its own
 * help documents — so ownership is established here, against the bead's recorded assignee, before
 * any renewal. A bead that moved to another actor, or out of `in_progress`, is lease-lost: the
 * worker must stop rather than keep writing against a claim it no longer has. A read failure is
 * not evidence of loss and leaves the holding untouched.
 */
export async function renewHolding(holding: Holding, root: string): Promise<"renewed" | "lease-lost" | "unreadable"> {
	const env = { BEADS_ACTOR: holding.actor };
	let bead;
	try {
		bead = await bdShow(holding.bead, root, env);
	} catch {
		return "unreadable";
	}
	if (bead.status !== "in_progress") {
		record(holding, `status ${typeof bead.status === "string" ? bead.status : "(unknown)"}; the claim is gone`);
		return "lease-lost";
	}
	if (bead.assignee !== holding.actor) {
		record(holding, `held by ${typeof bead.assignee === "string" && bead.assignee.length > 0 ? bead.assignee : "(unassigned)"}, not ${holding.actor}`);
		return "lease-lost";
	}
	try {
		await bdJson(["heartbeat", holding.bead, "--json"], root, env);
	} catch (error) {
		record(holding, error instanceof Error ? error.message : String(error));
		return "lease-lost";
	}
	lost.delete(holding.bead);
	return "renewed";
}

/** One renewal sweep over every started worker's beads. Exposed for tests and the timer alike. */
export async function renewStartedHoldings(resolveRoot: (cwd: string) => Promise<string>): Promise<Map<string, "renewed" | "lease-lost" | "unreadable">> {
	const outcomes = new Map<string, "renewed" | "lease-lost" | "unreadable">();
	const roots = new Map<string, string>();
	for (const holding of startedHoldings()) {
		if (outcomes.has(holding.bead)) continue;
		let root = roots.get(holding.cwd);
		if (root === undefined) {
			try {
				root = await resolveRoot(holding.cwd);
			} catch {
				outcomes.set(holding.bead, "unreadable");
				continue;
			}
			roots.set(holding.cwd, root);
		}
		outcomes.set(holding.bead, await renewHolding(holding, root));
	}
	return outcomes;
}

/**
 * Start the renewal timer. Returns the stop function.
 *
 * The timer is unref'd so it never holds the host open, and never re-enters: a sweep that outruns
 * the interval is awaited rather than stacked. A sweep that throws is swallowed, because the next
 * one recovers — a heartbeat succeeds on an already-expired lease, so a missed window costs
 * nothing unless a reclaim lands inside it.
 */
export function startLeaseRenewal(resolveRoot: (cwd: string) => Promise<string>, intervalMs: number = RENEW_INTERVAL_MS): () => void {
	let sweeping = false;
	const timer = setInterval(() => {
		if (sweeping) return;
		sweeping = true;
		void renewStartedHoldings(resolveRoot)
			.catch(() => undefined)
			.finally(() => {
				sweeping = false;
			});
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
