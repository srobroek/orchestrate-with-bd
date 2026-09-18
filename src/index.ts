/**
 * orchestrate-with-bd — a durable Beads ledger beside OMP's native `orchestrate` keyword.
 *
 * OMP owns scheduling, agent lifecycle, and cancellation; every agent works in its own
 * Worktrunk git worktree rather than the canonical checkout. This plugin owns three things:
 * the per-session actor every `bd` mutation is attributed to, a run header injected when a
 * prompt says `orchestrate`, and the ledger tools (`orc_claim`, `orc_finish`, `orc_status`)
 * that make Beads the source of truth for what work exists and what state it is in. Four
 * review-bot tools ride along untouched.
 *
 * The plugin does not schedule workers or discover stores. On clients that expose native Beads
 * leases it keeps claims alive and offers reclaim through the ledger; older clients retain the
 * existing claim/readback and explicit-release behaviour.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readStoreMode, type WaveItem } from "./dag";
import { mentionsOrchestrate } from "./keyword";
import { missingRoles, rolesStop } from "./roles";
import { validateLocator } from "./run";
import { registerBotReviewProbe } from "./tools/bot-review-probe";
import { registerBotReviewRequest } from "./tools/bot-review-request";
import { namedBeads, observeLifecycle, recordDispatch, waveGate } from "./dispatch";
import { registerConflictProbe } from "./tools/conflict-probe";
import { actorFor, clearStatusWave, registerLedger, statusBeadIds, statusWave } from "./tools/ledger";
import { registerReviewRoundPolicy } from "./tools/review-round-policy";
const CONTRACT = [
	"- Read `skill://orchestrate-with-bd` before dispatching.",
	"- Beads is the only source of truth for what work exists and what state it is in. The todo list is a per-turn view of `orc_status`, never an independent plan: every item is `<bead-id> <title>` copied from `orc_status.todo`, never invented. On any disagreement, re-read `orc_status` and rewrite the list from it. `orc_finish` makes progress real; `todo done` only redraws the view.",
	"- In plan mode, the plan must name the epic and every task bead it implements in a `## Beads` section. A step with no bead is not planned work: create the bead first.",
	"- Dispatch every worker through the native `task` tool. Never start a nested `omp` process. Each worker claims its bead first, then uses its assigned Worktrunk worktree.",
	"- Work in waves. `orc_status.ready` is the wave: one `task` call dispatches every bead in it; the gate refuses a `task` call that omits a ready bead or names one twice; helpers such as `scout` are exempt. A settled batch wakes you with a `task-batch-wake` message: integrate, `orc_status`, dispatch. `orc_status.held` lists claimed beads; when its worker has ended, `orc_release { bead, holder, reason }` returns the bead to `ready`; `force: true` only after `hub list`/`hub jobs` show no agent on it. A wave has landed only when the whole `task` call has returned; re-read `orc_status` then, never on the first result. Workers retain their assigned Worktrunk worktrees; after each result, re-run `orc_status` and dispatch newly ready beads immediately. Review beads depend on their tasks, so they become the next `ready` wave together: dispatch them in one call, one `orc-reviewer` per review bead, each judging its bead against the integrated merge-base..HEAD diff. Findings become fix beads, which appear in the following `ready`. Never implementer, then its reviewer, then the next implementer.",
	"- The DAG decides the shape and `orc_status.shape` states it: `two-tier` (no child epic) means dispatch workers directly; `three-tier` (a direct child of the run epic is an epic) means dispatch one `orc-lead` per child epic each brief naming its epic and containing the word `orchestrate` so the epic lead receives this same contract, then merge the returned epic branches yourself. Once every child epic is closed, `ready` turns to the tasks directly under the run epic: the cross-epic review, dispatched as a wave over the merged run (`merge-base..HEAD`). Record cross-epic contracts as a `decision` bead before any epic lead starts. Dispatch `orc-planner` first only when the DAG does not exist yet or the domain is unfamiliar; it writes beads and returns.",
	"- Each `task` item copies `agent` from the matching `orc_status.wave` entry; you never choose an agent at dispatch time. Implementer tier comes from the bead's `metadata.tier` (`basic` -> `orc-implementer`, `deep` -> `orc-implementer-deep`, `max` -> `orc-implementer-max`); claim-holding implementers and epic leads use their assigned worktree; planner, reviewer, researcher, and shepherd do not claim worktrees. A wave item with `fix` is a same-tier re-run: put its `fix.findings` in the brief. A `planner` item dispatches `orc-planner` with the bead's description.",
	"- The DAG review comes first. When `orc_status` reports `DAG review required`, run the `bd create` it gives you, then call `orc_status` again: the review bead is the wave, one `orc-reviewer`, before any implementation. Every review bead finishes through `orc_finish` with a `verdict`: `approve` closes it; `fix` (a code defect) and `change` (a criterion not met) reopen the reviewed tasks with the findings for the same implementer at the same tier, at most two rounds; `escalate` with a cause, or a third round, holds the task under `orc_status.decisions`. Tiers are static: only your `orc_decide` (retry, upgrade, split, accept; stop last) moves a held task, and you record the reason. You create no fix beads yourself; a `blocked` implementer whose blocker is a missing prerequisite gets a prerequisite bead at the same tier, which you do create.",
	"- Bind first with `orc_bind { epic }`: it claims the epic for you and is the only ledger write outside `orc_claim`/`orc_finish`; `orc_status` reads. You never claim a task bead and never edit product code. A worker brief must not contain the bare lowercase word `orchestrate`, and it never tells a worker to skip the bead's own acceptance checks: implementers run every criterion's check and the tests they add; only project-wide suites and formatters are deferred to you.",
].join("\n");
/** The bash input with `BEADS_ACTOR` added to its `env`, or `undefined` when nothing changes. */
function withActor(input: unknown, actor: string): Record<string, unknown> | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const env = "env" in input ? input.env : undefined;
	if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env))) return undefined;
	const current = env === undefined ? undefined : (env as Record<string, unknown>).BEADS_ACTOR;
	if (typeof current === "string" && current.length > 0) return undefined;
	return { ...(input as Record<string, unknown>), env: { ...((env as Record<string, unknown> | undefined) ?? {}), BEADS_ACTOR: actor } };
}

