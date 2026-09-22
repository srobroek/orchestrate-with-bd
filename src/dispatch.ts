import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import type { WaveItem } from "./dag";

export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	status: "started" | "completed" | "failed" | "aborted";
	/** Persisted child session file; its generated basename ends in the session UUID. */
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
}

export interface DispatchRecord {
	toolCallId: string;
	sessionId: string;
	cwd: string;
	actor: string;
	beadsByIndex: string[][];
	workers: Map<number, { id: string; beadsActor?: string; status: SubagentLifecyclePayload["status"]; endedAt?: number }>;
}

const dispatchesBySession = new Map<string, Map<string, DispatchRecord>>();

function escape(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function namedBeads(brief: string, wave: ReadonlyMap<string, WaveItem>): string[] {
	return [...wave.keys()].filter(bead => new RegExp(`(?<![\\w.-])${escape(bead)}(?![\\w-])`, "u").test(brief));
}

export function waveGate(input: unknown, wave: ReadonlyMap<string, WaveItem>): { block: true; reason: string } | { beadsByIndex: string[][] } | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	const raw = Array.isArray(record.tasks) ? record.tasks : [record];
	const waveItems = raw.filter(item => {
		if (item === null || typeof item !== "object") return false;
		const agent = (item as Record<string, unknown>).agent;
		return agent === undefined || (typeof agent === "string" && agent.startsWith("orc-"));
	});
	if (waveItems.length === 0) return undefined;
	const beadsByIndex = raw.map(item => {
		if (item === null || typeof item !== "object") return [];
		const agent = (item as Record<string, unknown>).agent;
		if (agent !== undefined && !(typeof agent === "string" && agent.startsWith("orc-"))) return [];
		const brief = (item as Record<string, unknown>).task;
		return typeof brief === "string" ? namedBeads(brief, wave) : [];
	});
	const owners = new Map<string, number[]>();
	for (let i = 0; i < beadsByIndex.length; i++) for (const bead of beadsByIndex[i] ?? []) owners.set(bead, [...(owners.get(bead) ?? []), i]);
	const duplicate = [...owners.entries()].find(([, indexes]) => indexes.length > 1);
	if (duplicate) return { block: true, reason: `duplicate dispatch: ${duplicate[0]} appear in more than one item` };
	for (let i = 0; i < beadsByIndex.length; i++) {
		const item = raw[i];
		if (item === null || typeof item !== "object") continue;
		const agent = (item as Record<string, unknown>).agent;
		if (typeof agent === "string" && agent.startsWith("orc-") && (beadsByIndex[i]?.length ?? 0) === 0) {
			return { block: true, reason: `wave-item-unbound:${i}` };
		}
	}
	const referenced = new Set(owners.keys());
	const missing = [...wave.keys()].filter(bead => !referenced.has(bead));
	if (missing.length > 0) return { block: true, reason: `partial wave: ${missing.join(", ")} are in orc_status.ready but not in this call. Dispatch every ready bead in one task call (task.maxConcurrency queues the excess). If the wave changed, call orc_status again first.` };
	for (let i = 0; i < beadsByIndex.length; i++) if ((beadsByIndex[i]?.length ?? 0) > 1) return { block: true, reason: `item ${i} names several wave beads (${beadsByIndex[i]!.join(", ")}); one bead per item` };
	return { beadsByIndex };
}

export function recordDispatch(record: DispatchRecord): void {
	let session = dispatchesBySession.get(record.sessionId);
	if (!session) dispatchesBySession.set(record.sessionId, (session = new Map()));
	session.set(record.toolCallId, record);
}

export function observeLifecycle(payload: SubagentLifecyclePayload): void {
	if (!payload.parentToolCallId) return;
	for (const session of dispatchesBySession.values()) {
		const record = session.get(payload.parentToolCallId);
		if (!record) continue;
		record.workers.set(payload.index, { id: payload.id, beadsActor: childActor(payload.sessionFile, payload.id), status: payload.status, ...(payload.status === "started" ? {} : { endedAt: Date.now() }) });
		return;
	}
}

