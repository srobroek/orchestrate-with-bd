import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { bdCapabilities, type BdBead, bdJson, bdList, bdShow, isGuardMismatch, metadataRecord, parentOf } from "../bd";
import { beadIds, DESCENDANT_LIMIT, descendants, readStoreMode, readyWave, runShape, tierOf, todoStrings, type WaveItem, waveItem } from "../dag";
import { applyDecision, applyVerdict, dagReviewCommand, type Decision, type DecisionOutcome, type HoldCause, holdOf, isDagReview, REVIEW_ROLES, type Tier, type Verdict, type VerdictOutcome } from "../verdict";
import { type CiScopeReport, ciScopeMessage, scopeCi } from "../ci-scope";
import { agentBranch, readRunOwnership, readWorktreeBrand, RUN_KEY, type RunOwnership, setMetadata, WORKTREE_KEY, type WorktreeBrand } from "../types";
import { canonicalRoot, checkWorktree, projectWorktrees, removeWorktree, resolveDeepest } from "../worktree";
import { workerFor } from "../dispatch";

/** Whether `epic` sits under `ancestor` through parent-child edges, walking at most four levels. */
async function isDescendant(epic: string, ancestor: string, cwd: string): Promise<boolean> {
	let current = epic;
	for (let depth = 0; depth < 4; depth++) {
		const parent = parentOf(await bdShow(current, cwd));
		if (parent === undefined) return false;
		if (parent === ancestor) return true;
		current = parent;
	}
	return false;
}

/**
 * The actor for one tool call: `omp/<session id>` of the session that issued it. Every
 * subagent has its own session, so concurrent children never share an actor even though
 * they share one process. `bd` refuses mutations without an actor, so this is never empty.
 */
export function actorFor(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getSessionId();
	return `omp/${id.length > 0 ? id : "anon"}`;
}

/**
 * The canonical checkout for one tool call. Every `bd` call runs there: an agent's `ctx.cwd`
 * is its own linked worktree, and the store — like `.github/workflows` — lives in canonical,
 * which every linked worktree shares through the git common directory. Cached per cwd: it
 * spawns git, and the answer cannot change while a session lives.
 */
const canonicalByCwd = new Map<string, Promise<string>>();

export function ledgerRoot(cwd: string): Promise<string> {
	let resolved = canonicalByCwd.get(cwd);
	if (resolved === undefined) {
		resolved = canonicalRoot(cwd).then(root => root ?? cwd);
		canonicalByCwd.set(cwd, resolved);
	}
	return resolved;
}

/** Test isolation for callers that replace `Bun.spawn`; production callers never need this. */
export function clearLedgerRootCache(): void {
	canonicalByCwd.clear();
}

/** A run epic and the ownership record that makes it one. */
export interface OwnedRun {
	epic: BdBead;
	run: RunOwnership;
}

export type RunLookup =
	| { state: "bound"; owned: OwnedRun }
	| { state: "none" }
	| { state: "stale"; reason: string }
	| { state: "ambiguous"; epics: string[] };

/**
 * Which run this actor owns, read from the ledger rather than from a file beside the
 * checkout. Every epic carrying `metadata.run` is a run someone bound; the ones this actor
 * owns and that are still live are its candidates. Two live owned runs are never guessed
 * between: a lead that bound twice is told to close or release one.
 */
export async function discoverRun(root: string, actor: string, list: typeof bdList = bdList): Promise<RunLookup> {
	let epics: BdBead[];
	try {
		epics = await list(["-t", "epic", "--has-metadata-key", RUN_KEY, "--limit", "0"], root);
	} catch (error) {
		return { state: "stale", reason: `run epics unreadable: ${error instanceof Error ? error.message : String(error)}` };
	}
	const owned: OwnedRun[] = [];
	for (const epic of epics) {
		const run = readRunOwnership(epic);
		if (run !== null && run.owner === actor) owned.push({ epic, run });
	}
	const live = owned.filter(candidate => candidate.epic.status !== "closed");
	if (live.length === 1) return { state: "bound", owned: live[0] as OwnedRun };
	if (live.length > 1) return { state: "ambiguous", epics: live.map(candidate => candidate.epic.id) };
	if (owned.length > 0) return { state: "stale", reason: `run epic ${owned.map(candidate => candidate.epic.id).join(", ")} is closed` };
	return { state: "none" };
}

/**
 * The run a bead belongs to: the nearest ancestor-or-self epic carrying `metadata.run`,
 * found by walking parent edges. This is what makes the `run` on a worktree brand a fact
 * rather than a claimant's assertion — the claimant never supplies it.
 */
export async function runOf(bead: BdBead, root: string, env: Record<string, string>): Promise<OwnedRun | null> {
	let current: BdBead | undefined = bead;
	for (let depth = 0; depth <= DESCENDANT_LIMIT && current !== undefined; depth++) {
		const run = readRunOwnership(current);
		if (run !== null) return { epic: current, run };
		const parent = parentOf(current);
		if (parent === undefined) return null;
		current = await bdShow(parent, root, env);
	}
	return null;
}

/** Why a lookup that found no single live run cannot authorize a lead's write, and the fix. */
export function runLookupRefusal(lookup: Exclude<RunLookup, { state: "bound" }>): string {
	if (lookup.state === "none") return "no run bound; call orc_bind { epic } first";
	if (lookup.state === "stale") return `${lookup.reason}; call orc_bind with a new epic before reading or writing the run`;
	return `two live runs are bound to you (${lookup.epics.join(", ")}); close or release one, this ledger will not guess which is yours`;
}

