/**
 * Review verdicts, the fix-round cap, and the lead's resourcing decisions.
 *
 * Tiers are static: a verdict never changes a bead's tier. A review bead finishes with a
 * verdict, never a bare `done`:
 * - `approve`: the criteria are met; the review bead closes.
 * - `fix`: a defect in the code (a bug, a failing test, an unhandled input). The reviewed
 *   tasks are reopened and unassigned with the findings on them, so the next wave dispatches
 *   the same implementer agent at the same tier.
 * - `change`: the work does not meet a stated requirement; `criteria` names which. Same
 *   mechanics as `fix`; the kind is recorded so the history shows what bounced.
 * - `escalate`: the reviewer judges that this tier cannot resolve it and names a `cause`
 *   (`design`, `contract`, `security`, `unbounded`). The task is HELD: blocked, unassigned,
 *   and listed under `orc_status.decisions` for the lead. Nothing is dispatched or created.
 *
 * `fix` and `change` count as rounds. After ROUND_CAP rounds at one tier the ledger holds the
 * task itself with cause `repeated`: it bounced, was fixed, and bounced again, which is the
 * history that suggests an upgrade. The suggestion is data; the lead decides.
 *
 * Only the lead moves a held task, through `orc_decide`: `retry` (same tier, another round),
 * `upgrade` (a fix bead one tier up, the original superseded), `split` (a planner bead that
 * decomposes it), `accept` (close as is, a follow-up bead for the residue), or `stop`
 * (park for the human; refused until an upgrade or split has been tried).
 *
 * A `dag-reviewer` bead is `approve` or `change`: anything but `approve` creates a planner
 * bead the review depends on, and the review re-enters after the revision closes.
 *
 * Every `bd` call goes through the injected runner so the plan is testable without a store.
 */

import { asBead, type BdBead, edgesOf, metadataRecord, parentOf } from "./bd";
import { tierOf } from "./dag";

export type Verdict = "approve" | "fix" | "change" | "escalate";
export type Tier = "basic" | "deep" | "max";
export type EscalateCause = "design" | "contract" | "security" | "unbounded";
/** Why a task is held: a reviewer's cause, or the ledger's own `repeated` after the round cap. */
export type HoldCause = EscalateCause | "repeated";
export type Decision = "retry" | "upgrade" | "split" | "accept" | "stop";

export const REVIEW_ROLES: Record<string, true> = { reviewer: true, "dag-reviewer": true };
export const ESCALATE_CAUSES: readonly EscalateCause[] = [
	"design",
	"contract",
	"security",
	"unbounded",
];
export const DECISIONS: readonly Decision[] = ["retry", "upgrade", "split", "accept", "stop"];

/** Same-tier rounds (`fix` or `change`) a task gets before the ledger holds it as `repeated`. */
export const ROUND_CAP = 2;

/** Longest findings text carried in bead metadata; the full text lives in the comment. */
const FINDINGS_LIMIT = 1500;

export function nextTier(tier: Tier): Tier | null {
	return tier === "basic" ? "deep" : tier === "deep" ? "max" : null;
}

/** The task beads a review bead depends on: its non-parent edges. */
export function reviewTargets(review: BdBead): string[] {
	return edgesOf(review)
		.filter((edge) => edge.type !== "parent-child")
		.map((edge) => edge.id);
}

export interface VerdictOutcome {
	verdict: Verdict;
	/** Tasks reopened for another same-tier round. */
	reopened: string[];
	/** Tasks held for the lead, with the cause. */
	held: Array<{ bead: string; cause: HoldCause }>;
	/** Tasks whose live foreign claim prevented reopening; the review waits on each task. */
	heldBy: Array<{ bead: string; holder: string }>;
	/** Planner beads created by a DAG `change`. The wave dispatches them. */
	planner: string[];
	/** One line for the tool result. */
	line: string;
}

export type BdRunner = (args: readonly string[]) => Promise<unknown>;

export type ReopenResult = { reopened: true; evidence?: string } | { reopened: false; holder: string };

export interface VerdictInput {
	review: BdBead;
	verdict: Verdict;
	reason: string;
	/** Findings text; recorded as a comment and, trimmed, in the fixed tasks' metadata. */
	findings: string;
	/** `change`: the numbered criteria that fail. */
	criteria?: number[];
	/** `escalate`: why this tier cannot resolve it. */
	cause?: EscalateCause;
	/** Explicit task targets; defaults to the review bead's task dependencies. */
	targets?: string[];
	show: (id: string) => Promise<BdBead>;
	bd: BdRunner;
	/** Ledger-owned reopener that may release a demonstrably stale foreign claim. */
	reopenTask?: (task: BdBead, reason: string, updateArgs: readonly string[]) => Promise<ReopenResult>;
}

