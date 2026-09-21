/**
 * Thin `bd` runner for the ledger tools.
 *
 * Every child receives non-interactive flags. The session lifecycle pins `BEADS_DIR` to the
 * canonical checkout's embedded store, so this runner preserves that inherited pin and rejects a
 * pin belonging to a different repository.
 * Each caller is a tool handler that turns a thrown error into a tool error, so failures throw
 * rather than return sentinels.
 */

import path from "node:path";
import { GIT_PROBE_TIMEOUT_MS, spawnCommand } from "./worktree";
/** A bead as the ledger needs it. Extra fields pass through untouched. */
export interface BdBead {
	id: string;
	status?: string;
	assignee?: string;
	labels?: string[];
	metadata?: Record<string, unknown>;
	spec_id?: string;
	updated_at?: string;
	lease_expires_at?: string;
	[key: string]: unknown;
}

export interface BdResult {
	code: number;
	stdout: string;
	stderr: string;
}

export class BdError extends Error {
	constructor(readonly argv: readonly string[], readonly code: number, readonly stderr: string) {
		super(`bd ${argv.join(" ")} exited ${code}: ${stderr.trim()}`);
		this.name = "BdError";
	}
}

export class BdAuthenticationError extends BdError {
	constructor(argv: readonly string[], code: number, stderr: string) {
		super(argv, code, stderr.trim());
		this.name = "BdAuthenticationError";
	}
}


export const isGuardMismatch = (error: unknown): boolean => error instanceof BdError && error.code === 13;

export interface BdCapabilities {
	/** Native claim leases and reclaim. */
	leases: boolean;
	/** `bd update` compare-and-set guards. */
	cas: boolean;
	/** `--brief` on list and ready. */
	brief: boolean;
	/** `--brief-deps` on show. */
	briefDeps: boolean;
}

const BD_ENV: Record<string, string> = {
	BD_JSON_ENVELOPE: "1",
	BD_NO_PAGER: "1",
	BD_NON_INTERACTIVE: "1",
	BD_DOLT_AUTO_START: "false",
	NO_COLOR: "1",
};

export function assembleBdEnv(env: Record<string, string> = {}): Record<string, string> {
	const assembled = { ...process.env, ...env } as Record<string, string | undefined>;
	// An inherited server override can redirect an embedded store to a retired server.
	delete assembled.BEADS_DOLT_SHARED_SERVER;
	return { ...assembled, ...BD_ENV } as Record<string, string>;
}

type RepoIdentity = { kind: "known"; common: string } | { kind: "unknown"; reason: string };

/** Resolve repository identity without ever treating the input path as a guessed Git answer. */
async function repoIdentity(target: string): Promise<RepoIdentity> {
	const argv = ["git", "-C", target, "rev-parse", "--path-format=absolute", "--git-common-dir"] as const;
	// This probe runs inside a tool handler; 5 s is below the 30 s tool budget and leaves time to report the cause.
	const result = await spawnCommand(argv, target, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		return { kind: "unknown", reason: detail };
	}
	const common = result.stdout.trim();
	if (!path.isAbsolute(common)) return { kind: "unknown", reason: `git returned a non-absolute common directory: ${common || "(empty output)"}` };
	return { kind: "known", common };
}

async function assertBeadsRepository(env: Record<string, string>, cwd: string): Promise<void> {
	const beads = env.BEADS_DIR?.trim();
	if (beads === undefined || beads === "") return;
	const ledger = await repoIdentity(cwd);
	if (ledger.kind === "unknown") throw new Error(`cannot verify ledger repository ${cwd}: ${ledger.reason}`);
	const pinnedRoot = beads.endsWith(`${path.sep}.beads`) ? beads.slice(0, -`${path.sep}.beads`.length) : beads;
	const pinned = await repoIdentity(pinnedRoot);
	if (pinned.kind === "unknown") throw new Error(`cannot verify BEADS_DIR repository ${beads}: ${pinned.reason}`);
	if (ledger.common !== pinned.common) throw new Error(`BEADS_DIR points at ${pinned.common}, ledger tracks ${ledger.common}`);
}
function isAuthenticationFailure(stderr: string): boolean {
	return /(?:error\s+1045|access denied|connection refused)/iu.test(stderr);
}

/**
 * Whole lines bd emits when another process holds the workspace gate. Matched exactly, because a
 * substring test would retry a genuine failure that merely mentions a lock.
 */