export interface ClaimResult {
	claimed: boolean;
	bead?: BdBead;
	lease_expires_at?: string;
	reason?: string;
	/** The bead's worktree: adopted from a prior attempt, or branded onto the bead by this claim. */
	worktree?: WorktreeBrand;
	/** True when `worktree` came from a prior attempt; the claimant works there, it creates nothing. */
	adopted?: boolean;
	/** True when an adopted worktree is no longer a worktree of this repository: recreate it at `worktree.branch`. */
	worktree_missing?: boolean;
}

export interface BindResult {
	run: string | null;
	root: string;
	epic?: BdBead;
	message?: string;
	/** What the D18 CI scoping pass did; `changed` files are the run's first commit. */
	ci?: CiScopeReport;
}

export interface FinishResult {
	state: "done" | "blocked";
	bead: string;
	/** Present when the bead is a review bead: what the verdict did. */
	verdict?: VerdictOutcome;
	/** Present when the bead carried a worktree: whether closing it reclaimed the tree. */
	worktree?: { path: string; branch: string; removed: boolean; error?: string };
}
export interface ReleaseResult {
	released: boolean;
	tier?: "own" | "worker-ended:completed" | "worker-ended:failed" | "worker-ended:aborted" | "reclaimed" | "forced";
	bead?: BdBead;
	reason?: string;
}

/** A task held for the lead's decision, as listed by `orc_status.decisions`. */
export interface HeldTask {
	bead: string;
	title: string;
	tier: Tier;
	cause: HoldCause;
	/** The review bead that raised it. */
	by: string;
	suggested: Decision;
	/** Same-tier rounds so far. */
	rounds: number;
	/** Prior decisions on this task and its predecessors. */
	decided: string[];
}

export interface StatusResult {
	run: string | null;
	/** The run epic itself, so a lead can see its status without a second read. */
	epic?: BdBead;
	/** `three-tier` when a direct child of the epic is an epic (one `orc-lead` each), else `two-tier`. */
	shape?: "two-tier" | "three-tier";
	/**
	 * The wave, as `<bead-id> <title>`. Two-tier: unblocked, unassigned tasks. Three-tier: ready
	 * child epics while any is open; once all are closed with terminal subtrees, the run epic's
	 * own ready tasks (the cross-epic review). Withheld when the walk was truncated.
	 */
	ready?: string[];
	/** The same wave, one entry per `ready` item, with the agent each bead is routed to. */
	wave?: WaveItem[];
	/** Claimed descendants with native lease state when the client supports it. */
	held?: Array<{ bead: string; holder: string; lease_expires_at?: string; lease_expired: boolean; worker?: { id: string; status: string; endedAt?: string } }>;
	/** Tasks held for the lead; each is moved only by `orc_decide`. */
	decisions?: HeldTask[];
	store: string;
	beads: BdBead[];
	todo: string[];
	truncated?: true;
	/**
	 * The subset of `ready` that was not ready at this session's previous `orc_status` for this
	 * run. The lead calls `orc_status` on every child result and dispatches these at once, so a
	 * bead unblocked by the first finisher never waits for the slowest sibling.
	 */
	newly_ready?: string[];
	message?: string;
}

/**
 * Bead ids from each session's most recent `orc_status`, for the todo drift advisory.
 * Keyed by session id because subagents share one process: an epic lead's status must not
 * redraw the root's baseline.
 */
const statusIdsBySession = new Map<string, Set<string>>();

export function statusBeadIds(ctx: ExtensionContext): Set<string> | null {
	return statusIdsBySession.get(ctx.sessionManager.getSessionId()) ?? null;
}

/** The wave each session's most recent `orc_status` returned, keyed by bead id, for the dispatch routing gate. */
const statusWaveBySession = new Map<string, Map<string, WaveItem>>();

export function statusWave(ctx: ExtensionContext): Map<string, WaveItem> | null {
	return statusWaveBySession.get(ctx.sessionManager.getSessionId()) ?? null;
}

export function clearStatusWave(ctx: ExtensionContext): void {
	statusWaveBySession.delete(ctx.sessionManager.getSessionId());
}

/**
 * The ready set each session's most recent `orc_status` returned, for `newly_ready`. It is a
 * snapshot rather than an accumulation, so a bead that leaves the wave and comes back — a fix
 * round, a reopened review — is newly ready again. The run id is kept beside it: a rebind
 * starts a new run, whose first wave is entirely new.
 */
const readySeenBySession = new Map<string, { run: string; ready: Set<string> }>();

/** Ready ids not in this session's previous snapshot for `run`, and the snapshot replaced. */
function newlyReady(session: string, run: string, ready: readonly string[]): Set<string> {
	const previous = readySeenBySession.get(session);
	const seen = previous !== undefined && previous.run === run ? previous.ready : new Set<string>();
	const fresh = new Set(ready.filter(id => !seen.has(id)));
	readySeenBySession.set(session, { run, ready: new Set(ready) });
	return fresh;
}

function text<T>(details: T, line: string, isError = false): AgentToolResult<T> {
	return { content: [{ type: "text", text: line }], details, isError };
}

function refused<T>(reason: string): AgentToolResult<T> {
	return { content: [{ type: "text", text: reason }], details: undefined as T, isError: true };
}

const HEARTBEAT_INTERVAL_MS = 60_000;
const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

function heartbeatKey(session: string, cwd: string, bead: string): string {
	return `${session}\u0000${cwd}\u0000${bead}`;
}