async function createBead(
	bd: BdRunner,
	parent: string | undefined,
	title: string,
	description: string,
	metadata: Record<string, string>,
): Promise<string> {
	const created = await bd([
		"create",
		"--type",
		"task",
		...(parent === undefined ? [] : ["--parent", parent]),
		"--title",
		title,
		"--description",
		description,
		"--metadata",
		JSON.stringify(metadata),
		"--json",
	]);
	const bead = asBead(Array.isArray(created) ? created[0] : created);
	if (bead === null) throw new Error(`bd create returned no bead for "${title}"`);
	return bead.id;
}

function roleOf(bead: BdBead): string {
	const role = metadataRecord(bead.metadata)?.role;
	return typeof role === "string" ? role : "";
}

/** What a held task's metadata says, or `null` when it is not held. */
export function holdOf(bead: BdBead): { cause: HoldCause; by: string; suggested: Decision } | null {
	const metadata = metadataRecord(bead.metadata);
	const cause = metadata?.held;
	if (typeof cause !== "string" || cause.length === 0 || cause === "human") return null;
	const by = typeof metadata?.held_by === "string" ? metadata.held_by : "";
	const suggested = metadata?.held_suggested === "split" ? "split" : "upgrade";
	return { cause: cause as HoldCause, by, suggested };
}

/** Block a task for the lead and create an unparented gate bead that `bd ready` can surface. */
async function hold(
  bd: BdRunner,
  task: BdBead,
  review: string,
  cause: HoldCause,
  note: string,
): Promise<void> {
  const suggested: Decision = cause === "unbounded" || nextTier(tierOf(metadataRecord(task.metadata)) ?? "basic") === null ? "split" : "upgrade";
  const gate = await createBead(bd, undefined, `Gate: resolve ${task.id}`, `Resolve held bead ${task.id} after review ${review}.\n\n${note}`, { role: "gate", origin_bead: task.id, origin_review: review, cause });
  await bd(["comment", task.id, `held (${cause}) by ${review}: ${note}`]);
  await bd(["update", task.id, "--status", "blocked", "--assignee", "", "--set-metadata", `held=${cause}`, "--set-metadata", `held_by=${review}`, "--set-metadata", `held_suggested=${suggested}`, "--set-metadata", `held_findings=${note.slice(0, FINDINGS_LIMIT)}`, "--set-metadata", `gate_bead=${gate}`, "--json"]);
}

