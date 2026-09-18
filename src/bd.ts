/**
 * Thin `bd` runner for the ledger tools.
 *
 * The plugin neither adds nor removes store selectors: `bd` resolves the store the way it
 * would for a human in the same directory, so a `BEADS_DIR` the operator's shell exported
 * is the environment's decision, not this module's. Every caller is a tool handler that
 * turns a thrown error into a tool error, so failures throw rather than return sentinels.
 */

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
	heartbeat_at?: string;
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

export const isGuardMismatch = (error: unknown): boolean => error instanceof BdError && error.code === 13;

export interface BdCapabilities {
	/** Native claim leases, heartbeat, and reclaim. */
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
};

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
	const detected = bdRun(["--version"], cwd).then(result => (result.code === 0 && versionAtLeast(`${result.stdout}\n${result.stderr}`) ? NATIVE_CAPABILITIES : NO_NATIVE_CAPABILITIES), () => NO_NATIVE_CAPABILITIES);
	capabilityCache.set(key, detected);
	return detected;
}

/** Test isolation for callers that replace `Bun.spawn`; production callers never need this. */
export function clearBdCapabilityCache(): void {
	capabilityCache.clear();
}

/**
 * Spawn `bd` and wait. Throws on a missing binary or a timeout; a non-zero exit is returned.
 * `env` is layered over the process environment: the ledger passes `BEADS_ACTOR` per call,
 * because concurrent subagents share one process and a global actor would collide.
 * `BEADS_DIR` is removed for the same reason: the beads plugin pins it process-wide to the
 * first session's checkout, and a second session's ledger call must resolve its own store
 * from `cwd` (the tracked `.beads/metadata.json` every clone carries).
 */
export async function bdRun(
	args: readonly string[],
	cwd: string,
	env: Record<string, string> = {},
	timeoutMs = 20_000,
): Promise<BdResult> {
	const bin = process.env.BD_BIN ?? "bd";
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		const { BEADS_DIR: _pin, ...inherited } = process.env;
		proc = Bun.spawn([bin, ...args], { cwd, env: { ...inherited, ...env, ...BD_ENV }, stdout: "pipe", stderr: "pipe" });
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
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Parse a `bd --json` payload, unwrapping the `{ schema_version, data }` envelope
 * when present. `BD_JSON_ENVELOPE=1` asks for the envelope, but fixtures and older
 * subcommands emit a bare value, so both shapes are accepted.
 *
 * `bd` may print a warning line before the payload (a cold server, a redirect target it
 * could not follow), so parsing starts at the first brace or bracket rather than byte 0.
 * `undefined` when there is no JSON value there; a bare `null` is folded into that,
 * because no read answers `null` and means something by it.
 */
export function parsePayload(stdout: string): unknown {
	const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter(index => index !== -1);
	if (starts.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(stdout.slice(Math.min(...starts)));
		if (parsed !== null && typeof parsed === "object" && "schema_version" in parsed && "data" in parsed) {
			return parsed.data ?? undefined;
		}
		return parsed ?? undefined;
	} catch {
		return undefined;
	}
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
		throw new BdError(args, result.code, result.stderr);
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