function stopHeartbeat(session: string, cwd: string, bead: string): void {
	const key = heartbeatKey(session, cwd, bead);
	const timer = heartbeatTimers.get(key);
	if (timer === undefined) return;
	clearInterval(timer);
	heartbeatTimers.delete(key);
}

async function startHeartbeat(session: string, cwd: string, actor: string, bead: string): Promise<void> {
	const key = heartbeatKey(session, cwd, bead);
	stopHeartbeat(session, cwd, bead);
	const env = { BEADS_ACTOR: actor };
	await bdJson(["heartbeat", bead, "--json"], cwd, env);
	const timer = setInterval(() => {
		void bdJson(["heartbeat", bead, "--json"], cwd, env).catch(() => stopHeartbeat(session, cwd, bead));
	}, HEARTBEAT_INTERVAL_MS);
	(timer as unknown as { unref?: () => void }).unref?.();
	heartbeatTimers.set(key, timer);
}

function reclaimedCount(value: unknown): number {
	if (Array.isArray(value)) return value.length;
	if (value === null || typeof value !== "object") return 0;
	const record = value as Record<string, unknown>;
	for (const key of ["count", "reclaimed", "updated"]) {
		const count = record[key];
		if (typeof count === "number") return count;
	}
	return 0;
}

/**
 * Give a closed bead's worktree back, relying on `wt`'s own safety instead of a check of our
 * own: without `-f` it fails on uncommitted changes and without `-D` it refuses to delete an
 * unmerged branch, so a non-zero exit *is* the dirty-or-unmerged signal. Neither flag is ever
 * passed from here. A failure is recorded on the bead and handed to the lead as work to do —
 * it is never retried around, and it never turns a landed close into a tool error.
 */
async function reclaimWorktree(bead: BdBead, root: string, env: Record<string, string>): Promise<FinishResult["worktree"]> {
	const brand = readWorktreeBrand(bead);
	if (brand === null) return undefined;
	const removal = await removeWorktree(root, brand.branch);
	if (removal.code === 0) return { path: brand.path, branch: brand.branch, removed: true };
	const error = removal.stderr.trim() || removal.stdout.trim() || `wt remove exited ${removal.code}`;
	const orphaned: WorktreeBrand = { ...brand, orphaned: true, removal_error: error };
	await bdJson(["comment", bead.id, `worktree ${brand.path} (${brand.branch}) not reclaimed: ${error}`], root, env).catch(() => undefined);
	await bdJson(["update", bead.id, "--set-metadata", setMetadata(WORKTREE_KEY, orphaned), "--json"], root, env).catch(() => undefined);
	return { path: brand.path, branch: brand.branch, removed: false, error };
}

/** The worktree sentence appended to a finish line: nothing, reclaimed, or the lead's problem. */
function worktreeLine(worktree: FinishResult["worktree"]): string {
	if (worktree === undefined) return "";
	if (worktree.removed) return `\nworktree ${worktree.path} removed and ${worktree.branch} deleted`;
	return `\nworktree ${worktree.path} (${worktree.branch}) was NOT removed and is marked orphaned: ${worktree.error}\nremediate it yourself: uncommitted work must be committed or discarded, an unmerged branch must be merged or dropped. It was never force-removed.`;
}

