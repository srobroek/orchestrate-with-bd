/**
 * orchestrate-with-bd — a durable Beads ledger beside OMP's native `orchestrate` keyword.
 *
 * OMP owns scheduling, agent lifecycle, isolated workspaces, capture, cancellation, and
 * landing. This plugin owns three things: the per-session actor every `bd` mutation is
 * attributed to, a run header injected when a prompt says `orchestrate`, and the ledger tools
 * (`orc_claim`, `orc_finish`, `orc_status`) that make Beads the source of truth for what
 * work exists and what state it is in. Four review-bot tools ride along untouched.
 *
 * The plugin does not schedule workers or discover stores. On clients that expose native Beads
 * leases it keeps claims alive and offers reclaim through the ledger; older clients retain the
 * existing claim/readback and explicit-release behaviour.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readStoreMode, type WaveItem } from "./dag";
import { mentionsOrchestrate } from "./keyword";
import {
	boundedMigration,
	MIGRATION_CONTRACT,
	MIGRATION_FILES,
	type MigrationGate,
	migrationEligible,
	migrationGates,
	mutatesStore,
} from "./migration";
import { missingRoles, rolesRefusal, rolesStop } from "./roles";
import { validateLocator } from "./run";
import { registerBotReviewProbe } from "./tools/bot-review-probe";
import { registerBotReviewRequest } from "./tools/bot-review-request";
import { namedBeads, observeLifecycle, recordDispatch, waveGate } from "./dispatch";
import { registerConflictProbe } from "./tools/conflict-probe";
import { actorFor, clearStatusWave, registerLedger, statusBeadIds, statusWave } from "./tools/ledger";
import { registerReviewRoundPolicy } from "./tools/review-round-policy";
export { BD_OR_STORE, mutatesStore } from "./migration";
const CONTRACT = [
	"- Read `skill://orchestrate-with-bd` before dispatching.",
	"- Beads is the only source of truth for what work exists and what state it is in. The todo list is a per-turn view of `orc_status`, never an independent plan: every item is `<bead-id> <title>` copied from `orc_status.todo`, never invented. On any disagreement, re-read `orc_status` and rewrite the list from it. `orc_finish` makes progress real; `todo done` only redraws the view.",
	"- In plan mode, the plan must name the epic and every task bead it implements in a `## Beads` section. A step with no bead is not planned work: create the bead first.",
	"- Dispatch every worker through the native `task` tool. Never start a nested `omp` process and never create a worktree for an agent.",
	"- Work in waves. `orc_status.ready` is the wave: one `task` call dispatches every bead in it; the gate refuses a `task` call that omits a ready bead or names one twice; helpers such as `scout` are exempt. A settled batch wakes you with a `task-batch-wake` message: integrate, `orc_status`, dispatch. `orc_status.held` lists claimed beads; when its worker has ended, `orc_release { bead, holder, reason }` returns the bead to `ready`; `force: true` only after `hub list`/`hub jobs` show no agent on it. A wave has landed only when the whole `task` call has returned; re-read `orc_status` then, never on the first result. Then merge every captured `omp/task/<agent-name>` branch into your tree, resolve conflicts there, and call `orc_status` again. Review beads depend on their tasks, so they become the next `ready` wave together: dispatch them in one call, one `orc-reviewer` per review bead, each judging its bead against the integrated merge-base..HEAD diff. Findings become fix beads, which appear in the following `ready`. Never implementer, then its reviewer, then the next implementer.",
	"- The DAG decides the shape and `orc_status.shape` states it: `two-tier` (no child epic) means dispatch workers directly; `three-tier` (a direct child of the run epic is an epic) means dispatch one `orc-lead` per child epic with `isolated: true`, each brief naming its epic and containing the word `orchestrate` so the epic lead receives this same contract, then merge the returned epic branches yourself. Once every child epic is closed, `ready` turns to the tasks directly under the run epic: the cross-epic review, dispatched as a wave over the merged run (`merge-base..HEAD`). Record cross-epic contracts as a `decision` bead before any epic lead starts. Dispatch `orc-planner` first only when the DAG does not exist yet or the domain is unfamiliar; it writes beads and returns.",
	"- Each `task` item copies `agent` and `isolated` from the matching `orc_status.wave` entry; you never choose an agent at dispatch time. Implementer tier comes from the bead's `metadata.tier` (`basic` -> `orc-implementer`, `deep` -> `orc-implementer-deep`, `max` -> `orc-implementer-max`); claim-holding implementers and epic leads run `isolated: true`; planner, reviewer, researcher, and shepherd do not. A wave item with `fix` is a same-tier re-run: put its `fix.findings` in the brief. A `planner` item dispatches `orc-planner` with the bead's description.",
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
 * `orc-*` role (or unset) and whose brief names exactly one wave bead gets that entry's
 * `agent` and `isolated`. A helper (`scout`, `operator`, `security-reviewer`, anything not
 * `orc-*`) is never rerouted, even when its brief cites the bead it helps with; an item that
 * names no wave bead or several is left alone. Returns the revised input,
 * or `undefined` when nothing changes. This is the enforcement behind "copy `agent` and
 * `isolated` from `orc_status.wave`": observed live (2026-09-14), a lead read a wave naming
 * `orc-implementer-deep` and dispatched `orc-implementer` anyway.
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
		if (current.agent === entry.agent && current.isolated === entry.isolated) return item;
		changed = true;
		return { ...current, agent: entry.agent, isolated: entry.isolated };
	});
	if (!changed) return undefined;
	return Array.isArray(record.tasks) ? { ...record, tasks: routed } : (routed[0] as Record<string, unknown>);
}

const NO_RUN = "no run epic yet — create the epic, then call orc_bind { epic } to bind it";

/**
 * Build the run header for one prompt. `gates` is the migration measurement for an embedded
 * store: when every blocking one is met the header carries the bounded migration contract
 * instead of the lead contract. Exported for the keyword tests; `index.ts` is the only
 * registration site.
 */