const LOCK_CONTENTION_MESSAGES: Record<string, true> = {
	"a maintenance operation is running on this workspace: retry when it completes": true,
	"other bd commands are using this workspace: wait for them to finish and retry": true,
	"lock busy: held by another process": true,
	"lock already held by another process": true,
	"workspace gate busy": true,
};
/**
 * Dolt's own contention message, which bd passes through rather than rewriting. Observed verbatim
 * in this project's store evidence as `database dolt is locked by another process; either clone
 * the database to run a second server, or stop the dolt process which currently holds an
 * exclusive write lock.` The remedy clause varies with how the database was reached, so only the
 * stable clause is matched — and it is anchored to a `database <name> is locked` shape so a
 * message that merely mentions locking does not qualify.
 */
const DOLT_LOCK_CONTENTION = /\bdatabase\s+\S+\s+is locked by another process\b/iu;
const LOCK_RETRY_MAX_ATTEMPTS = 4;
const LOCK_RETRY_CAP_MS = 2_000;

function isLockContention(stderr: string): boolean {
	if (DOLT_LOCK_CONTENTION.test(stderr)) return true;
	return stderr.split(/\r?\n/u).some(line => LOCK_CONTENTION_MESSAGES[line.trim().toLowerCase()] === true);
}

function lockRetryDelay(attempt: number): number {
	const remaining = Math.max(0, LOCK_RETRY_CAP_MS - attempt * 100);
	const exponential = Math.min(100 * 2 ** attempt, remaining);
	return Math.min(LOCK_RETRY_CAP_MS, exponential + Math.floor(Math.random() * Math.max(1, exponential / 4)));
}


const capabilityCache = new Map<string, Promise<BdCapabilities>>();
function versionAtLeast(version: string): boolean {
	const match = version.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][^\s)]*)?/u);
	if (match === null || match[0].includes("-")) return false;
	const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
	return parts[0] > 1 || (parts[0] === 1 && (parts[1] > 3 || (parts[1] === 3 && parts[2] >= 0)));
}

const NO_NATIVE_CAPABILITIES: BdCapabilities = Object.freeze({ leases: false, cas: false, brief: false, briefDeps: false });
const NATIVE_CAPABILITIES: BdCapabilities = Object.freeze({ leases: true, cas: true, brief: true, briefDeps: true });

/**
 * Resolve the client once per checkout. A project can be launched with a different mise
 * environment from another checkout, so the cwd belongs in the cache key. A missing or
 * unparseable version is deliberately the old-client path: feature probes must not add a
 * second mutating command to a store we cannot identify.
 */
export function bdCapabilities(cwd: string): Promise<BdCapabilities> {
	const key = `${process.env.BD_BIN ?? "bd"}\u0000${cwd}`;
	const cached = capabilityCache.get(key);
	if (cached !== undefined) return cached;
	const detected = bdRun(["--version"], cwd).then(
		result => (result.code === 0 && versionAtLeast(`${result.stdout}\n${result.stderr}`) ? NATIVE_CAPABILITIES : NO_NATIVE_CAPABILITIES),
		error => {
			if (error instanceof BdAuthenticationError) throw error;
			return NO_NATIVE_CAPABILITIES;
		},
	);
	capabilityCache.set(key, detected);
	return detected;
}

/** Test isolation for callers that replace `Bun.spawn`; production callers never need this. */
export function clearBdCapabilityCache(): void {
  capabilityCache.clear();
}

/**
 * Spawn `bd` and wait. Throws on a missing binary or a timeout; a non-zero exit is returned.
 * Exact embedded-store lock contention is retried with bounded exponential backoff so a worker
 * does not abandon a bead it already owns when a sibling briefly holds Dolt's single-writer lock.
 * Other failures, including compare-and-set guard mismatches, return immediately unchanged.
 * `env` is layered over the process environment: the ledger passes the actor per call, because
 * concurrent subagents share one process and a global actor would collide. The session's
 * embedded-store `BEADS_DIR` pin is preserved and a pin belonging to a different repository is
 * rejected. An inherited shared-server override is discarded so it cannot redirect the embedded
 * store to the retired backend.
 */
export async function bdRun(
	args: readonly string[],
	cwd: string,
	env: Record<string, string> = {},
	timeoutMs = 20_000,
): Promise<BdResult> {
	const bin = process.env.BD_BIN ?? "bd";
	const assembledEnv = assembleBdEnv(env);
	await assertBeadsRepository(assembledEnv, cwd);
	for (let attempt = 0; attempt < LOCK_RETRY_MAX_ATTEMPTS; attempt++) {
		let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn([bin, ...args], { cwd, env: assembledEnv, stdout: "pipe", stderr: "pipe" });
		} catch {
			throw new Error("bd is not installed or not executable");
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (timedOut) throw new Error(`bd ${args.join(" ")} timed out after ${timeoutMs}ms`);
			if (code !== 0 && isLockContention(stderr) && attempt + 1 < LOCK_RETRY_MAX_ATTEMPTS) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, lockRetryDelay(attempt));
				await promise;
				continue;
			}
			return { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error("unreachable bd retry state");
}