/** Apply a verdict to a review bead. Throws when the bead is not a review bead or the verdict is malformed. */
export async function applyVerdict(input: VerdictInput): Promise<VerdictOutcome> {
	const { review, verdict, reason, findings, bd, show } = input;
	const role = roleOf(review);
	if (REVIEW_ROLES[role] !== true)
		throw new Error(
			`orc_finish ${review.id}: a verdict applies to a review bead; this bead's role is ${role || "(none)"}`,
		);
	if (role === "dag-reviewer" && verdict !== "approve" && verdict !== "change")
		throw new Error(
			`orc_finish ${review.id}: a DAG review is approve or change; there is no local fix or escalation for a DAG`,
		);
	if (verdict === "escalate" && input.cause === undefined)
		throw new Error(
			`orc_finish ${review.id}: escalate needs a cause: ${ESCALATE_CAUSES.join(", ")}`,
		);
	if (
		verdict === "change" &&
		role !== "dag-reviewer" &&
		(input.criteria === undefined || input.criteria.length === 0)
	)
		throw new Error(
			`orc_finish ${review.id}: change names the criteria that fail (criteria: [n, ...]); a defect with no criterion is a fix`,
		);
	const outcome: VerdictOutcome = { verdict, reopened: [], held: [], heldBy: [], planner: [], line: "" };
	if (verdict === "approve") {
		await bd(["close", review.id, "--reason", reason, "--json"]);
		outcome.line = `orc_finish ${review.id}: approve, closed`;
		return outcome;
	}
	const note = findings.trim().length > 0 ? findings.trim() : reason;
	await bd([
		"comment",
		review.id,
		`${verdict}${input.cause === undefined ? "" : ` (${input.cause})`}: ${note}`,
	]);
	// The reviewer claimed this bead (in_progress, assigned). It must return to open and
	// unassigned, or `bd ready` would never surface it again once its dependencies close.
	await bd(["update", review.id, "--status", "open", "--assignee", "", "--json"]);
	const parent = parentOf(review);
	if (role === "dag-reviewer") {
		// Planner work is a bead the wave dispatches, not an instruction the lead may drop:
		// the review depends on it, so the review re-enters only after the revision closes.
		const revise = await createBead(
			bd,
			parent,
			"Revise the DAG",
			`The DAG review ${review.id} returned change.\n\nFindings:\n${note}\n\nRevise the beads under the run epic so every point holds, then finish this bead; the DAG review re-runs on the result.`,
			{ role: "planner", review: review.id },
		);
		await bd(["dep", "add", review.id, revise]);
		outcome.planner.push(revise);
		outcome.line = `orc_finish ${review.id}: change on the DAG; planner bead ${revise} created, the DAG review re-runs when it closes`;
		return outcome;
	}
	const targets =
		input.targets !== undefined && input.targets.length > 0 ? input.targets : reviewTargets(review);
	if (targets.length === 0)
		throw new Error(
			`orc_finish ${review.id}: ${verdict} needs a target task; the review bead has no task dependency and none was passed`,
		);
	const reopenEvidence: string[] = [];
	for (const id of targets) {
		const task = await show(id);
		const metadata = metadataRecord(task.metadata);
		if (verdict === "escalate") {
			await hold(bd, task, review.id, input.cause as EscalateCause, note);
			outcome.held.push({ bead: id, cause: input.cause as EscalateCause });
			continue;
		}
		// Rounds count per tier: a `retry` or `upgrade` decision resets them.
		const round = Number(metadata?.fix_round ?? 0) + 1;
		if (round > ROUND_CAP) {
			await hold(
				bd,
				task,
				review.id,
				"repeated",
				`round ${round} at tier ${tierOf(metadata)}: ${note}`,
			);
			outcome.held.push({ bead: id, cause: "repeated" });
			continue;
		}
		const reopenReason = `${verdict} requested by ${review.id}: ${reason}`;
		const criteria =
			input.criteria === undefined
				? []
				: ["--set-metadata", `fix_criteria=${input.criteria.join(",")}`];
		const phase = typeof metadata?.phase === "string" && metadata.phase.length > 0 ? metadata.phase : "";
		const updateArgs = [
			"update",
			id,
			"--assignee",
			phase,
			"--set-metadata",
			`fix_from=${review.id}`,
			"--set-metadata",
			`fix_kind=${verdict}`,
			"--set-metadata",
			`fix_round=${round}`,
			"--set-metadata",
			`fix_findings=${note.slice(0, FINDINGS_LIMIT)}`,
			...criteria,
			"--json",
		] as const;
		let reopened: ReopenResult;
		if (input.reopenTask === undefined) {
			await bd(["reopen", id, "--reason", reopenReason]);
			await bd(updateArgs);
			reopened = { reopened: true };
		} else {
			reopened = await input.reopenTask(task, reopenReason, updateArgs);
		}
		if (!reopened.reopened) {
			outcome.heldBy.push({ bead: id, holder: reopened.holder });
			continue;
		}
		outcome.reopened.push(id);
		if (reopened.evidence !== undefined) reopenEvidence.push(`${id}: ${reopened.evidence}`);
	}
	const parts: string[] = [];
	if (outcome.reopened.length > 0)
		parts.push(`reopened ${outcome.reopened.join(", ")} for the same implementer at the same tier`);
	if (reopenEvidence.length > 0) parts.push(reopenEvidence.join("; "));
	if (outcome.heldBy.length > 0)
		parts.push(
			`held ${outcome.heldBy.map(h => `${h.bead} by ${h.holder}`).join(", ")}; the live holder was not stolen and the review re-enters when it closes`,
		);
	if (outcome.held.length > 0)
		parts.push(
			`held ${outcome.held.map((h) => `${h.bead} (${h.cause})`).join(", ")} for the lead: orc_status lists them under decisions`,
		);
	outcome.line = `orc_finish ${review.id}: ${verdict}; ${parts.join("; ")}; the review bead stays open and re-enters when its tasks close`;
	return outcome;
}

export interface DecisionInput {
	task: BdBead;
	action: Decision;
	reason: string;
	bd: BdRunner;
}