/**
 * Route each `task` item to the agent its bead's wave entry names. An item whose agent is an
 * `orc-*` role (or unset) and whose brief names exactly one wave bead gets that entry's `agent`.
 * Helpers are never rerouted, and items naming no wave bead or several are left alone.
 * Returns the revised input, or `undefined` when nothing changes.
 */
export function routeDispatch(input: unknown, wave: ReadonlyMap<string, WaveItem>): Record<string, unknown> | undefined {
	if (input === null || typeof input !== "object" || wave.size === 0) return undefined;
	const record = input as Record<string, unknown>;
	const items = Array.isArray(record.tasks) ? record.tasks : [record];
	let changed = false;
	const routed = items.map(item => {
		if (item === null || typeof item !== "object") return item;
		const current = item as Record<string, unknown>;
		const brief = current.task;
		if (typeof brief !== "string") return item;
		if (current.agent !== undefined && !(typeof current.agent === "string" && current.agent.startsWith("orc-"))) return item;
		const named = namedBeads(brief, wave).map(bead => wave.get(bead)).filter((entry): entry is WaveItem => entry !== undefined);
		if (named.length !== 1) return item;
		const [entry] = named;
		if (current.agent === entry.agent) return item;
		changed = true;
		return { ...current, agent: entry.agent };
	});
	if (!changed) return undefined;
	return Array.isArray(record.tasks) ? { ...record, tasks: routed } : (routed[0] as Record<string, unknown>);
}

const NO_RUN = "no run epic yet — create the epic, then call orc_bind { epic } to bind it";

/**
 * Build the run header for one prompt. Exported for keyword tests.
 */
