import type { WaveItem } from "./dag";

export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	status: "started" | "completed" | "failed" | "aborted";
	parentToolCallId?: string;
	index: number;
}

export interface DispatchRecord {
	toolCallId: string;
	sessionId: string;
	cwd: string;
	actor: string;
	beadsByIndex: string[][];
	workers: Map<number, { id: string; status: SubagentLifecyclePayload["status"]; endedAt?: number }>;
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
		record.workers.set(payload.index, { id: payload.id, status: payload.status, ...(payload.status === "started" ? {} : { endedAt: Date.now() }) });
		return;
	}
}

/**
 * The worker most recently dispatched for `bead` in this session; a still-running worker from
 * any dispatch wins over ended ones, so a re-dispatch never exposes stale "worker ended" evidence.
 */
export function workerFor(sessionId: string, bead: string): { id: string; status: string; endedAt?: number } | undefined {
	const records = dispatchesBySession.get(sessionId);
	if (!records) return undefined;
	let newest: { id: string; status: string; endedAt?: number } | undefined;
	for (const record of records.values()) {
		for (const [index, worker] of record.workers) {
			if (!record.beadsByIndex[index]?.includes(bead)) continue;
			if (worker.status === "started") return worker;
			newest = worker;
		}
	}
	return newest;
}