export interface DecisionOutcome {
	action: Decision;
	/** Beads created by the decision: the fix bead of an upgrade, the planner bead of a split, the follow-up of an accept. */
	created: string[];
	line: string;
}

/** Reviews that depend on `task`: the review beads to re-point at a superseding bead. */
async function reviewsOf(bd: BdRunner, task: BdBead, singleTarget = false): Promise<string[]> {
	const raw = await bd(["list", "--all", "--json"]);
	const beads = (Array.isArray(raw) ? raw : [raw])
		.map(asBead)
		.filter((b): b is BdBead => b !== null);
	return beads
		.filter(
			(b) =>
				REVIEW_ROLES[roleOf(b)] === true &&
				edgesOf(b).some((e) => e.type !== "parent-child" && e.id === task.id) &&
				(!singleTarget || reviewTargets(b).length === 1),
		)
		.map((b) => b.id);
}

/**
 * Apply the lead's decision to a held task. The caller has already checked that the actor is
 * the run's lead and the task belongs to the run. Throws when the task is not held or the
 * action is not available to it.
 */
export async function applyDecision(input: DecisionInput): Promise<DecisionOutcome> {
	const { task, action, reason, bd } = input;
	const metadata = metadataRecord(task.metadata);
	const held = holdOf(task);
	if (held === null)
		throw new Error(
			`orc_decide ${task.id}: the task is not held; decisions apply to beads orc_status lists under decisions`,
		);
	const decided =
		typeof metadata?.decided === "string" && metadata.decided.length > 0
			? metadata.decided.split(",")
			: [];
	const tier = tierOf(metadata) ?? "basic";
	const title = typeof task.title === "string" ? task.title : task.id;
	const parent = parentOf(task);
	const findings = typeof metadata?.held_findings === "string" ? metadata.held_findings : "";
	const outcome: DecisionOutcome = { action, created: [], line: "" };
	const clearHold = [
		"--set-metadata",
		"held=",
		"--set-metadata",
		"held_by=",
		"--set-metadata",
		"held_suggested=",
		"--set-metadata",
		`decided=${[...decided, action].join(",")}`,
	];
	await bd(["comment", task.id, `decision ${action} by the lead: ${reason}`]);
	switch (action) {
		case "retry": {
			await bd(["reopen", task.id, "--reason", `retry decided by the lead: ${reason}`]);
			await bd([
				"update",
				task.id,
				"--assignee",
				"",
				"--set-metadata",
				"fix_round=0",
				"--set-metadata",
				`fix_from=${held.by}`,
				"--set-metadata",
				`fix_findings=${findings.slice(0, FINDINGS_LIMIT)}`,
				...clearHold,
				"--json",
			]);
			outcome.line = `orc_decide ${task.id}: retry at tier ${tier}; the task is ready again with the findings`;
			return outcome;
		}
		case "upgrade": {
			const up = nextTier(tier);
			if (up === null)
				throw new Error(`orc_decide ${task.id}: no tier above max; split it instead`);
			const fix = await createBead(
				bd,
				parent,
				`Fix: ${title}`,
				`${task.id} (${title}) was held (${held.cause}) by ${held.by} at tier ${tier}; the lead upgraded it.\n\nFindings:\n${findings}\n\nThe original scope and acceptance criteria of ${task.id} apply; every criterion is re-verified by the same review bead.`,
				{
					role: "implementer",
					tier: up,
					escalated_from: task.id,
					review: held.by,
					decided: [...decided, action].join(","),
				},
			);
			for (const review of await reviewsOf(bd, task)) await bd(["dep", "add", review, fix]);
			await bd(["update", task.id, ...clearHold, "--json"]);
			await bd([
				"close",
				task.id,
				"--reason",
				`superseded by ${fix} at tier ${up}: ${reason}`,
				"--json",
			]);
			outcome.created.push(fix);
			outcome.line = `orc_decide ${task.id}: upgraded; fix bead ${fix} at tier ${up}, the review re-enters when it closes`;
			return outcome;
		}
		case "split": {
			const decompose = await createBead(
				bd,
				parent,
				`Decompose: ${title}`,
				`${task.id} (${title}) was held (${held.cause}) by ${held.by}; the lead chose to split it.\n\nFindings:\n${findings}\n\nSplit it into bounded task beads under the same parent, each with files, verifiable criteria, a tier, and metadata decided=${[...decided, action].join(",")} so the history follows the parts; make ${held.by} depend on each; then finish this bead.`,
				{
					role: "planner",
					review: held.by,
					decomposes: task.id,
					decided: [...decided, action].join(","),
				},
			);
			for (const review of await reviewsOf(bd, task)) await bd(["dep", "add", review, decompose]);
			await bd(["update", task.id, ...clearHold, "--json"]);
			await bd([
				"close",
				task.id,
				"--reason",
				`superseded by decomposition ${decompose}: ${reason}`,
				"--json",
			]);
			outcome.created.push(decompose);
			outcome.line = `orc_decide ${task.id}: split; planner bead ${decompose}, the review re-enters when the parts close`;
			return outcome;
		}
		case "accept": {
			// Only a hold that says nothing against the work as it stands may be accepted: rounds
			// exhausted, or a bead that cannot be met as written. A design, contract, or security
			// cause names a blocker; the lead upgrades or splits it.
			if (held.cause !== "repeated" && held.cause !== "unbounded") throw new Error(`orc_decide ${task.id}: a ${held.cause} hold is never accepted as residue; retry, upgrade, or split it`);
			const follow = await createBead(
				bd,
				parent,
				`Follow-up: ${title}`,
				`Residue the lead accepted on ${task.id} (${title}): ${reason}\n\nFindings:\n${findings}`,
				{ role: "implementer", tier: "basic", follow_up_of: task.id },
			);
			await bd(["update", task.id, ...clearHold, "--json"]);
			await bd(["close", task.id, "--reason", `accepted by the lead: ${reason}`, "--json"]);
			for (const review of await reviewsOf(bd, task, true))
				await bd([
					"close",
					review,
					"--reason",
					`accepted by the lead on ${task.id}: ${reason}`,
					"--json",
				]);
			outcome.created.push(follow);
			outcome.line = `orc_decide ${task.id}: accepted and closed with follow-up ${follow}; its reviews are closed`;
			return outcome;
		}
		case "stop": {
			if (!decided.includes("upgrade") && !decided.includes("split"))
				throw new Error(
					`orc_decide ${task.id}: stop is the last resort; upgrade or split it first (decisions so far: ${decided.join(", ") || "none"})`,
				);
			await bd([
				"update",
				task.id,
				"--set-metadata",
				"held=human",
				"--set-metadata",
				`decided=${[...decided, action].join(",")}`,
				"--json",
			]);
			outcome.line = `orc_decide ${task.id}: stopped for the human; report it and end the turn`;
			return outcome;
		}
	}
}