/**
 * Parse a `bd --json` payload, unwrapping the `{ schema_version, data }` envelope
 * when present. Accept only a complete JSON document or a complete final non-empty line;
 * warning text may precede that line, but JSON-looking substrings are never trusted.
 */
export function parsePayload(stdout: string): unknown {
	const candidates = [stdout.trim()];
	const lines = stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
	const last = lines.at(-1);
	if (last !== undefined && last !== candidates[0]) candidates.push(last);
	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed !== null && typeof parsed === "object" && "schema_version" in parsed && "data" in parsed) {
				return parsed.data ?? undefined;
			}
			return parsed ?? undefined;
		} catch {
			// Try the next complete framing only; never recover an arbitrary substring.
		}
	}
	return undefined;
}

export function metadataRecord(raw: unknown): Record<string, unknown> | undefined {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}
	return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

export function asBead(value: unknown): BdBead | null {
	if (value === null || typeof value !== "object") return null;
	if (!("id" in value) || typeof value.id !== "string") return null;
	// Checked above: `value` is an object whose `id` is a string, which is the only
	// field the ledger requires. Every other field stays optional on BdBead.
	const bead = value as BdBead;
	if ("metadata" in bead) {
		const metadata = metadataRecord(bead.metadata);
		if (metadata === undefined) delete bead.metadata;
		else bead.metadata = metadata;
	}
	return bead;
}
type WriteFailureKind = "gate" | "access" | "terminal" | "indeterminate" | "other";

const READ_COMMANDS: Record<string, true> = {
	show: true,
	list: true,
	ready: true,
	search: true,
	stats: true,
	status: true,
	version: true,
	query: true,
	export: true,
};
/** One process-local tail per checkout; reads never join this map. */
const writerQueues = new Map<string, Promise<void>>();
const MAX_GATE_RETRIES = 3;
const GATE_BACKOFF_MS = 10;
const NO_RECONCILIATION = Symbol("no-reconciliation");

function isReadCommand(args: readonly string[]): boolean {
	return args.length === 0 || args[0] === undefined || READ_COMMANDS[args[0]] === true;
}

/**
 * Only store-idempotent claim and state transitions may be retried after a transient gate refusal.
 * Comments, creates, dependency edits, deletes, and unknown verbs stay at-most-once because this
 * wrapper has no durable dedupe key for them.
 */
function isRetrySafeWrite(args: readonly string[]): boolean {
	switch (args[0]) {
		case "close":
		case "reopen":
		case "heartbeat":
		case "reclaim":
		case "unclaim":
			return true;
		case "update":
			return ["--claim", "--if-assignee", "--if-status", "--status", "--assignee", "--set-metadata"].some(flag => args.includes(flag));
		default:
			return false;
	}
}

function targetId(args: readonly string[]): string | undefined {
	if (["update", "close", "reopen", "heartbeat", "unclaim"].includes(args[0] ?? "")) {
		return typeof args[1] === "string" && !args[1].startsWith("-") ? args[1] : undefined;
	}
	if (args[0] === "reclaim") {
		const id = args.indexOf("--id");
		return id >= 0 && typeof args[id + 1] === "string" ? args[id + 1] : undefined;
	}
	return undefined;
}

