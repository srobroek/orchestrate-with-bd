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
 * The plugin does not schedule workers or discover stores. Ownership is lease-only: a claim
 * carries bd's native lease, nothing renews it on a timer, and the recorded lead's next call after
 * its own epic lease expired issues one native heartbeat before proceeding.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readStoreMode, type WaveItem } from "./dag";
import { mentionsOrchestrate } from "./keyword";
import { activeAgent, activeRoleStop, missingRoles, rolesStop } from "./roles";
import { registerBotReviewProbe } from "./tools/bot-review-probe";
import { sweepMessage, sweepStaleWorktrees } from "./sweep";
import { registerBotReviewRequest } from "./tools/bot-review-request";
import { namedBeads, observeLifecycle, recordDispatch, waveGate } from "./dispatch";
import { startLeaseRenewal } from "./lease";
import { registerConflictProbe } from "./tools/conflict-probe";
import { actorFor, clearStatusWave, discoverRun, ledgerRoot, registerLedger, statusBeadIds, statusWave } from "./tools/ledger";
import { registerReviewRoundPolicy } from "./tools/review-round-policy";
import { spawnCommand, type CommandResult } from "./worktree";

const stoppedSessions = new Map<string, string>();
const ghPreflightBySession = new Map<string, Promise<CommandResult>>();

function ghPreflight(sessionId: string, root: string): Promise<CommandResult> {
	const cached = ghPreflightBySession.get(sessionId);
	if (cached !== undefined) return cached;
	const probe = spawnCommand(["gh", "auth", "status"], root, { timeoutMs: 2_000 }).catch(error => ({ code: 127, stdout: "", stderr: String(error) }));
	ghPreflightBySession.set(sessionId, probe);
	return probe;
}

function ghStatusOk(result: CommandResult): boolean {
	const output = `${result.stdout}\n${result.stderr}`;
	return result.code === 0 && /github\.com[\s\S]*(?:logged\s+in|account)/iu.test(output);
}

function ghDiagnostic(result: CommandResult): string {
	const detail = result.stderr.trim() || result.stdout.trim();
	return (detail || `exit ${result.code}`).slice(0, 2_000).replace(/\r?\n/gu, " | ");
}

const COMPANION_KEYS = [
	["beads", "com.srobroek.beads.present.v1"],
	["build", "com.srobroek.build.present.v1"],
	["worktrunk", "com.srobroek.worktrunk.present.v1"],
] as const;

function missingCompanions(): string[] {
	return COMPANION_KEYS.filter(([, key]) => {
		const marker = (globalThis as Record<symbol, unknown>)[Symbol.for(key)];
		return marker === undefined || marker === null || typeof marker !== "object" || Array.isArray(marker);
	}).map(([name]) => name);
}

function companionStop(missing: readonly string[]): string {
	return `STOP. omp-orchestrate requires companion plugins that are not loaded: ${missing.join(", ")}. Enable them from the srobroek-omp marketplace, then restart the session.`;
}
const LEDGER_TOOLS: Readonly<Record<string, true>> = Object.freeze({
	orc_bind: true,
	orc_claim: true,
	orc_next: true,
	orc_decide: true,
	orc_finish: true,
	orc_release: true,
	orc_status: true,
});

