import { readFileSync } from "node:fs";
import path from "node:path";
import { asBead, bdCapabilities, type BdBead, type BdCapabilities, bdJson, bdList, edgesOf, metadataRecord } from "./bd";
/** What `.beads/metadata.json` says about the store. */
export type StoreMode = { mode: string; database: string | null };

/** The store mode from `<root>/.beads/metadata.json`; `null` when the file is absent or unreadable. */
export function readStoreMode(root: string): StoreMode | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path.join(root, ".beads", "metadata.json"), "utf8"));
	} catch {
		return null;
	}
	const record = metadataRecord(raw);
	if (record === undefined) return null;
	const mode = record.dolt_mode;
	const database = record.dolt_database;
	return {
		mode: typeof mode === "string" ? mode : "",
		database: typeof database === "string" ? database : null,
	};
}

/** Upper bound on beads one `descendants` walk returns; the caller reports truncation. */
export const DESCENDANT_LIMIT = 500;

export interface Descendants {
	beads: BdBead[];
	truncated: boolean;
}

/**
 * Every bead under `epic`, breadth-first. `bd list --parent` returns direct children only,
 * so the walk queues each child in turn, dedupes by id, and stops at `DESCENDANT_LIMIT`.
 * A non-zero `bd` exit propagates; nothing falls back to a different store.
 */
export async function descendants(epic: string, cwd: string, capabilities?: BdCapabilities): Promise<Descendants> {
	const caps = capabilities ?? (await bdCapabilities(cwd));
	const brief = caps.brief ? ["--brief"] : [];
	const seen = new Set<string>([epic]);
	const beads: BdBead[] = [];
	const queue = [epic];
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const parent = queue[cursor] as string;
		for (const child of await bdList(["--parent", parent, "--all", ...brief], cwd)) {
			if (seen.has(child.id)) continue;
			seen.add(child.id);
			if (beads.length >= DESCENDANT_LIMIT) return { beads, truncated: true };
			beads.push(child);
			queue.push(child.id);
		}
	}
	return { beads, truncated: false };
}
/** `<id> <title>` for every open or in-progress bead, in the order given. */
export function todoStrings(beads: readonly BdBead[]): string[] {
	const out: string[] = [];
	for (const bead of beads) {
		if (bead.status !== "open" && bead.status !== "in_progress") continue;
		const title = typeof bead.title === "string" ? bead.title : "";
		out.push(title.length > 0 ? `${bead.id} ${title}` : bead.id);
	}
	return out;
}

/** One dispatchable bead of the wave, with the agent the DAG routes it to. */
export interface WaveItem {
	bead: string;
	title: string;
	role: string;
	/** Implementer tier from `metadata.tier`; absent for non-implementer roles. */
	tier?: "basic" | "deep" | "max";
	agent: string;
	/** Set when a review returned `fix`: the same agent re-runs this bead with these findings. */
	fix?: { from: string; round: number; findings: string };
	/** Set on a fix bead the lead's `upgrade` decision created one tier up from this task. */
	escalatedFrom?: string;
}

const TIER_AGENT = { basic: "orc-implementer", deep: "orc-implementer-deep", max: "orc-implementer-max" } as const;

/**
 * Implementer tier from `metadata.tier`. A missing mark is `basic` (bounded work is the
 * norm); an unrecognised value is `deep`, so a malformed mark never routes hard work down.
 */
export function tierOf(metadata: Record<string, unknown> | undefined): WaveItem["tier"] {
	const raw = metadata?.tier;
	if (raw === undefined || raw === null || raw === "") return "basic";
	return raw === "basic" || raw === "deep" || raw === "max" ? raw : "deep";
}

/**
 * Route one ready bead to an agent. Epics go to `orc-lead`; `metadata.role` picks reviewer,
 * researcher, or shepherd; any other role (or none) is implementer work routed by tier and
 * reported as written, so a misspelt role stays visible to the lead. Claim-holding
 */
