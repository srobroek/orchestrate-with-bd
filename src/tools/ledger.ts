import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { bdCapabilities, type BdBead, type BdCapabilities, bdJson, bdShow, isGuardMismatch, metadataRecord, parentOf } from "../bd";
import { beadIds, DESCENDANT_LIMIT, descendants, readStoreMode, readyWave, runShape, tierOf, todoStrings, type WaveItem, waveItem } from "../dag";
import { applyDecision, applyVerdict, dagReviewCommand, type Decision, type DecisionOutcome, type HoldCause, holdOf, isDagReview, type ReopenResult, REVIEW_ROLES, type Tier, type Verdict, type VerdictOutcome } from "../verdict";
import { readLocator, validateLocator, writeLocator } from "../run";
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
 * Why the ledger refuses to write at `root`, or `null` when the store is in server mode.
 * Computed per call from the file alone (never from a `bd` call): subagents share one
 * process, so a session-level flag would let one session's checkout gate another's.
 */
export function storeRefusal(root: string): string | null {
	const store = readStoreMode(root);
	if (store === null) return `${NO_STORE} (looked for ${path.join(root, ".beads", "metadata.json")})`;
	return store.mode === "server" ? null : NOT_SERVER_MODE;
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

export interface ClaimResult {
	claimed: boolean;
	bead?: BdBead;
	lease_expires_at?: string;
	reason?: string;
}

export interface BindResult {
	run: string | null;
	root: string;
	epic?: BdBead;
	message?: string;
}

export interface FinishResult {
	state: "done" | "blocked";
	bead: string;
	/** Present when the bead is a review bead: what the verdict did. */
	verdict?: VerdictOutcome;
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
	/** The same wave, one entry per `ready` item, with the agent and isolation each bead is routed to. */
	wave?: WaveItem[];
	/** Claimed descendants with native lease state when the client supports it. */
	held?: Array<{ bead: string; holder: string; lease_expires_at?: string; lease_expired: boolean; worker?: { id: string; status: string; endedAt?: string } }>;
	/** Tasks held for the lead; each is moved only by `orc_decide`. */
	decisions?: HeldTask[];
	store: string;
	beads: BdBead[];
	todo: string[];
	truncated?: true;
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

function text<T>(details: T, line: string, isError = false): AgentToolResult<T> {
	return { content: [{ type: "text", text: line }], details, isError };
}

function refused<T>(reason: string): AgentToolResult<T> {
	return { content: [{ type: "text", text: reason }], details: undefined as T, isError: true };
}

/**
 * Returned by every ledger tool while the store is not in server mode. The ledger is closed
 * in every session: an in-session migration is a separate, gated job the run header admits
 * or refuses, and it creates no bead and dispatches nothing.
 */
export const NOT_SERVER_MODE =
	'Beads store is not in server mode; native isolation forks an embedded store. STOP: no bead, claim, or dispatch is possible here, in this session or any other. Migrating in this checkout is gated: only a run header that reports every migration gate met opens it, and that header lists the bounded commands; otherwise report the route to the human and end the turn. The route is: bd export > issues.jsonl; bd backup init <dir> && bd backup sync; bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix <prefix>; set dolt_mode to "server" in .beads/metadata.json and add dolt.shared-server: true to .beads/config.yaml; bd backup restore --force <dir>; bd migrate --force then bd dolt push for pending schema migrations';

/** Returned when the checkout has no readable `.beads/metadata.json`; unknown is not server mode. */
export const NO_STORE =
	"No Beads store here: .beads/metadata.json is missing or unreadable. Run `bd init --shared-server --skip-hooks` for a new project or `bd bootstrap` for a clone";

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
/** Read the exact queue aliases configured by Beads; an unreadable setting admits none. */
async function claimPools(cwd: string, env: Record<string, string>): Promise<Set<string> | null> {
	try {
		const raw = await bdJson(["config", "get", "claim.pools", "--json"], cwd, env);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
		const value = (raw as Record<string, unknown>).value;
		if (typeof value !== "string") return null;
		return new Set(value.split(",").map(alias => alias.trim()).filter(alias => alias.length > 0));
	} catch {
		return null;
	}
}


function phaseOf(bead: BdBead): string {
	const phase = metadataRecord(bead.metadata)?.phase;
	return typeof phase === "string" && phase.length > 0 ? phase : "";
}

function guardedUpdate(updateArgs: readonly string[], assignee: string, status: string): readonly string[] {
	const guards = ["--if-assignee", assignee, "--if-status", status];
	return [...updateArgs.slice(0, 2), ...guards, "--status", "open", ...updateArgs.slice(2)];
}

/** Reopen a reviewed task without stealing a live claim; stale claims are released atomically into their phase queue. */
async function reopenVerdictTask(
	task: BdBead,
	reason: string,
	updateArgs: readonly string[],
	ctx: ExtensionContext,
	env: Record<string, string>,
	capabilities: BdCapabilities,
): Promise<ReopenResult> {
	const holder = typeof task.assignee === "string" && task.assignee.length > 0 ? task.assignee : undefined;
	const phase = phaseOf(task);
	const worker = workerFor(ctx.sessionManager.getSessionId(), task.id);
	if (task.status === undefined || (task.status === "open" && holder === undefined)) {
		await bdJson(["reopen", task.id, "--reason", reason], ctx.cwd, env);
		await bdJson(updateArgs, ctx.cwd, env);
		return { reopened: true };
	}
	if (task.status === "in_progress" && holder !== undefined) {
		if (worker?.status === "started") return { reopened: false, holder };
		if (worker !== undefined) {
			try {
				await bdJson(guardedUpdate(updateArgs, holder, "in_progress"), ctx.cwd, env);
				return { reopened: true, evidence: `worker ${worker.id} ended (${worker.status}); restored phase ${phase || "(unassigned)"}` };
			} catch (error) {
				if (!isGuardMismatch(error)) throw error;
				const current = await bdShow(task.id, ctx.cwd, env);
				return { reopened: false, holder: current.assignee ?? "(unassigned)" };
			}
		}
		if (capabilities.leases) {
			const reclaimed = await bdJson(["reclaim", "--id", task.id, "--older-than", "0s", "--json"], ctx.cwd, env);
			if (reclaimedCount(reclaimed) === 1) {
				try {
					await bdJson(guardedUpdate(updateArgs, "", "open"), ctx.cwd, env);
					return { reopened: true, evidence: `expired lease reclaimed; restored phase ${phase || "(unassigned)"}` };
				} catch (error) {
					if (!isGuardMismatch(error)) throw error;
					const current = await bdShow(task.id, ctx.cwd, env);
					return { reopened: false, holder: current.assignee ?? "(unassigned)" };
				}
			}
		}
		const current = await bdShow(task.id, ctx.cwd, env);
		return { reopened: false, holder: current.assignee ?? "(unassigned)" };
	}
	if (task.status === "open" && holder !== undefined) return { reopened: false, holder };
	await bdJson(["reopen", task.id, "--reason", reason], ctx.cwd, env);
	try {
		await bdJson(guardedUpdate(updateArgs, holder ?? "", "open"), ctx.cwd, env);
		return { reopened: true };
	} catch (error) {
		if (!isGuardMismatch(error)) throw error;
		const current = await bdShow(task.id, ctx.cwd, env);
		return { reopened: false, holder: current.assignee ?? "(unassigned)" };
	}
}

export function registerLedger(pi: ExtensionAPI): void {
	const z = pi.zod;
	// Named consts, not inline `z.object(...)` arguments: inlined, the generic no longer
	// infers and `input` degrades to `unknown`.
	const claimParams = z.object({ bead: z.string().describe("bead id to claim") });
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
		description: "Release a held bead after worker-ended, own, or explicit force evidence.",
		approval: "write",
		parameters: releaseParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<ReleaseResult | undefined>> {
			const refusal = storeRefusal(ctx.cwd);
			if (refusal !== null) return refused(refusal);
			const actor = actorFor(ctx);
			const env = { BEADS_ACTOR: actor };
			const capabilities = await bdCapabilities(ctx.cwd);
			try {
				const before = await bdShow(input.bead, ctx.cwd, env);
				if (before.status === "closed") return text({ released: false, reason: "closed" }, `orc_release ${input.bead}: closed`);
				if (!before.assignee) return text({ released: true, reason: "already unassigned" }, `orc_release ${input.bead}: already unassigned`);
				if (before.assignee !== input.holder) return text({ released: false, reason: `holder changed: now ${before.assignee ?? "(unassigned)"}` }, `orc_release ${input.bead}: holder changed: now ${before.assignee ?? "(unassigned)"}`, true);
				const worker = workerFor(ctx.sessionManager.getSessionId(), input.bead);
				if (worker?.status === "started") return refused(`worker ${worker.id} dispatched by this session is still running; hub cancel it or wait`);
				const tier: ReleaseResult["tier"] = worker && worker.status !== "started" ? (`worker-ended:${worker.status}` as ReleaseResult["tier"]) : before.assignee === actor ? "own" : input.force === true ? "forced" : undefined;
				if (tier === undefined && capabilities.leases) {
					const reclaimed = await bdJson(["reclaim", "--id", input.bead, "--older-than", "0s", "--json"], ctx.cwd, env);
					if (reclaimedCount(reclaimed) === 1) {
						stopHeartbeat(ctx.sessionManager.getSessionId(), ctx.cwd, input.bead);
						const after = await bdShow(input.bead, ctx.cwd, env);
						return text({ released: true, tier: "reclaimed", bead: after }, `orc_release ${input.bead}: released (reclaimed)`);
					}
				}
				if (tier === undefined) return refused(`no liveness evidence for ${input.holder}: this session did not dispatch a worker for ${input.bead}. Confirm with hub list/jobs that no agent is working it, then call again with force: true.`);
				const unclaim = ["unclaim", input.bead, "--reason", `release (${tier}): ${input.reason} — by ${actor}`];
				if (input.force === true && before.assignee !== actor) unclaim.push("--force");
				else unclaim.push("--if-assignee", input.holder);
				try {
					await bdJson([...unclaim, "--json"], ctx.cwd, env);
				} catch (error) {
					const current = await bdShow(input.bead, ctx.cwd, env);
					if (current.assignee !== undefined && current.assignee !== input.holder) return text({ released: false, bead: current, reason: `holder changed: now ${current.assignee}` }, `orc_release ${input.bead}: holder changed: now ${current.assignee}`, true);
					throw error;
				}
				stopHeartbeat(ctx.sessionManager.getSessionId(), ctx.cwd, input.bead);
				const after = await bdShow(input.bead, ctx.cwd, env);
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
		description: "Claim one Beads task for this agent. On bd 1.3+, compare-and-set guards make the open/unassigned transition atomic and the native lease is heartbeated while this session lives; older clients use the existing claim and readback path.",
		approval: "write",
		parameters: claimParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<ClaimResult | undefined>> {
			const refusal = storeRefusal(ctx.cwd);
			if (refusal !== null) return refused(refusal);
			const bead = input.bead.trim();
			const actor = actorFor(ctx);
			const env = { BEADS_ACTOR: actor };
			const capabilities = await bdCapabilities(ctx.cwd);
			let claimError: string | undefined;
			try {
				if (capabilities.cas) {
					await bdJson(["update", bead, "--assignee", actor, "--status", "in_progress", "--if-assignee", "", "--if-status", "open", "--json"], ctx.cwd, env);
				} else {
					await bdJson(["update", bead, "--claim", "--json"], ctx.cwd, env);
				}
			} catch (error: unknown) {
				if (capabilities.cas && !isGuardMismatch(error)) throw error;
				claimError = error instanceof Error ? error.message : String(error);
			}
			const observed = await bdShow(bead, ctx.cwd, env);
			if (observed.assignee !== actor) {
				const holder = observed.assignee ?? "(unassigned)";
				const reason = claimError === undefined ? `held by ${holder}` : `held by ${holder}; ${claimError}`;
				return text<ClaimResult>({ claimed: false, bead: observed, reason }, `orc_claim ${bead}: not claimed, ${reason}`);
			}
			if (capabilities.leases) {
				try {
					await startHeartbeat(ctx.sessionManager.getSessionId(), ctx.cwd, actor, bead);
				} catch {
					stopHeartbeat(ctx.sessionManager.getSessionId(), ctx.cwd, bead);
				}
			}
			return text<ClaimResult>({ claimed: true, bead: observed, lease_expires_at: observed.lease_expires_at }, `orc_claim ${bead}: claimed by ${actor}${observed.lease_expires_at === undefined ? "" : `; lease expires ${observed.lease_expires_at}`}`);
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
			const refusal = storeRefusal(ctx.cwd);
			if (refusal !== null) return refused(refusal);
			const bead = input.bead.trim();
			const env = { BEADS_ACTOR: actorFor(ctx) };
			if (input.comment !== undefined && input.comment.trim().length > 0) {
				await bdJson(["comment", bead, input.comment], ctx.cwd, env);
			}
			if (input.state === "done") {
				// An epic closes only when its subtree is terminal. Observed 2026-09-14: an epic
				// lead closed its epic with two review beads still open, and the root had to reopen
				// it and dispatch a recovery lead.
				const current = await bdShow(bead, ctx.cwd, env);
				const role = metadataRecord(current.metadata)?.role;
				if (typeof role === "string" && REVIEW_ROLES[role] === true) {
					// A review finishes with a verdict, never a bare close: the verdict is what
					// routes the next wave (same implementer, or the lead's decision).
					if (input.verdict === undefined) {
						return text<FinishResult>({ state: "done", bead }, `orc_finish ${bead}: refused, a review bead finishes with a verdict (approve, fix, change, or escalate)`, true);
					}
					let outcome: VerdictOutcome;
					try {
						const capabilities = input.verdict === "approve" ? undefined : await bdCapabilities(ctx.cwd);
						outcome = await applyVerdict({
							review: current,
							verdict: input.verdict as Verdict,
							reason: input.reason,
							findings: input.comment ?? "",
							criteria: input.criteria,
							cause: input.cause,
							targets: input.targets,
							show: id => bdShow(id, ctx.cwd, env),
							bd: args => bdJson(args, ctx.cwd, env),
							reopenTask:
								capabilities === undefined
									? undefined
									: (task, reason, updateArgs) => reopenVerdictTask(task, reason, updateArgs, ctx, env, capabilities),
						});
					} catch (error) {
						return text<FinishResult>({ state: "done", bead }, error instanceof Error ? error.message : String(error), true);
					}
					stopHeartbeat(ctx.sessionManager.getSessionId(), ctx.cwd, bead);
					return text<FinishResult>({ state: "done", bead, verdict: outcome }, outcome.line);
				}
				if (input.verdict !== undefined) {
					return text<FinishResult>({ state: "done", bead }, `orc_finish ${bead}: refused, a verdict applies to a review bead; this bead's role is ${typeof role === "string" && role.length > 0 ? role : "(none)"}`, true);
				}
				if (current.issue_type === "epic") {
					const walk = await descendants(bead, ctx.cwd);
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
				await bdJson(["close", bead, "--reason", input.reason, "--json"], ctx.cwd, env);
			} else {
				// `bd update` still has no `--reason` (bd 1.3.0), so the reason is recorded as a
				// comment first; the transition follows only once that write has landed.
				await bdJson(["comment", bead, `blocked: ${input.reason}`], ctx.cwd, env);
				await bdJson(["update", bead, "--status", "blocked", "--json"], ctx.cwd, env);
			}
			stopHeartbeat(ctx.sessionManager.getSessionId(), ctx.cwd, bead);
			return text<FinishResult>({ state: input.state, bead }, `orc_finish ${bead}: ${input.state}`);
		},
	});

	pi.registerTool({
		name: "orc_bind",
		label: "Bind run",
		description:
			"Bind this checkout to a run epic: claims an unassigned epic or takes one from Beads' configured queue aliases for this lead's actor (the atomic assignee is the ownership record, so two leads cannot bind one epic) and writes `.orchestration/.active-run`. An isolated clone inherits the root's locator; a sub-lead binds a child epic of that run, which rebinds the clone to the child and keeps the run root. Any other epic is a different run and is refused. Idempotent for the bound epic. Call it once, before `orc_status`.",
		approval: "write",
		parameters: bindParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<BindResult | undefined>> {
			const refusal = storeRefusal(ctx.cwd);
			if (refusal !== null) return refused(refusal);
			const root = ctx.cwd;
			const epic = input.epic.trim();
			const actor = actorFor(ctx);
			const env = { BEADS_ACTOR: actor };
			const locator = readLocator(root);
			const validation = await validateLocator(root, actor);
			let rootId = epic;
			if (locator !== null && validation.state === "valid" && locator.run_id !== epic) {
				if (!(await isDescendant(epic, locator.root_id, root))) {
					const message = `run already bound to ${locator.run_id}; a clone rebinds only to a child epic of its run (root ${locator.root_id}); remove .orchestration/.active-run to start another run`;
					return text<BindResult>({ run: locator.run_id, root: locator.root_id, message }, message, true);
				}
				rootId = locator.root_id;
			} else if (locator !== null && validation.state === "valid") {
				rootId = locator.root_id;
			}
			// The epic must exist before anything is bound: `bd list --parent <typo>` exits 0
			// with `[]`, which would otherwise persist a typo as an empty successful run.
			let epicBead = await bdShow(epic, root, env);
			if (epicBead.issue_type !== "epic") {
				const message = `${epic} is a ${epicBead.issue_type ?? "bead of unknown type"}, not an epic; a run binds an epic`;
				return text<BindResult>({ run: null, root: rootId, message }, message, true);
			}
			const assignee = epicBead.assignee;
			let claimable = !assignee;
			if (assignee) claimable = (await claimPools(root, env))?.has(assignee) === true;
			if (claimable) await bdJson(["update", epic, "--claim", "--json"], root, env).catch(() => undefined);
			epicBead = await bdShow(epic, root, env);
			if (epicBead.assignee !== actor) {
				const holder = epicBead.assignee ?? "(unassigned)";
				const message = `epic ${epic} is held by ${holder}; a lead binds only the epic it claims`;
				return text<BindResult>({ run: null, root: rootId, message }, message, true);
			}
			writeLocator(root, epic, rootId);
			return text<BindResult>({ run: epic, root: rootId, epic: epicBead }, `orc_bind ${epic}: bound (run root ${rootId}, actor ${actor})`);
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
			const refusal = storeRefusal(ctx.cwd);
			if (refusal !== null) return refused(refusal);
			const root = ctx.cwd;
			const locator = readLocator(root);
			if (locator === null) return refused("orc_decide: no run bound; call orc_bind { epic } first");
			const actor = actorFor(ctx);
			const env = { BEADS_ACTOR: actor };
			const epicBead = await bdShow(locator.run_id, root, env);
			if (epicBead.assignee !== actor) {
				return refused(`orc_decide: only the lead holding ${locator.run_id} decides; it is held by ${epicBead.assignee ?? "(unassigned)"} and you are ${actor}`);
			}
			const bead = input.bead.trim();
			if (!(await isDescendant(bead, locator.run_id, root))) return refused(`orc_decide ${bead}: not under the bound run ${locator.run_id}`);
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
			"Read the bound run's whole subtree from Beads; this tool writes nothing, bind first with `orc_bind`. `ready` is the wave and one `task` call dispatches all of it; `wave` gives each item's `agent` and `isolated`, which the `task` call copies (implementer tier from the bead's `metadata.tier`): unblocked, unassigned tasks under the epic (two-tier), or the child epics that are unblocked, not yet bound by a lead, and hold at least one ready task, one `orc-lead` each (three-tier). `todo` holds `<bead-id> <title>` for every open or in-progress bead and is the only legitimate source of todo items. `shape` is `three-tier` when a direct child of the epic is an epic (dispatch one `orc-lead` per child epic) and `two-tier` otherwise. `epic`, when passed, must be the bound run.",
		approval: "read",
		parameters: statusParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<StatusResult | undefined>> {
			const refusal = storeRefusal(ctx.cwd);
			if (refusal !== null) return refused(refusal);
			const root = ctx.cwd;
			const mode = readStoreMode(root);
			const store = mode === null ? "no .beads/metadata.json" : `${mode.database ?? "?"} (${mode.mode || "?"})`;
			const locator = readLocator(root);
			const requested = input.epic?.trim() || undefined;
			if (locator === null) {
				const message = requested === undefined ? "no run bound; call orc_bind { epic } first" : `no run bound; call orc_bind { epic: "${requested}" } first`;
				return text<StatusResult>({ run: null, store, beads: [], todo: [], message }, message, true);
			}
			if (requested !== undefined && requested !== locator.run_id) {
				const message = `run is bound to ${locator.run_id}; call orc_status without epic, or orc_bind { epic: "${requested}" } to rebind a child epic`;
				return text<StatusResult>({ run: locator.run_id, store, beads: [], todo: [], message }, message, true);
			}
			const validation = await validateLocator(root, actorFor(ctx));
			if (validation.state === "stale") {
				clearStatusWave(ctx);
				const message = `stale run locator for ${validation.locator.run_id}: ${validation.reason}; call orc_bind before reading status`;
				return text<StatusResult>({ run: validation.locator.run_id, store, beads: [], todo: [], message }, message, true);
			}
			const epic = locator.run_id;
			const capabilities = await bdCapabilities(root);
			const epicBead = await bdShow(epic, root, {}, capabilities.briefDeps ? ["--brief-deps"] : []);
			const walk = await descendants(epic, root, capabilities);
			// One DAG review per run gates every implementation wave (see readyWave). This tool
			// reads; it does not create the bead. When the root's tree has tasks but no review
			// bead, the wave is withheld and the exact create command is returned. A sub-lead's
			// epic is a descendant of the run root, so it needs none.
			const isRoot = locator.root_id === epic;
			const dagReviewMissing = isRoot && !walk.truncated && !walk.beads.some(isDagReview) && walk.beads.some(bead => bead.issue_type === "task");
			statusIdsBySession.set(ctx.sessionManager.getSessionId(), beadIds(walk.beads));
			const todo = todoStrings(walk.beads);
			const shape = runShape(epic, walk.beads);
			// A truncated walk is not a basis for a wave: the epic tier's terminal check and the
			// two-tier task list both read the snapshot, so `ready` is withheld instead of guessed.
			const readyBeads = walk.truncated || dagReviewMissing ? [] : await readyWave(epic, walk.beads, root, capabilities);
			const ready = todoStrings(readyBeads);
			const wave = readyBeads.map(waveItem);
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
			const result: StatusResult = { run: epic, epic: epicBead, shape, ready, wave, held, decisions, store, beads: walk.beads, todo };
			if (walk.truncated) {
				result.truncated = true;
				result.message = `subtree exceeds ${DESCENDANT_LIMIT} beads; ready is withheld. Orchestrate the child epics individually.`;
			} else if (dagReviewMissing) {
				result.message = `DAG review required before any implementation wave; ready is withheld. Create it, then call orc_status again: ${dagReviewCommand(epic)}`;
			}
			return text(
				result,
				`orc_status ${epic} (${epicBead.status ?? "?"}, ${shape}): ${walk.beads.length} beads, ${todo.length} open, ${ready.length} ready${walk.truncated ? " (truncated)" : ""}${decisions.length > 0 ? `, ${decisions.length} held for your decision` : ""}${result.message === undefined ? "" : `\n${result.message}`}\nready:\n${ready.join("\n") || "(none)"}\nheld:\n${held.map(entry => { const worker = entry.worker; const suffix = worker === undefined ? "no worker known to this session; verify with hub list/jobs before releasing" : worker.status === "started" ? `worker ${worker.id} running` : `its worker ${worker.id} ended ${worker.status} at ${worker.endedAt}; release with orc_release { bead, holder, reason }`; return `held ${entry.bead} by ${entry.holder} — ${suffix}`; }).join("\n") || "(none)"}${decisions.length > 0 ? `\ndecisions (orc_decide):\n${decisions.map(d => `${d.bead} ${d.title} [tier ${d.tier}, ${d.cause} by ${d.by}, rounds ${d.rounds}, suggested ${d.suggested}${d.decided.length > 0 ? `, decided ${d.decided.join(">")}` : ""}]`).join("\n")}` : ""}\ntodo:\n${todo.join("\n")}`,
			);
		},
	});
}