function claimAgent(input: unknown): string | undefined {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
	const agent = (input as Record<string, unknown>).agent;
	return typeof agent === "string" && agent.length > 0 ? agent : undefined;
}
const CONTRACT = [
	"- Read `skill://orchestrate-with-bd` before dispatching.",
	"- Beads is the only source of truth for what work exists and what state it is in. The todo list is a per-turn view of `orc_status`, never an independent plan: every item is `<bead-id> <title>` copied from `orc_status.todo`, never invented. On any disagreement, re-read `orc_status` and rewrite the list from it. `orc_finish` makes progress real; `todo done` only redraws the view.",
	"- In plan mode, the plan must name the epic and every task bead it implements in a `## Beads` section. A step with no bead is not planned work: create the bead first.",
	"- Dispatch every worker through the native `task` tool. Never start a nested `omp` process. Each worker claims its bead first, then works in the Worktrunk worktree its claim returns or records: `orc_claim` adopts the worktree the bead already carries and otherwise takes the one you created for it.",
	"- Work in waves. `orc_status.ready` is the wave: one `task` call dispatches every bead in it; the gate refuses a `task` call that omits a ready bead or names one twice; helpers such as `scout` are exempt. A settled batch wakes you with a `task-batch-wake` message: consume receipts, call `orc_status`, and dispatch. `orc_status.held` lists claimed beads; when its worker has ended, `orc_release { bead, holder, reason }` returns the bead to `ready`; `force: true` only after `hub list`/`hub jobs` show no agent on it. Refill happens on every settled child result: re-read `orc_status` and dispatch everything in `orc_status.newly_ready` at once while siblings still run. Implementation results produce pull requests; their review beads run at each PR's exact head before any landing. Approval creates the merge bead described below. A merger wave has landed only when the whole `task` call has returned and every continuation receipt proves its accepted head merged. Never pair an implementer with its immediate reviewer.",
	"- The DAG decides the shape and `orc_status.shape` states it: `two-tier` (no child epic) means dispatch workers directly; `three-tier` (a direct child of the run epic is an epic) means dispatch one `orc-lead` per child epic, each brief naming its epic and containing the word `orchestrate` so the epic lead receives this same contract. Each epic lead reviews and lands its feature pull request through a merge bead before returning. Once every child epic is closed, `ready` turns to the tasks directly under the run epic: the cross-epic review, dispatched over the landed run (`merge-base..HEAD`). Record cross-epic contracts as a `decision` bead before any epic lead starts. Dispatch `orc-planner` first only when the DAG does not exist yet or the domain is unfamiliar; it writes beads and returns.",
	"- Each `task` item copies `agent` from the matching `orc_status.wave` entry; you never choose an agent at dispatch time. Implementer tier comes from the bead's `metadata.tier` (`basic` -> `orc-implementer`, `deep` -> `orc-implementer-deep`, `max` -> `orc-implementer-max`); claim-holding implementers and epic leads use their assigned worktree, and so do reviewers, researchers, shepherds, and mergers, whose trees are disposable but still recorded and reclaimed; only a planner and a DAG review claim no worktree. A wave item with `fix` is a same-tier re-run: put its `fix.findings` in the brief. A `planner` item dispatches `orc-planner` with the bead's description.",
	"- The DAG review comes first. When `orc_status` reports `DAG review required`, run the `bd create` it gives you, then call `orc_status` again: the review bead is the wave, one `orc-reviewer`, before any implementation. Every review bead finishes through `orc_finish` with a `verdict`: `approve` closes it; `fix` (a code defect) and `change` (a criterion not met) reopen the reviewed tasks with the findings for the same implementer at the same tier, at most two rounds; `escalate` with a cause, or a third round, holds the task under `orc_status.decisions`. Tiers are static: only your `orc_decide` (retry, upgrade, split, accept; stop last) moves a held task, and you record the reason. You create no fix beads yourself; a `blocked` implementer whose blocker is a missing prerequisite gets a prerequisite bead at the same tier, which you do create.",
	"- After a review accepts a pull request, create exactly one merge bead for that accepted head under the epic. Assign it to `pool:orc-merger`; set metadata `{\"role\":\"merger\",\"target\":\"PR_URL\",\"base\":\"BASE_BRANCH\",\"head_sha\":\"REVIEWED_HEAD\",\"receipt\":\"landed+cleaned\"}`; and make it depend on the accepted review. Its sole landing command is `gh pr merge PR_URL MERGE_METHOD --match-head-commit REVIEWED_HEAD`, with one repository-approved merge method and no auto-merge. The atomic expected-head guard is required because the head can change after preflight. Call `orc_status` and dispatch the resulting `orc-merger` wave item. The merger terminally closes every attempt and returns target, base, exact reviewed head, merge SHA or failure, close disposition, and cleanup outcome. Consume that receipt before advancing. Never schedule a replacement until the old bead is closed and its worktree registration, path, and branch are confirmed gone. You retain the integration worktree and resolve every conflict there; the merger never owns integration or conflict policy.",
	"- Bind first with `orc_bind { epic }`: it claims the epic for you. Lead ledger writes are `orc_bind`, `orc_decide`, and the explicit native Beads commands that create or connect DAG-review, prerequisite, and merge beads; `orc_status` reads. You never claim a task bead or implement product changes; conflict resolution in your integration worktree is the sole code exception. A worker brief must not contain the bare lowercase word `orchestrate`, and it never tells a worker to skip the bead's own acceptance checks: implementers run every criterion's check and the tests they add; only project-wide suites and formatters are deferred to you.",
].join("\n");
/** The bash input with both actor names added to its `env`. Malformed env values are replaced with a fresh object. */
function withActor(input: unknown, actor: string): Record<string, unknown> | undefined {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
	const env = "env" in input ? input.env : undefined;
	const values = env !== null && typeof env === "object" && !Array.isArray(env) ? Object.fromEntries(Object.entries(env as Record<string, unknown>).filter(([, value]) => typeof value === "string")) : {};
	return { ...(input as Record<string, unknown>), env: { ...values, BD_ACTOR: actor, BEADS_ACTOR: actor } };
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
 *
 * The run is read from the ledger, not from a file beside the checkout: every agent works in
 * its own linked worktree, and the canonical root every worktree shares is named here so a
 * lead can see at a glance which checkout its `bd` calls and workflows resolve to.
 */
export async function runHeader(cwd: string, actor: string, stop?: string, resolveRoot: (cwd: string) => Promise<string> = ledgerRoot, sessionId = actor): Promise<string> {
	let root: string;
	try {
		root = await resolveRoot(cwd);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const lines = ["<system-notice>", "orchestrate-with-bd run header", `canonical checkout: unknown (cwd: ${cwd})`, "store: unknown", `run epic: ${NO_RUN}`, `actor: ${actor}`, "", `STOP. refusing ledger access because the canonical checkout is unknown: ${reason}`];
		if (stop !== undefined) lines.push(stop);
		lines.push("</system-notice>");
		return lines.join("\n");
	}
	const store = readStoreMode(root);
	const storeLine = store === null ? "no .beads/metadata.json" : `${store.database ?? "?"} (${store.mode || "?"} mode)`;
	const lookup = await discoverRun(root, actor).catch(() => ({ state: "none" }) as const);
	const run =
		lookup.state === "bound"
			? `${lookup.owned.epic.id}${lookup.owned.run.root === lookup.owned.epic.id ? "" : ` (run root ${lookup.owned.run.root})`}`
			: lookup.state === "stale"
				? lookup.epic === undefined
					? `${NO_RUN} — ${lookup.reason}`
					: `${lookup.epic} (native lease is not live; call orc_bind { epic: ${JSON.stringify(lookup.epic)} } to renew it)`
				: lookup.state === "ambiguous"
					? `AMBIGUOUS: ${lookup.epics.join(", ")} are both bound to you; close or release one`
					: NO_RUN;
	const lines = ["<system-notice>", "orchestrate-with-bd run header", `canonical checkout: ${root}`, `store: ${storeLine}`, `run epic: ${run}`, `actor: ${actor}`, ""];
	if (lookup.state === "bound" && !lookup.owned.run.ci_scoped) lines.push("This repository's CI is not fully scoped away from pull requests into `omp/**`; orc_bind reported what it could not change. Scope the rest before dispatching a wave.");
	const [gh, optional] = await Promise.all([
		ghPreflight(sessionId, root),
		Promise.resolve(`optional agents: security-reviewer=unknown, operator=${missingCompanions().includes("build") ? "missing via build marker" : "present"}, scout=unknown`),
	]);
	lines.push(ghStatusOk(gh) ? "gh: ok" : `gh: unavailable (${ghDiagnostic(gh)})`, optional);
	if (stop !== undefined) {
		lines.push(stop, "</system-notice>");
		return lines.join("\n");
	}
	lines.push(CONTRACT, "</system-notice>");
	return lines.join("\\n");
}

export default function orchestrateWithBd(pi: ExtensionAPI): void {
	pi.setLabel("Orchestrate with bd");

	// D-5: collect closed-bead worktrees without blocking session startup or forcing removal.
	// The advisory sweep is handed off because `wt remove` can exceed the event budget.
	pi.on("session_start", (_event, ctx) => {
		void ledgerRoot(ctx.cwd)
			.then(root => sweepStaleWorktrees(root))
			.then(result => sweepMessage(result) ?? "")
			.catch(error => `stale worktree sweep stood down: cannot resolve canonical checkout for ${ctx.cwd}: ${error instanceof Error ? error.message : String(error)}`)
			.then(message => {
				if (message !== "") pi.sendUserMessage(message, { deliverAs: "followUp" });
			})
			.catch(() => undefined);
	});

	pi.on("tool_call", (event, ctx) => {
		const session = ctx.sessionManager.getSessionId();
		if (event.toolName === "task" || LEDGER_TOOLS[event.toolName] === true) {
			const missing = missingCompanions();
			if (missing.length > 0) return { block: true, reason: companionStop(missing) };
		}
		const stopped = stoppedSessions.get(session);
		if (stopped !== undefined && (event.toolName === "task" || LEDGER_TOOLS[event.toolName] === true)) return { block: true, reason: stopped };
		if (LEDGER_TOOLS[event.toolName] === true) {
			const roleStop = activeRoleStop(ctx.models, ctx.getSystemPrompt(), undefined, ctx.sessionManager.getEntries?.() ?? []);
			if (roleStop !== undefined) {
				stoppedSessions.set(session, roleStop);
				return { block: true, reason: roleStop };
			}
		}
		if (event.toolName === "orc_claim") {
			const active = activeAgent(ctx.getSystemPrompt());
			const supplied = claimAgent(event.input);
			if (active !== undefined && supplied !== active) return { block: true, reason: `orc_claim refused: the active agent is ${active}, but the call named ${supplied ?? "no agent"}. Pass agent: "${active}" so a claim-pool bead cannot be taken by a mismatched role.` };
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
	// Nothing renews a task bead's lease on its own, and the client exposes no TTL key: a worker
	// that runs past the store default holds an expired lease that `bd reclaim` will strip. The
	// sweep renews only beads whose worker this host still sees as `started`.
	startLeaseRenewal(ledgerRoot);

	pi.on("before_agent_start", async (event, ctx) => {
		if (!mentionsOrchestrate(event.prompt)) return undefined;
		const companions = missingCompanions();
		let stop: string | undefined;
		if (companions.length > 0) {
			stop = companionStop(companions);
		} else {
			const missing = missingRoles(ctx.models);
			stop = missing.size > 0 ? rolesStop(missing) : activeRoleStop(ctx.models, ctx.getSystemPrompt(), undefined, ctx.sessionManager.getEntries?.() ?? []);
			if (stop !== undefined) stoppedSessions.set(ctx.sessionManager.getSessionId(), stop);
		}
		return { message: { customType: "orc-run-header", display: false, attribution: "user", content: await runHeader(ctx.cwd, actorFor(ctx), stop, ledgerRoot, ctx.sessionManager.getSessionId()) } };
	});

	pi.on("todo_reminder", async (event, ctx) => {
		const ids = statusBeadIds(ctx);
		if (ids === null) return;
		const drifted = event.todos.map(todo => todo.content).filter(content => !ids.has(content.trim().split(/\s+/u, 1)[0] ?? ""));
		if (drifted.length === 0) return;
		pi.sendUserMessage(`todo items not backed by a bead in the bound run: ${drifted.map(item => JSON.stringify(item)).join(", ")}. Re-read orc_status and rewrite the todo list from orc_status.todo.`, { deliverAs: "followUp" });
	});

	registerLedger(pi);
	registerBotReviewProbe(pi);
	registerBotReviewRequest(pi);
	registerConflictProbe(pi);
	registerReviewRoundPolicy(pi);
}