export function waveItem(bead: BdBead): WaveItem {
	const title = typeof bead.title === "string" ? bead.title : "";
	const metadata = metadataRecord(bead.metadata);
	if (bead.issue_type === "epic") return { bead: bead.id, title, role: "lead", agent: "orc-lead" };
	const role = typeof metadata?.role === "string" && metadata.role.length > 0 ? metadata.role : "implementer";
	if (role === "reviewer" || role === "dag-reviewer") return { bead: bead.id, title, role, agent: "orc-reviewer" };
	if (role === "planner") return { bead: bead.id, title, role, agent: "orc-planner" };
	if (role === "researcher") return { bead: bead.id, title, role, agent: "orc-researcher" };
	if (role === "shepherd") return { bead: bead.id, title, role, agent: "orc-shepherd" };
	const tier = tierOf(metadata);
	const item: WaveItem = { bead: bead.id, title, role, tier, agent: TIER_AGENT[tier ?? "basic"] };
	if (typeof metadata?.fix_from === "string") {
		item.fix = {
			from: metadata.fix_from,
			round: Number(metadata.fix_round ?? 1),
			findings: typeof metadata.fix_findings === "string" ? metadata.fix_findings : "",
		};
	}
	if (typeof metadata?.escalated_from === "string") item.escalatedFrom = metadata.escalated_from;
	return item;
}

/** Roles whose bead is never branded with an `omp/agent/<bead>` worktree of its own. */
const WORKTREELESS_ROLES: Record<string, true> = { reviewer: true, "dag-reviewer": true, planner: true, researcher: true, shepherd: true };

/**
 * Whether this bead's work happens in a worktree branded on the bead. An epic lead works in
 * its integration worktree and a reviewer in a disposable `pr:<N>` tree it creates per round;
 * neither is `omp/agent/<bead>`, so a claim on either never demands or records one.
 */
export function ownsAgentWorktree(bead: BdBead): boolean {
	return bead.issue_type !== "epic" && WORKTREELESS_ROLES[waveItem(bead).role] !== true;
}

/**
 * The run shape the DAG implies: three tiers when any direct child of the run epic is
 * itself an epic (one `orc-lead` per child epic), two tiers otherwise (workers dispatched
 * directly). Derived from Beads, never from a flag, so the plan the human approved is the
 * human input.
 */
export function runShape(epic: string, beads: readonly BdBead[]): "two-tier" | "three-tier" {
	return childEpics(epic, beads).length > 0 ? "three-tier" : "two-tier";
}

/** Direct children of `epic` (parent-child dependency on it), in the order given. */
export function directChildren(epic: string, beads: readonly BdBead[]): BdBead[] {
	return beads.filter(bead => {
		return edgesOf(bead).some(edge => edge.type === "parent-child" && edge.id === epic);
	});
}

/** Direct child epics of `epic`, in the order given. */
export function childEpics(epic: string, beads: readonly BdBead[]): BdBead[] {
	return directChildren(epic, beads).filter(bead => bead.issue_type === "epic");
}

/** Ids of every bead under `root` in `beads` (transitive parent-child), excluding `root`. */
export function subtreeIds(root: string, beads: readonly BdBead[]): Set<string> {
	const children = new Map<string, string[]>();
	for (const bead of beads) {
		for (const edge of edgesOf(bead)) {
			if (edge.type !== "parent-child") continue;
			const list = children.get(edge.id) ?? [];
			list.push(bead.id);
			children.set(edge.id, list);
		}
	}
	const out = new Set<string>();
	const queue = [root];
	for (let cursor = 0; cursor < queue.length; cursor++) {
		for (const child of children.get(queue[cursor] as string) ?? []) {
			if (out.has(child)) continue;
			out.add(child);
			queue.push(child);
		}
	}
	return out;
}