/** Title and brief of the DAG-review bead `orc_status` creates once per run. */
export const DAG_REVIEW_TITLE = "Review the DAG";
export const DAG_REVIEW_DESCRIPTION = [
	"Judge the run's DAG before any implementation wave, against the planner guard-rails:",
	"1. Every task is bounded: files or symbols named, acceptance criteria an independent reviewer can verify, no design decision left to the implementer.",
	"2. No design decision hides inside a task; such work is a `decision` or research bead that the dependent tasks wait on.",
	"3. Every review bead depends on the tasks it reviews; a review that spans the wave depends on all of them.",
	"4. Dependencies exist only for true ordering; independent work is not chained.",
	"5. Each implementer bead carries `metadata.tier`, and the mark is justified by the bead's text: `basic` for mechanical, fully specified work; `deep` when the bead states an invariant (all-or-nothing, idempotent, never mutates, order-independent), defines error semantics, or is a contract other beads consume; `max` only when wrong is irreversible, the contract is shared across epics, or it is a security surface, and the description says which. Reject an unjustified `max`; tiers do not change after this review.",
	"6. A contract several epics share is recorded as a decision before those epics start.",
	"Verdict: `approve` when every point holds; otherwise `change` with the failing point and bead ids, and the lead dispatches orc-planner with your findings.",
].join("\n");

/** The exact `bd create` for the run's DAG review, returned by `orc_status` while it is missing. */
export function dagReviewCommand(epic: string): string {
	const q = (s: string) => `'${s.replace(/'/gu, "'\\''")}'`;
	return `bd create --type task --parent ${epic} --title ${q(DAG_REVIEW_TITLE)} --description ${q(DAG_REVIEW_DESCRIPTION)} --metadata ${q(JSON.stringify({ role: "dag-reviewer" }))}`;
}

/** `true` when a bead is the run's DAG review (open or closed). */
export function isDagReview(bead: BdBead): boolean {
	return roleOf(bead) === "dag-reviewer";
}