export async function runHeader(root: string, actor: string, stop?: string): Promise<string> {
	const store = readStoreMode(root);
	const storeLine = store === null ? "no .beads/metadata.json" : `${store.database ?? "?"} (${store.mode || "?"} mode)`;
	const validation = await validateLocator(root, actor);
	const run = validation.state === "missing" ? NO_RUN : validation.locator.run_id;
	const lines = ["<system-notice>", "orchestrate-with-bd run header", `canonical root: ${root}`, `store: ${storeLine}`, `run epic: ${run}${validation.state === "stale" ? ` (STALE: ${validation.reason})` : ""}`, `actor: ${actor}`, ""];
	if (validation.state === "stale") lines.push("Stale locator: run orc_bind with a new or reclaimed epic; a stale locator never authorizes dispatch.");
	if (stop !== undefined) {
		lines.push(stop, "</system-notice>");
		return lines.join("\n");
	}
	lines.push(CONTRACT, "</system-notice>");
	return lines.join("\n");
}

export default function orchestrateWithBd(pi: ExtensionAPI): void {
	pi.setLabel("Orchestrate with bd");

	// Every `bd` the model runs through bash carries the calling session's actor on the
	// call itself. A process-wide `BEADS_ACTOR` would be last-session-wins, because
	// concurrent subagents share one Bun process; a value the call already names is kept.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "task") {
			try {
				const wave = statusWave(ctx);
				if (wave === null || wave.size === 0) return undefined;
				const gate = waveGate(event.input, wave);
				if (gate === undefined) return undefined;
				if ("block" in gate) return gate;
				recordDispatch({ toolCallId: event.toolCallId, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, actor: actorFor(ctx), beadsByIndex: gate.beadsByIndex, workers: new Map() });
				clearStatusWave(ctx);
				const routed = routeDispatch(event.input, wave);
				return routed === undefined ? undefined : { input: routed };
			} catch { return undefined; }
		}
		if (event.toolName !== "bash") return undefined;
		const revised = withActor(event.input, actorFor(ctx));
		return revised === undefined ? undefined : { input: revised };
	});
	pi.events.on("task:subagent:lifecycle", payload => observeLifecycle(payload as Parameters<typeof observeLifecycle>[0]));

	pi.on("before_agent_start", async (event, ctx) => {
		if (!mentionsOrchestrate(event.prompt)) return undefined;
		let stop: string | undefined;
		// Every alias the shipped agents name must resolve through OMP's own resolver; an
		// undefined custom role otherwise degrades that agent to the caller's model unnoticed.
		const missing = missingRoles(ctx.models);
		if (missing.size > 0) {
			stop = rolesStop(missing);
		}
		return {
			message: {
				customType: "orc-run-header",
				display: false,
				attribution: "user",
				content: await runHeader(ctx.cwd, actorFor(ctx), stop),
			},
		};
	});

	// Advisory drift detector, deliberately non-blocking: it never spawns a process and
	// holds no state beyond the id set this session's most recent `orc_status` cached.
	pi.on("todo_reminder", async (event, ctx) => {
		if ((await validateLocator(ctx.cwd, actorFor(ctx))).state !== "valid") return;
		const ids = statusBeadIds(ctx);
		if (ids === null) return;
		const drifted = event.todos
			.map(todo => todo.content)
			.filter(content => !ids.has(content.trim().split(/\s+/u, 1)[0] ?? ""));
		if (drifted.length === 0) return;
		pi.sendUserMessage(
			`todo items not backed by a bead in the bound run: ${drifted.map(item => JSON.stringify(item)).join(", ")}. Re-read orc_status and rewrite the todo list from orc_status.todo.`,
			{ deliverAs: "followUp" },
		);
	});

	registerLedger(pi);
	registerBotReviewProbe(pi);
	registerBotReviewRequest(pi);
	registerConflictProbe(pi);
	registerReviewRoundPolicy(pi);
}