async function readyUnder(parent: string, cwd: string, type?: "epic", capabilities?: BdCapabilities): Promise<BdBead[]> {
	const caps = capabilities ?? (await bdCapabilities(cwd));
	const args = ["ready", ...(type === undefined ? [] : ["--type", type]), "--parent", parent, "--unassigned", ...(caps.brief ? ["--brief"] : []), "--limit", "0", "--json"];
	const payload = await bdJson(args, cwd);
	const entries = Array.isArray(payload) ? payload : payload === undefined ? [] : [payload];
	const out: BdBead[] = [];
	for (const entry of entries) {
		const bead = asBead(entry);
		if (bead !== null) out.push(bead);
	}
	return out;
}

/**
 * The current wave for this tier, dependency-aware through `bd ready`, which honours
 * `blocks` edges and excludes `in_progress` issues.
 *
 * Any tier: while a `dag-reviewer` bead under `epic` is open, the wave holds only it or the
 * planner beads it depends on.
 *
 * Two-tier: every `task` bead under `epic` that `bd ready` reports as unblocked and unassigned.
 *
 * Three-tier, while a child epic is still open: the direct child epics that `bd ready`
 * reports as ready (epic-to-epic blockers honoured; an epic a lead has bound is
 * `in_progress` and drops out), minus any epic whose open tasks are all blocked. bd 1.3.0
 * refuses a blocking dependency from an epic to its ancestor decision, so a decision gates an
 * epic through its tasks; an epic with no tasks at all stays in the wave, because its lead plans it.
 *
 * Three-tier, once every child epic is closed and nothing under them is open: the ready
 * `task` beads that sit directly under the run epic, which is where a cross-epic review
 * lives. bd refuses a task-to-epic dependency, so this is the only gate keeping that review
 * out of the first wave. Root-level tasks are therefore the run's final wave by definition.
 */
export async function readyWave(epic: string, beads: readonly BdBead[], cwd: string, capabilities?: BdCapabilities): Promise<BdBead[]> {
	const caps = capabilities ?? (await bdCapabilities(cwd));
	const dagReview = beads.find(bead => bead.issue_type !== "epic" && metadataRecord(bead.metadata)?.role === "dag-reviewer" && (bead.status === "open" || bead.status === "in_progress"));
	if (dagReview !== undefined) {
		const revisions = new Set(edgesOf(dagReview).filter(edge => edge.type !== "parent-child").map(edge => edge.id));
		return (await readyUnder(epic, cwd, undefined, caps)).filter(bead => bead.id === dagReview.id || revisions.has(bead.id));
	}
	const epics = childEpics(epic, beads);
	if (epics.length === 0) return (await readyUnder(epic, cwd, undefined, caps)).filter(bead => bead.issue_type === "task");
	const direct = new Set(epics.map(bead => bead.id));
	const epicSubtrees = new Set<string>();
	for (const child of epics) for (const id of subtreeIds(child.id, beads)) epicSubtrees.add(id);
	const unfinishedInside = beads.some(bead => epicSubtrees.has(bead.id) && (bead.status === "open" || bead.status === "in_progress"));
	if (epics.every(bead => bead.status === "closed") && !unfinishedInside) {
		const rootTasks = new Set(directChildren(epic, beads).filter(bead => bead.issue_type === "task").map(bead => bead.id));
		return (await readyUnder(epic, cwd, undefined, caps)).filter(bead => rootTasks.has(bead.id));
	}
	const candidates = (await readyUnder(epic, cwd, "epic", caps)).filter(bead => direct.has(bead.id));
	const wave: BdBead[] = [];
	for (const candidate of candidates) {
		const inside = subtreeIds(candidate.id, beads);
		const openTasks = beads.filter(bead => inside.has(bead.id) && bead.issue_type !== "epic" && (bead.status === "open" || bead.status === "in_progress"));
		if (openTasks.length === 0) {
			wave.push(candidate);
			continue;
		}
		const readyTasks = await readyUnder(candidate.id, cwd, undefined, caps);
		if (readyTasks.some(bead => bead.issue_type !== "epic")) wave.push(candidate);
	}
	return wave;
}

export function beadIds(beads: readonly BdBead[]): Set<string> {
	return new Set(beads.map(bead => bead.id));
}