export async function runHeader(root: string, actor: string, stop?: string, gates?: readonly MigrationGate[]): Promise<string> {
	const store = readStoreMode(root);
	const storeLine = store === null ? "no .beads/metadata.json" : `${store.database ?? "?"} (${store.mode || "?"} mode)`;
	const validation = store?.mode === "server" ? await validateLocator(root, actor) : { state: "missing" as const };
	const run = validation.state === "missing" ? NO_RUN : validation.locator.run_id;
	const lines = ["<system-notice>", "orchestrate-with-bd run header", `store: ${storeLine}`, `run epic: ${run}${validation.state === "stale" ? ` (STALE: ${validation.reason})` : ""}`, `actor: ${actor}`, ""];
	if (validation.state === "stale") lines.push("Stale locator: run orc_bind with a new or reclaimed epic; a stale locator never authorizes dispatch.");
	if (store === null || store.mode !== "server") {
		if (gates !== undefined && migrationEligible(gates)) {
			// The gate list is the header's evidence, not prose: the human and the model read the
			// same measurement, and `post-verification` names what is still owed afterwards.
			lines.push(`migration gates: ${gates.map(gate => `${gate.name}: ${gate.state} — ${gate.detail}`).join("; ")}`, "", MIGRATION_CONTRACT, "</system-notice>");
			return lines.join("\n");
		}
		// Observed twice (2026-09-14): given the contract and the skill, a lead on an embedded
		// store followed the migration route itself. So the header carries no contract here and
		// names no skill; it says what to tell the human and that the tools will refuse.
		lines.push(
			"STOP. This checkout's Beads store is not on the shared Dolt server, so this session cannot orchestrate here. Reply to the human with exactly this and end the turn: the store must be migrated to the shared server, and the gates that would admit an in-session migration are not met here. Do not read any skill, do not run bd, do not edit .beads/, do not dispatch an agent. Every ledger tool and every store-changing command is refused in this session.",
		);
		const unmet = (gates ?? []).filter(gate => gate.state === "missing");
		if (unmet.length > 0) {
			lines.push(`Unmet migration gates, for the human: ${unmet.map(gate => `${gate.name} (${gate.detail})`).join("; ")}`);
		}
		lines.push("</system-notice>");
		return lines.join("\n");
	}
	if (stop !== undefined) {
		lines.push(stop, "</system-notice>");
		return lines.join("\n");
	}
	lines.push(CONTRACT, "</system-notice>");
	return lines.join("\n");
}

/** How much of a gated session's store surface stays open: the bounded route, or nothing. */
export interface SessionGate {
	reason: string;
	/** `true` only in a session every blocking migration gate admitted. */
	migration?: true;
}

/** Sessions that received a gated header, with the refusal their store-changing and dispatching calls get. */
const gated = new Map<string, SessionGate>();

/**
 * The session designated to migrate each checkout, so concurrent sessions in one process
 * cannot both be admitted. Keyed by checkout: two runs on two checkouts are independent.
 */
const migrator = new Map<string, string>();