function failureKind(code: number, stderr: string): WriteFailureKind {
	const text = stderr.toLowerCase();
	if (/access denied|permission denied|not authorized|unauthori[sz]ed|forbidden|credentials? rejected|invalid credentials/u.test(text)) return "access";
	if (/indeterminate|ambiguous|uncertain|unknown whether|outcome unknown|may have (?:committed|landed)|commit result|transaction.*(?:unknown|uncertain)/u.test(text)) return "indeterminate";
	if (/workspace[\s_-]+gate|gate[\s_-]+(?:refus|busy|held|contention)|(?:workspace|database|store).*(?:locked|busy|contention|unavailable)|(?:locked|busy).*(?:workspace|database|store)|another writer|resource temporarily unavailable/u.test(text)) return "gate";
	if (code === 13 || /already\s+(?:claimed|closed|done|completed)|(?:claim|close)\w*.*already|(?:cannot|can't|refus\w*)\s+.*closed|no longer open/u.test(text)) return "terminal";
	return "other";
}

async function reconcileIndeterminate(args: readonly string[], cwd: string, env: Record<string, string>): Promise<unknown | typeof NO_RECONCILIATION> {
	if (!isRetrySafeWrite(args)) return NO_RECONCILIATION;
	const id = targetId(args);
	if (id === undefined) return NO_RECONCILIATION;
	const result = await bdRun(["show", id, "--json"], cwd, env);
	if (result.code !== 0) return NO_RECONCILIATION;
	const payload = parsePayload(result.stdout);
	return payload === undefined ? NO_RECONCILIATION : payload;
}

async function runWrite(args: readonly string[], cwd: string, env: Record<string, string>): Promise<unknown> {
	let gateRetries = 0;
	for (;;) {
		const result = await bdRun(args, cwd, env);
		if (result.code === 0) return parsePayload(result.stdout);
		const kind = failureKind(result.code, `${result.stderr}\n${result.stdout}`);
		if (kind === "indeterminate") {
			const reconciled = await reconcileIndeterminate(args, cwd, env);
			if (reconciled !== NO_RECONCILIATION) return reconciled;
		}
		if (kind === "gate" && isRetrySafeWrite(args) && gateRetries < MAX_GATE_RETRIES) {
			await new Promise<void>(resolve => setTimeout(resolve, GATE_BACKOFF_MS * 2 ** gateRetries));
			gateRetries++;
			continue;
		}
		// Keep main's authentication classification: the serialisation branch predates
		// BdAuthenticationError and threw a bare BdError here, which would have silently
		// dropped the credential-failure path every caller of bdJson relies on.
		throw isAuthenticationFailure(result.stderr) ? new BdAuthenticationError(args, result.code, result.stderr) : new BdError(args, result.code, result.stderr);
	}
}

function enqueueWrite<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
	const previous = writerQueues.get(cwd) ?? Promise.resolve();
	const scheduled = previous.then(operation, operation);
	const tail = scheduled.then(() => undefined, () => undefined);
	writerQueues.set(cwd, tail);
	void scheduled.then(
		() => {
			if (writerQueues.get(cwd) === tail) writerQueues.delete(cwd);
		},
		() => {
			if (writerQueues.get(cwd) === tail) writerQueues.delete(cwd);
		},
	);
	return scheduled;
}

/** Run `bd <args>` and return the parsed payload; writes are queued per checkout. Reads bypass the writer queue. */
export function bdJson(args: readonly string[], cwd: string, env: Record<string, string> = {}): Promise<unknown> {
	const operation = () => runWrite(args, cwd, env);
	return isReadCommand(args) ? operation() : enqueueWrite(cwd, operation);
}

/** `bd show <id> --json`; accepts an object or a one-element array. */
export async function bdShow(id: string, cwd: string, env: Record<string, string> = {}, extraArgs: readonly string[] = []): Promise<BdBead> {
	const payload = await bdJson(["show", id, ...extraArgs, "--json"], cwd, env);
	const bead = asBead(Array.isArray(payload) && payload.length === 1 ? payload[0] : payload);
	if (bead === null) throw new Error(`bd show ${id} returned no bead`);
	return bead;
}

/**
 * `bd list <args> --json`; a lone object is a list of one. An empty list is only ever an
 * explicit `[]`: no payload, a non-array payload, or a row without a string id throws,
 * because a zero exit with truncated output must not read as "no work".
 */
export async function bdList(args: readonly string[], cwd: string): Promise<BdBead[]> {
	const payload = await bdJson(["list", ...args, "--json"], cwd);
	const entries = Array.isArray(payload) ? payload : payload !== undefined && payload !== null && typeof payload === "object" ? [payload] : null;
	if (entries === null) throw new Error(`bd list ${args.join(" ")} returned no JSON array`);
	const beads: BdBead[] = [];
	for (const entry of entries) {
		const bead = asBead(entry);
		if (bead === null) throw new Error(`bd list ${args.join(" ")} returned a row without an id`);
		beads.push(bead);
	}
	return beads;
}

/** One dependency edge, whichever shape bd printed. */
export interface BdEdge {
	id: string;
	type: string;
}

/**
 * A bead's dependency edges. `bd show` prints `{ id, dependency_type }`, `bd list` prints
 * `{ depends_on_id, type }`; both are read, so every caller sees `{ id, type }`.
 */
export function edgesOf(bead: BdBead): BdEdge[] {
	const deps = Array.isArray(bead.dependencies) ? bead.dependencies : [];
	const out: BdEdge[] = [];
	for (const dep of deps) {
		if (dep === null || typeof dep !== "object") continue;
		const type = "dependency_type" in dep ? dep.dependency_type : "type" in dep ? dep.type : undefined;
		const id = "depends_on_id" in dep ? dep.depends_on_id : "id" in dep ? dep.id : undefined;
		if (typeof id === "string" && id.length > 0 && typeof type === "string") out.push({ id, type });
	}
	return out;
}

/** The parent id: a top-level `parent` field when bd prints one, else the parent-child edge. */
export function parentOf(bead: BdBead): string | undefined {
	if (typeof bead.parent === "string" && bead.parent.length > 0) return bead.parent;
	return edgesOf(bead).find(edge => edge.type === "parent-child")?.id;
}