/** One bead a worker of this host is still running, with the actor that must already hold it. */
export interface Holding {
	bead: string;
	/** The worker's own Beads actor. Renewal verifies the bead is still assigned to exactly this. */
	actor: string;
	/** The dispatching call's cwd, from which the ledger root is resolved. */
	cwd: string;
	worker: string;
}

/**
 * Every bead held by a subagent this host still sees as `started`.
 *
 * This is the only liveness signal available without a tool argument: `task:subagent:lifecycle`
 * ends a worker on the event, not on a timeout, so a holding disappears the moment its worker
 * completes, fails or is aborted. A worker whose Beads actor could not be recovered is omitted
 * rather than renewed on a guess — `bd heartbeat` does not enforce ownership (it refreshes a
 * lease for any actor), so the actor recorded here is the only thing that can establish that a
 * renewal belongs to the holder, and an absent one denies renewal instead of granting it.
 */
export function startedHoldings(): Holding[] {
	const holdings: Holding[] = [];
	for (const session of dispatchesBySession.values()) {
		for (const record of session.values()) {
			for (const [index, worker] of record.workers) {
				if (worker.status !== "started") continue;
				const actor = worker.beadsActor;
				if (actor === undefined || actor.length === 0) continue;
				for (const bead of record.beadsByIndex[index] ?? []) holdings.push({ bead, actor, cwd: record.cwd, worker: worker.id });
			}
		}
	}
	return holdings;
}

/**
 * The child's own Beads actor, read from the first `session` frame of its transcript.
 *
 * Release evidence is only worth anything when it comes from the worker that actually held the
 * claim. Without this, any ended worker the parent dispatched for a bead could authorise a
 * `worker-ended:*` release of a claim held by someone else.
 *
 * Conservative by construction: the basename must be exactly `<workerId>.jsonl`, the id must be
 * a UUIDv7, a second `session` frame makes the file ambiguous, and every failure yields
 * `undefined` — which denies evidence rather than granting it.
 */
function childActor(sessionFile: string | undefined, workerId: string): string | undefined {
	if (sessionFile === undefined || path.basename(sessionFile) !== `${workerId}.jsonl`) return undefined;
	let fd: number | undefined;
	try {
		fd = openSync(sessionFile, "r");
		const bytes = Buffer.allocUnsafe(64 * 1024);
		const size = readSync(fd, bytes, 0, bytes.length, 0);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
		// A truncated trailing line would parse as malformed JSON; drop it.
		const completeText = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
		let sessionId: string | undefined;
		for (const line of completeText.split("\n").slice(0, 64)) {
			if (line.trim() === "") continue;
			const entry = JSON.parse(line) as { type?: unknown; id?: unknown };
			if (entry.type !== "session") continue;
			if (sessionId !== undefined || typeof entry.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(entry.id)) return undefined;
			sessionId = entry.id;
		}
		return sessionId === undefined ? undefined : `omp/${sessionId}`;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * The worker of the newest dispatch that named `bead` in this session. Only that dispatch
 * counts: an older ended worker is not evidence once the bead was re-dispatched, and a
 * re-dispatch with no lifecycle frame yet yields `undefined` (no evidence, so release refuses).
 */
export function workerFor(sessionId: string, bead: string): { id: string; beadsActor?: string; status: string; endedAt?: number } | undefined {
	const records = dispatchesBySession.get(sessionId);
	if (!records) return undefined;
	let newest: DispatchRecord | undefined;
	let newestIndex = -1;
	for (const record of records.values()) {
		const index = record.beadsByIndex.findIndex(beads => beads.includes(bead));
		if (index === -1) continue;
		newest = record;
		newestIndex = index;
	}
	return newest?.workers.get(newestIndex);
}