/**
 * Reserve `root`'s migrator slot for `session` and return whoever holds it. Called before the
 * first `await` of the gate work: two concurrent `before_agent_start` calls would otherwise
 * both read an empty map while awaiting `bd --version` and both be admitted.
 */
function reserveMigrator(root: string, session: string): string {
	const holder = migrator.get(root);
	if (holder !== undefined) return holder;
	migrator.set(root, session);
	return session;
}

export const STOP_REFUSAL =
	"Refused: this orchestration session's Beads store is not on the shared server, and the gates that would admit an in-session migration are not met. Report it and end the turn.";

export const MIGRATION_REFUSAL =
	"Refused: this session may run only the bounded migration commands its run header lists, and it may not dispatch, claim, or write the ledger. Finish the migration, verify it, report it, and end the turn.";

const LEDGER_TOOLS: Record<string, true> = { task: true, orc_bind: true, orc_claim: true, orc_finish: true, orc_status: true, orc_release: true, orc_decide: true };

/** A block result when `toolName`/`input` would touch the store, the ledger, or dispatch, else `undefined`. */
export function storeMutationBlock(
	toolName: string,
	input: unknown,
	gate: SessionGate = { reason: STOP_REFUSAL },
): { block: true; reason: string } | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const reason = gate.reason;
	if (toolName === "bash") {
		const command = "command" in input ? input.command : undefined;
		if (typeof command !== "string") return undefined;
		// An admitted migration session is allowlist-only, and `boundedMigration` decides every
		// command rather than only the ones `mutatesStore` recognises: a `bd` spelling hidden
		// behind an expansion (`bd${IFS}delete x`) is store-changing too.
		if (gate.migration === true) return boundedMigration(command) ? undefined : { block: true, reason };
		return mutatesStore(command) ? { block: true, reason } : undefined;
	}
	if (toolName === "write" || toolName === "edit" || toolName === "ast_edit") {
		const target = "path" in input ? input.path : "paths" in input ? JSON.stringify(input.paths) : "";
		if (typeof target !== "string" || !target.includes(".beads/")) return undefined;
		// `dolt_mode` and `dolt.shared-server` live in these two files; every other store file
		// is read-only even here, and a multi-path edit never resolves to one of them.
		return gate.migration === true && MIGRATION_FILES.test(target) ? undefined : { block: true, reason };
	}
	if (LEDGER_TOOLS[toolName] === true) return { block: true, reason };
	return undefined;
}

export default function orchestrateWithBd(pi: ExtensionAPI): void {
	pi.setLabel("Orchestrate with bd");

	// Every `bd` the model runs through bash carries the calling session's actor on the
	// call itself. A process-wide `BEADS_ACTOR` would be last-session-wins, because
	// concurrent subagents share one Bun process; a value the call already names is kept.
	pi.on("tool_call", (event, ctx) => {
		const gate = gated.get(ctx.sessionManager.getSessionId());
		if (gate !== undefined) {
			const blocked = storeMutationBlock(event.toolName, event.input, gate);
			if (blocked !== undefined) return blocked;
		}
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
		const session = ctx.sessionManager.getSessionId();
		const store = readStoreMode(ctx.cwd);
		let stop: string | undefined;
		let gates: MigrationGate[] | undefined;
		if (store === null || store.mode !== "server") {
			// Closed first, so a throw or a rejection in the gate work below leaves this session
			// refusing rather than open.
			gated.set(session, { reason: STOP_REFUSAL });
			// A store the plugin cannot read is never admitted: the gates would be measuring an
			// absence. Only an embedded store is even asked, and the migrator slot is taken here,
			// before the first `await`, so two concurrent calls cannot both win it.
			if (store !== null) {
				const holder = reserveMigrator(ctx.cwd, session);
				gates = await migrationGates(ctx.cwd, { session, designated: holder });
				if (migrationEligible(gates)) gated.set(session, { reason: MIGRATION_REFUSAL, migration: true });
				else if (holder === session) migrator.delete(ctx.cwd);
			}
		} else {
			// Every alias the shipped agents name must resolve through OMP's own resolver; an
			// undefined custom role otherwise degrades that agent to the caller's model unnoticed.
			const missing = missingRoles(ctx.models);
			if (missing.size > 0) {
				stop = rolesStop(missing);
				gated.set(session, { reason: rolesRefusal(missing) });
			}
		}
		return {
			message: {
				customType: "orc-run-header",
				display: false,
				attribution: "user",
				content: await runHeader(ctx.cwd, actorFor(ctx), stop, gates),
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