export function registerLedger(pi: ExtensionAPI): void {
	const z = pi.zod;
	// Named consts, not inline `z.object(...)` arguments: inlined, the generic no longer
	// infers and `input` degrades to `unknown`.
	const claimParams = z.object({
		bead: z.string().describe("bead id to claim"),
		worktree: z.string().optional().describe("absolute path of the worktree you created for this bead; omit to adopt the worktree the bead already carries"),
		branch: z.string().optional().describe("branch of that worktree; must be omp/agent/<bead-id>"),
	});
	const finishParams = z.object({
		bead: z.string().describe("bead id"),
		state: z.enum(["done", "blocked"]),
		reason: z.string().describe("one-line reason recorded on the transition"),
		comment: z.string().optional().describe("evidence or rationale, stored as a bead comment; for a review bead, the findings"),
		verdict: z
			.enum(["approve", "fix", "change", "escalate"])
			.optional()
			.describe(
				"review beads only, required with `done`: `approve` closes; `fix` (a defect in the code) and `change` (a stated criterion not met; name it in `criteria`) reopen the reviewed tasks for the same implementer at the same tier, at most two rounds per tier; `escalate` (with `cause`) holds the task for the lead's decision. Tiers never change from a verdict",
			),
		criteria: z.array(z.number().int().positive()).optional().describe("`change`: the numbered acceptance criteria that fail"),
		cause: z.enum(["design", "contract", "security", "unbounded"]).optional().describe("`escalate`: why this tier cannot resolve it: a design decision the bead did not make, a contract other beads consume, an exploitable security defect, or a bead that is itself under-specified"),
		targets: z.array(z.string()).optional().describe("review beads: the task ids the verdict applies to; defaults to the review bead's task dependencies"),
	});
	const decideParams = z.object({
		bead: z.string().describe("a held task id, from orc_status.decisions"),
		action: z.enum(["retry", "upgrade", "split", "accept", "stop"]),
		reason: z.string().describe("why this action; recorded as a comment on the task"),
	});
	const bindParams = z.object({
		epic: z.string().describe("run epic id to bind this checkout to"),
	});
	const statusParams = z.object({ epic: z.string().optional().describe("the bound run epic id, for an explicit check; binding is orc_bind") });

	const releaseParams = z.object({ bead: z.string(), holder: z.string().describe("current assignee, copied from orc_status.held"), reason: z.string().min(10), force: z.boolean().optional().describe("release without worker evidence; recorded as a takeover") });
	pi.registerTool({
		name: "orc_release",
		label: "Release bead",
		description:
			"Release a held bead after worker-ended, own, or explicit force evidence. The bead keeps its worktree: the next holder adopts it, so a release hands over the prior attempt's tree rather than discarding it.",
		approval: "write",
		parameters: releaseParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<ReleaseResult | undefined>> {
			const actor = actorFor(ctx);
			const env = { BEADS_ACTOR: actor };
			const root = await ledgerRoot(ctx.cwd);
			const capabilities = await bdCapabilities(root);
			try {
				// `metadata.worktree` is deliberately untouched on every path below: it belongs to
				// the bead, not to the actor being released, and the successor claims it by adopting.
				const before = await bdShow(input.bead, root, env);
				if (before.status === "closed") return text({ released: false, reason: "closed" }, `orc_release ${input.bead}: closed`);
				if (!before.assignee) return text({ released: true, reason: "already unassigned" }, `orc_release ${input.bead}: already unassigned`);
				if (before.assignee !== input.holder) return text({ released: false, reason: `holder changed: now ${before.assignee ?? "(unassigned)"}` }, `orc_release ${input.bead}: holder changed: now ${before.assignee ?? "(unassigned)"}`, true);
				const worker = workerFor(ctx.sessionManager.getSessionId(), input.bead);
				if (worker?.status === "started") return refused(`worker ${worker.id} dispatched by this session is still running; hub cancel it or wait`);
				const tier: ReleaseResult["tier"] = worker && worker.status !== "started" ? (`worker-ended:${worker.status}` as ReleaseResult["tier"]) : before.assignee === actor ? "own" : input.force === true ? "forced" : undefined;
				if (tier === undefined && capabilities.leases) {
					const reclaimed = await bdJson(["reclaim", "--id", input.bead, "--older-than", "0s", "--json"], root, env);
					if (reclaimedCount(reclaimed) === 1) {
						stopHeartbeat(ctx.sessionManager.getSessionId(), root, input.bead);
						const after = await bdShow(input.bead, root, env);
						return text({ released: true, tier: "reclaimed", bead: after }, `orc_release ${input.bead}: released (reclaimed)`);
					}
				}
				if (tier === undefined) return refused(`no liveness evidence for ${input.holder}: this session did not dispatch a worker for ${input.bead}. Confirm with hub list/jobs that no agent is working it, then call again with force: true.`);
				const unclaim = ["unclaim", input.bead, "--reason", `release (${tier}): ${input.reason} — by ${actor}`];
				if (input.force === true && before.assignee !== actor) unclaim.push("--force");
				else unclaim.push("--if-assignee", input.holder);
				try {
					await bdJson([...unclaim, "--json"], root, env);
				} catch (error) {
					const current = await bdShow(input.bead, root, env);
					if (current.assignee !== undefined && current.assignee !== input.holder) return text({ released: false, bead: current, reason: `holder changed: now ${current.assignee}` }, `orc_release ${input.bead}: holder changed: now ${current.assignee}`, true);
					throw error;
				}
				stopHeartbeat(ctx.sessionManager.getSessionId(), root, input.bead);
				const after = await bdShow(input.bead, root, env);
				if (after.assignee || after.status !== "open") return text({ released: false, bead: after, reason: `readback still shows ${after.assignee ?? "(unassigned)"}/${after.status}` }, `orc_release ${input.bead}: readback still shows ${after.assignee ?? "(unassigned)"}/${after.status}`, true);
				return text({ released: true, tier, bead: after }, `orc_release ${input.bead}: released (${tier})`);
			} catch (error) {
				return refused(error instanceof Error ? error.message : String(error));
			}
		},
	});

	pi.registerTool({
		name: "orc_claim",
		label: "Claim bead",
		description:
			"Claim one Beads task for this agent and brand its worktree. On bd 1.3+, compare-and-set guards make the open/unassigned transition atomic and the native lease is heartbeated while this session lives. A task bead's work happens in a linked worktree on `omp/agent/<bead-id>`: when the bead already carries one — a fix round, a retry, or a tier escalation — the claim returns it and you work there, because the prior attempt's code is in it. Otherwise pass the `worktree` you created and its `branch`; the claim is refused, not guessed, when they are missing or are not a worktree of this repository.",
		approval: "write",
		parameters: claimParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<ClaimResult | undefined>> {
			const bead = input.bead.trim();
			const actor = actorFor(ctx);
			const env = { BEADS_ACTOR: actor };
			const root = await ledgerRoot(ctx.cwd);
			const capabilities = await bdCapabilities(root);
			// Read before claiming: whether this bead already owns a worktree decides whether the
			// claimant may omit one, and a claim that cannot be branded must not be taken at all.
			const before = await bdShow(bead, root, env);
			const existing = readWorktreeBrand(before);
			const wantsBrand = existing === null && before.issue_type !== "epic";
			let supplied: WorktreeBrand | undefined;
			if (wantsBrand) {
				const worktree = input.worktree?.trim();
				const branch = input.branch?.trim() ?? agentBranch(bead);
				if (worktree === undefined || worktree.length === 0) {
					return refused(
						`orc_claim ${bead}: this bead has no worktree yet, so the claim needs one. Create it, then claim again:\n  wt switch -y --create --no-cd --base <base-branch> --format json ${agentBranch(bead)}\nthen orc_claim { bead: "${bead}", worktree: "<the path it printed>", branch: "${agentBranch(bead)}" }`,
					);
				}
				const check = checkWorktree({ bead, worktree, branch, canonical: root, worktrees: await projectWorktrees(root) });
				if (!check.ok) return refused(`orc_claim ${bead}: ${check.reason}`);
				supplied = { path: check.path, branch };
			}
			let claimError: string | undefined;
			try {
				if (capabilities.cas) {
					await bdJson(["update", bead, "--assignee", actor, "--status", "in_progress", "--if-assignee", "", "--if-status", "open", "--json"], root, env);
				} else {
					await bdJson(["update", bead, "--claim", "--json"], root, env);
				}
			} catch (error: unknown) {
				if (capabilities.cas && !isGuardMismatch(error)) throw error;
				claimError = error instanceof Error ? error.message : String(error);
			}
			const observed = await bdShow(bead, root, env);
			if (observed.assignee !== actor) {
				const holder = observed.assignee ?? "(unassigned)";
				const reason = claimError === undefined ? `held by ${holder}` : `held by ${holder}; ${claimError}`;
				return text<ClaimResult>({ claimed: false, bead: observed, reason }, `orc_claim ${bead}: not claimed, ${reason}`);
			}
			let brand = existing ?? undefined;
			if (supplied !== undefined) {
				// The run is resolved from the bead's ancestry, never taken from the claimant: a
				// worktree branded with a run it does not belong to would route its PR at the wrong
				// integration branch.
				const owned = await runOf(observed, root, env).catch(() => null);
				const written: WorktreeBrand = { ...supplied, claimed_at: new Date().toISOString(), ...(owned === null ? {} : { run: owned.epic.id }) };
				try {
					await bdJson(["update", bead, "--set-metadata", setMetadata(WORKTREE_KEY, written), "--json"], root, env);
				} catch (error) {
					// Claim and brand are one transition. A bead left claimed but unbranded would send
					// its successor to an empty branch, so the claim is given back with bd's own
					// message intact — the retry rule matches that text, and nothing here retries.
					const message = error instanceof Error ? error.message : String(error);
					await bdJson(["unclaim", bead, "--if-assignee", actor, "--reason", `claim rolled back: could not brand worktree: ${message}`, "--json"], root, env).catch(() => undefined);
					stopHeartbeat(ctx.sessionManager.getSessionId(), root, bead);
					return refused(`orc_claim ${bead}: claimed, then rolled back because the worktree could not be recorded on the bead: ${message}`);
				}
				brand = written;
			}
			if (capabilities.leases) {
				try {
					await startHeartbeat(ctx.sessionManager.getSessionId(), root, actor, bead);
				} catch {
					stopHeartbeat(ctx.sessionManager.getSessionId(), root, bead);
				}
			}
			const adopted = existing !== null;
			// An adopted worktree that git no longer reports was pruned between attempts; the
			// successor recreates it at the same branch rather than being told it exists.
			const missing = existing !== null && !(await projectWorktrees(root)).some(candidate => resolveDeepest(candidate) === resolveDeepest(existing.path));
			const result: ClaimResult = { claimed: true, bead: observed, lease_expires_at: observed.lease_expires_at, ...(brand === undefined ? {} : { worktree: brand }), ...(adopted ? { adopted: true } : {}), ...(missing ? { worktree_missing: true } : {}) };
			const lease = observed.lease_expires_at === undefined ? "" : `; lease expires ${observed.lease_expires_at}`;
			const where =
				brand === undefined
					? ""
					: missing
						? `\nits worktree ${brand.path} is gone; recreate it at the same branch: wt switch -y --create --no-cd --base <base-branch> --format json ${brand.branch}`
						: adopted
							? `\nwork in the worktree this bead already owns, it holds the prior attempt: ${brand.path} (${brand.branch})`
							: `\nworktree recorded: ${brand.path} (${brand.branch})`;
			return text<ClaimResult>(result, `orc_claim ${bead}: claimed by ${actor}${lease}${where}`);
		},
	});

	pi.registerTool({
		name: "orc_finish",
		label: "Finish bead",
		description:
			"Record a terminal state on a Beads task: `done` closes it with the reason, `blocked` records the reason as a comment and sets the status. A review bead (`metadata.role` reviewer or dag-reviewer) finishes `done` with a `verdict`: `approve` closes it; `fix` (a code defect) and `change` (a criterion not met, named in `criteria`) reopen the reviewed tasks with the findings for the same implementer at the same tier, at most two rounds per tier, after which the ledger holds the task for the lead (`repeated`); `escalate` with a `cause` holds the task at once. A held task is decided only by the lead through orc_decide; tiers never change from a verdict. On a DAG review anything but `approve` is `change` and sends the lead to orc-planner. After a non-approve the review bead stays open and re-enters the wave when its dependencies close. An epic closes only when every bead under it is closed; with an open or in-progress descendant `done` is refused and the ids are listed.",
		approval: "write",
		parameters: finishParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<FinishResult | undefined>> {
			const bead = input.bead.trim();
			const env = { BEADS_ACTOR: actorFor(ctx) };
			const root = await ledgerRoot(ctx.cwd);
			if (input.comment !== undefined && input.comment.trim().length > 0) {
				await bdJson(["comment", bead, input.comment], root, env);
			}
			if (input.state === "done") {
				// An epic closes only when its subtree is terminal. Observed 2026-09-14: an epic
				// lead closed its epic with two review beads still open, and the root had to reopen
				// it and dispatch a recovery lead.
				const current = await bdShow(bead, root, env);
				const role = metadataRecord(current.metadata)?.role;
				if (typeof role === "string" && REVIEW_ROLES[role] === true) {
					// A review finishes with a verdict, never a bare close: the verdict is what
					// routes the next wave (same implementer, or the lead's decision).
					if (input.verdict === undefined) {
						return text<FinishResult>({ state: "done", bead }, `orc_finish ${bead}: refused, a review bead finishes with a verdict (approve, fix, change, or escalate)`, true);
					}
					let outcome: VerdictOutcome;
					try {
						outcome = await applyVerdict({
							review: current,
							verdict: input.verdict as Verdict,
							reason: input.reason,
							findings: input.comment ?? "",
							criteria: input.criteria,
							cause: input.cause,
							targets: input.targets,
							show: id => bdShow(id, root, env),
							bd: args => bdJson(args, root, env),
						});
					} catch (error) {
						return text<FinishResult>({ state: "done", bead }, error instanceof Error ? error.message : String(error), true);
					}
					stopHeartbeat(ctx.sessionManager.getSessionId(), root, bead);
					// A verdict that closes the review ends it; `fix` and `change` leave it open for
					// the next round, and an open bead keeps its worktree.
					const closedReview = (await bdShow(bead, root, env).catch(() => undefined))?.status === "closed";
					const reclaimed = closedReview ? await reclaimWorktree(current, root, env) : undefined;
					return text<FinishResult>({ state: "done", bead, verdict: outcome, ...(reclaimed === undefined ? {} : { worktree: reclaimed }) }, `${outcome.line}${worktreeLine(reclaimed)}`);
				}
				if (input.verdict !== undefined) {
					return text<FinishResult>({ state: "done", bead }, `orc_finish ${bead}: refused, a verdict applies to a review bead; this bead's role is ${typeof role === "string" && role.length > 0 ? role : "(none)"}`, true);
				}
				if (current.issue_type === "epic") {
					const walk = await descendants(bead, root);
					if (walk.truncated) {
						return text<FinishResult>(
							{ state: "done", bead },
							`orc_finish ${bead}: refused, the epic has more than ${DESCENDANT_LIMIT} descendants and the terminal check cannot see them all. Close its child epics individually.`,
							true,
						);
					}
					const unfinished = walk.beads.filter(child => child.status === "open" || child.status === "in_progress");
					if (unfinished.length > 0) {
						const list = unfinished.map(child => child.id).join(", ");
						return text<FinishResult>(
							{ state: "done", bead },
							`orc_finish ${bead}: refused, epic has unfinished beads: ${list}. Finish or block them first.`,
							true,
						);
					}
				}
				await bdJson(["close", bead, "--reason", input.reason, "--json"], root, env);
				stopHeartbeat(ctx.sessionManager.getSessionId(), root, bead);
				const reclaimed = await reclaimWorktree(current, root, env);
				return text<FinishResult>({ state: "done", bead, ...(reclaimed === undefined ? {} : { worktree: reclaimed }) }, `orc_finish ${bead}: done${worktreeLine(reclaimed)}`);
			}
			// `bd update` still has no `--reason` (bd 1.3.0), so the reason is recorded as a
			// comment first; the transition follows only once that write has landed.
			await bdJson(["comment", bead, `blocked: ${input.reason}`], root, env);
			await bdJson(["update", bead, "--status", "blocked", "--json"], root, env);
			stopHeartbeat(ctx.sessionManager.getSessionId(), root, bead);
			// A blocked bead keeps its worktree. Its work is unfinished, and the successor that
			// picks the bead up — a retry, or a higher tier — adopts that tree as its starting
			// point; reclaiming it here would discard exactly what the next attempt needs.
			return text<FinishResult>({ state: "blocked", bead }, `orc_finish ${bead}: blocked`);
		},
	});

	pi.registerTool({
		name: "orc_bind",
		label: "Bind run",
		description:
			"Bind a run epic to this lead and claim it. Ownership is recorded on the epic itself, so every session resolves the run from the ledger and a second lead cannot bind a run someone else holds. Call it once before orc_status. It also scopes this repository's CI away from `omp/**` head branches when that is missing, and names the files it changed: commit them as the run's first change.",
		approval: "write",
		parameters: bindParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<BindResult | undefined>> {
			const root = await ledgerRoot(ctx.cwd);
			const epic = input.epic.trim();
			const actor = actorFor(ctx);
			const env = { BEADS_ACTOR: actor };
			// The run this lead already owns, read from the ledger. It is what refuses a second
			// unrelated bind, the job the checkout-scoped locator used to do badly: `task` cannot
			// give a child its own cwd, so a root lead and an epic lead shared one file.
			const lookup = await discoverRun(root, actor);
			if (lookup.state === "ambiguous") {
				const message = `two live runs are bound to you (${lookup.epics.join(", ")}); close or release one before binding, this ledger will not guess which is yours`;
				return text<BindResult>({ run: null, root: epic, message }, message, true);
			}
			let rootId = epic;
			if (lookup.state === "bound" && lookup.owned.epic.id !== epic) {
				const held = lookup.owned;
				if (!(await isDescendant(epic, held.run.root, root))) {
					const message = `run already bound to ${held.epic.id}; a lead rebinds only to a child epic of its run (root ${held.run.root}); close that epic to start another run`;
					return text<BindResult>({ run: held.epic.id, root: held.run.root, message }, message, true);
				}
				rootId = held.run.root;
			} else if (lookup.state === "bound") {
				rootId = lookup.owned.run.root;
			}
			// The epic must exist before anything is bound: `bd list --parent <typo>` exits 0
			// with `[]`, which would otherwise persist a typo as an empty successful run.
			let epicBead = await bdShow(epic, root, env);
			if (epicBead.issue_type !== "epic") {
				const message = `${epic} is a ${epicBead.issue_type ?? "bead of unknown type"}, not an epic; a run binds an epic`;
				return text<BindResult>({ run: null, root: rootId, message }, message, true);
			}
			// Ownership already on the epic outranks this call: it is the record a second lead's
			// bind must lose to, and it survives every session that reads it.
			const owner = readRunOwnership(epicBead);
			if (owner !== null && owner.owner !== actor && epicBead.status !== "closed") {
				const message = `epic ${epic} is already bound to ${owner.owner} (since ${owner.bound_at || "an unrecorded time"}); one run has one lead`;
				return text<BindResult>({ run: null, root: rootId, message }, message, true);
			}
			if (!epicBead.assignee) await bdJson(["update", epic, "--claim", "--json"], root, env).catch(() => undefined);
			epicBead = await bdShow(epic, root, env);
			if (epicBead.assignee !== actor) {
				const holder = epicBead.assignee ?? "(unassigned)";
				const message = `epic ${epic} is held by ${holder}; a lead binds only the epic it claims`;
				return text<BindResult>({ run: null, root: rootId, message }, message, true);
			}
			// D18, as behaviour rather than a question: an unscoped repository runs its whole PR
			// matrix on every agent branch, so the exclusion is added here and reported, and the
			// outcome is recorded on the run so a later session can see it was done.
			const ci = scopeCi(root);
			const ownership: RunOwnership = { owner: actor, bound_at: new Date().toISOString(), root: rootId, ci_scoped: ci.scoped };
			await bdJson(["update", epic, "--set-metadata", setMetadata(RUN_KEY, ownership), "--json"], root, env);
			return text<BindResult>({ run: epic, root: rootId, epic: epicBead, ci }, `orc_bind ${epic}: bound (run root ${rootId}, actor ${actor})\n${ciScopeMessage(ci)}`);
		},
	});

	pi.registerTool({
		name: "orc_decide",
		label: "Decide a held task",
		description:
			"The lead's resourcing decision on a task `orc_status` lists under `decisions` (held by a reviewer's `escalate` or by the ledger after two same-tier rounds). `retry`: another round at the same tier with the findings. `upgrade`: a fix bead one tier up supersedes the task; the review re-enters when it closes. `split`: an orc-planner bead decomposes the task into bounded parts. `accept`: close the task as is with a follow-up bead for the residue; its reviews close. `stop`: park it for the human; the last resort, refused until an upgrade or split has been tried. Only the actor holding the bound run epic may decide, and only on tasks under that run. Each decision is recorded as a comment on the task.",
		approval: "write",
		parameters: decideParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<DecisionOutcome | undefined>> {
			const root = await ledgerRoot(ctx.cwd);
			const actor = actorFor(ctx);
			const env = { BEADS_ACTOR: actor };
			const lookup = await discoverRun(root, actor);
			if (lookup.state !== "bound") return refused(`orc_decide: ${runLookupRefusal(lookup)}`);
			const run = lookup.owned.epic.id;
			if (lookup.owned.epic.assignee !== actor) {
				return refused(`orc_decide: only the lead holding ${run} decides; it is held by ${lookup.owned.epic.assignee ?? "(unassigned)"} and you are ${actor}`);
			}
			const bead = input.bead.trim();
			if (bead !== run && !(await isDescendant(bead, run, root))) return refused(`orc_decide ${bead}: not under the bound run ${run}`);
			const task = await bdShow(bead, root, env);
			let outcome: DecisionOutcome;
			try {
				outcome = await applyDecision({ task, action: input.action, reason: input.reason, bd: args => bdJson(args, root, env) });
			} catch (error) {
				return refused(error instanceof Error ? error.message : String(error));
			}
			return text<DecisionOutcome>(outcome, outcome.line);
		},
	});

	pi.registerTool({
		name: "orc_status",
		label: "Run status",
		description:
			"Read the bound run's whole subtree from Beads; this tool writes nothing, bind first with `orc_bind`. `ready` is the wave and one `task` call dispatches all of it; `wave` gives each item's `agent`, which the `task` call copies (implementer tier from the bead's `metadata.tier`): unblocked, unassigned tasks under the epic (two-tier), or the child epics that are unblocked, not yet bound by a lead, and hold at least one ready task, one `orc-lead` each (three-tier). `newly_ready` is the part of `ready` that was not ready when you last called this tool: call orc_status on every child result and dispatch `newly_ready` at once, never waiting for a wave to drain. `todo` holds `<bead-id> <title>` for every open or in-progress bead and is the only legitimate source of todo items. `shape` is `three-tier` when a direct child of the epic is an epic (dispatch one `orc-lead` per child epic) and `two-tier` otherwise. `epic`, when passed, must be the bound run.",
		approval: "read",
		parameters: statusParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<StatusResult | undefined>> {
			const root = await ledgerRoot(ctx.cwd);
			const mode = readStoreMode(root);
			const store = mode === null ? "no .beads/metadata.json" : `${mode.database ?? "?"} (${mode.mode || "?"})`;
			const requested = input.epic?.trim() || undefined;
			// Run identity comes from the ledger: the epic carrying this actor's `metadata.run`.
			const lookup = await discoverRun(root, actorFor(ctx));
			if (lookup.state !== "bound") {
				clearStatusWave(ctx);
				const suffix = requested === undefined ? "" : ` Pass it to orc_bind: orc_bind { epic: "${requested}" }`;
				const message = `${runLookupRefusal(lookup)}.${suffix}`;
				return text<StatusResult>({ run: null, store, beads: [], todo: [], message }, message, true);
			}
			const epic = lookup.owned.epic.id;
			if (requested !== undefined && requested !== epic) {
				const message = `run is bound to ${epic}; call orc_status without epic, or orc_bind { epic: "${requested}" } to rebind a child epic`;
				return text<StatusResult>({ run: epic, store, beads: [], todo: [], message }, message, true);
			}
			const runRoot = lookup.owned.run.root;
			const capabilities = await bdCapabilities(root);
			const epicBead = await bdShow(epic, root, {}, capabilities.briefDeps ? ["--brief-deps"] : []);
			const walk = await descendants(epic, root, capabilities);
			// One DAG review per run gates every implementation wave (see readyWave). This tool
			// reads; it does not create the bead. When the root's tree has tasks but no review
			// bead, the wave is withheld and the exact create command is returned. A sub-lead's
			// epic is a descendant of the run root, so it needs none.
			const isRoot = runRoot === epic;
			const dagReviewMissing = isRoot && !walk.truncated && !walk.beads.some(isDagReview) && walk.beads.some(bead => bead.issue_type === "task");
			statusIdsBySession.set(ctx.sessionManager.getSessionId(), beadIds(walk.beads));
			const todo = todoStrings(walk.beads);
			const shape = runShape(epic, walk.beads);
			// A truncated walk is not a basis for a wave: the epic tier's terminal check and the
			// two-tier task list both read the snapshot, so `ready` is withheld instead of guessed.
			const readyBeads = walk.truncated || dagReviewMissing ? [] : await readyWave(epic, walk.beads, root, capabilities);
			const ready = todoStrings(readyBeads);
			const wave = readyBeads.map(waveItem);
			// Everything that became ready since this session's previous status, so the lead can
			// dispatch on each child's result instead of waiting for the whole wave to drain.
			const fresh = newlyReady(ctx.sessionManager.getSessionId(), epic, readyBeads.map(bead => bead.id));
			const newly = todoStrings(readyBeads.filter(bead => fresh.has(bead.id)));
			const held = walk.beads.filter(bead => bead.status === "in_progress" && typeof bead.assignee === "string" && bead.assignee.length > 0).map(bead => {
				const worker = workerFor(ctx.sessionManager.getSessionId(), bead.id);
				const leaseExpires = typeof bead.lease_expires_at === "string" ? bead.lease_expires_at : undefined;
				return { bead: bead.id, holder: bead.assignee as string, ...(leaseExpires === undefined ? {} : { lease_expires_at: leaseExpires }), lease_expired: leaseExpires !== undefined && Date.parse(leaseExpires) <= Date.now(), ...(worker === undefined ? {} : { worker: { id: worker.id, status: worker.status, ...(worker.endedAt === undefined ? {} : { endedAt: new Date(worker.endedAt).toISOString() }) } }) };
			});
			statusWaveBySession.set(ctx.sessionManager.getSessionId(), new Map(wave.map(item => [item.bead, item])));
			const decisions: HeldTask[] = walk.beads.flatMap(bead => {
				const heldDecision = holdOf(bead);
				if (heldDecision === null || bead.status !== "blocked") return [];
				const metadata = metadataRecord(bead.metadata);
				return [{ bead: bead.id, title: typeof bead.title === "string" ? bead.title : "", tier: tierOf(metadata) ?? "basic", cause: heldDecision.cause, by: heldDecision.by, suggested: heldDecision.suggested, rounds: Number(metadata?.fix_round ?? 0), decided: typeof metadata?.decided === "string" && metadata.decided.length > 0 ? metadata.decided.split(",") : [] }];
			});
			const result: StatusResult = { run: epic, epic: epicBead, shape, ready, wave, newly_ready: newly, held, decisions, store, beads: walk.beads, todo };
			if (walk.truncated) {
				result.truncated = true;
				result.message = `subtree exceeds ${DESCENDANT_LIMIT} beads; ready is withheld. Orchestrate the child epics individually.`;
			} else if (dagReviewMissing) {
				result.message = `DAG review required before any implementation wave; ready is withheld. Create it, then call orc_status again: ${dagReviewCommand(epic)}`;
			}
			return text(
				result,
				`orc_status ${epic} (${epicBead.status ?? "?"}, ${shape}): ${walk.beads.length} beads, ${todo.length} open, ${ready.length} ready${newly.length > 0 ? `, ${newly.length} newly ready` : ""}${walk.truncated ? " (truncated)" : ""}${decisions.length > 0 ? `, ${decisions.length} held for your decision` : ""}${result.message === undefined ? "" : `\n${result.message}`}\nready:\n${ready.join("\n") || "(none)"}${newly.length > 0 ? `\nnewly ready (dispatch these now, do not wait for the wave):\n${newly.join("\n")}` : ""}\nheld:\n${held.map(entry => { const worker = entry.worker; const suffix = worker === undefined ? "no worker known to this session; verify with hub list/jobs before releasing" : worker.status === "started" ? `worker ${worker.id} running` : `its worker ${worker.id} ended ${worker.status} at ${worker.endedAt}; release with orc_release { bead, holder, reason }`; return `held ${entry.bead} by ${entry.holder} — ${suffix}`; }).join("\n") || "(none)"}${decisions.length > 0 ? `\ndecisions (orc_decide):\n${decisions.map(d => `${d.bead} ${d.title} [tier ${d.tier}, ${d.cause} by ${d.by}, rounds ${d.rounds}, suggested ${d.suggested}${d.decided.length > 0 ? `, decided ${d.decided.join(">")}` : ""}]`).join("\n")}` : ""}\ntodo:\n${todo.join("\n")}`,
			);
		},
	});
}
