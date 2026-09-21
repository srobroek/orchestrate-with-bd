/**
 * Worktree facts the ledger needs: which checkout is canonical, which worktrees belong to
 * this repository, and whether a claimant's worktree is one of them.
 *
 * Every agent works in its own Worktrunk-created linked worktree, so `ctx.cwd` is a worktree
 * and the store, the workflows, and the git common directory are all in the canonical
 * checkout. Membership is *checked* rather than assumed: `git worktree list --porcelain -z` is
 * repo-scoped, so a worktree of a different repository is not a worktree of this one, and a
 * path is compared by realpath because a symlink inside a worktree can point at canonical.
 *
 * `git worktree list --porcelain` is used rather than `wt list --format json`: the latter is
 * richer but took 22 s in this repository, and a claim must not wait that long. `-z` is not a
 * refinement of it: without it a worktree path containing a newline is indistinguishable from
 * the start of a second record, so a claimant could name a path that is no worktree at all and
 * have a real record's branch attributed to it.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { agentBranch, integrationBranch } from "./types";

export type CommandQuiescence = { confirmed: true } | { confirmed: false; reason: string };

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	/** Present for bounded commands whose process-tree settlement was observed. */
	quiescence?: CommandQuiescence;
}

/** Every git/worktree probe must finish well inside the 30 s tool/session_start budget. */
export const GIT_PROBE_TIMEOUT_MS = 5_000;

/** Optional execution bound for probes that must not hold up session startup. */
export interface CommandOptions {
	timeoutMs?: number;
}

/** Runs one argv and waits. Injected so tests drive the ledger without a git repository. */
export type CommandRunner = (argv: readonly string[], cwd: string, options?: CommandOptions) => Promise<CommandResult>;
/** The caller must distinguish an unanswerable probe from an empty answer. */
function commandFailure(argv: readonly string[], cwd: string, result: CommandResult): string {
	const detail = result.stderr.trim() || result.stdout.trim();
	return detail.length > 0 ? detail : `${argv.join(" ")} in ${cwd} exited ${result.code}`;
}

const PROCESS_GROUP_POLL_MS = 10;
const PROCESS_GROUP_WAIT_MS = 1_000;

/** POSIX process-group liveness. EPERM is alive; only ESRCH proves every member is gone. */
function processGroupAlive(pgid: number): boolean {
	if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Wait a bounded interval for SIGKILLed descendants to leave the process table. */
async function waitForProcessGroupExit(pgid: number): Promise<boolean> {
	const deadline = Date.now() + PROCESS_GROUP_WAIT_MS;
	while (processGroupAlive(pgid)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await Bun.sleep(Math.min(PROCESS_GROUP_POLL_MS, remaining));
	}
	return true;
}

/**
 * Kill a timed command and everything it started, then wait for the foreground process and its
 * process group. The group leader may already have exited; its pgid still addresses descendants.
 */
async function terminateProcessTree(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<boolean> {
	if (process.platform === "win32") {
		try {
			const killer = Bun.spawn(["taskkill", "/pid", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
			const code = await Promise.race([killer.exited, Bun.sleep(PROCESS_GROUP_WAIT_MS).then(() => null)]);
			if (code === 0) return true;
			proc.kill("SIGKILL");
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {
				// The foreground process already exited.
			}
		}
		return false;
	}
	try {
		// Timed commands are detached solely to make their pid a process-group id. SIGKILL
		// therefore reaches Worktrunk and every foreground child doing the actual mutation.
		process.kill(-proc.pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
			try {
				proc.kill("SIGKILL");
			} catch {
				// The foreground process exited between observation and fallback.
			}
		}
	}
	// `proc.exited` is deliberately not awaited: Bun or an injected runner can fail to settle
	// it even after the OS process is gone. ESRCH for the group is the stronger completion fact.
	return waitForProcessGroupExit(proc.pid);
}

/** The real runner. Failure to spawn is a result with a non-zero code, never a throw. */
export const spawnCommand: CommandRunner = async (argv, cwd, options) => {
	const timeoutMs = options?.timeoutMs;
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(argv as string[], { cwd, stdout: "pipe", stderr: "pipe", detached: timeoutMs !== undefined });
	} catch {
		return { code: 127, stdout: "", stderr: `${argv[0]} is not installed or not executable in ${cwd}` };
	}
	const result = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (timeoutMs === undefined) {
		const [stdout, stderr, code] = await result;
		return { code, stdout, stderr };
	}
	let timedOut = false;
	const terminated = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => {
		timedOut = true;
		void terminateProcessTree(proc).then(terminated.resolve, () => terminated.resolve(false));
	}, timeoutMs);
	try {
		const outcome = await Promise.race([
			result.then(values => ({ kind: "completed" as const, values })),
			terminated.promise.then(groupGone => ({ kind: "timeout" as const, groupGone })),
		]);
		if (timedOut) {
			const groupGone = outcome.kind === "timeout" ? outcome.groupGone : await terminated.promise;
			const reason = "SIGKILL was sent, but process-group disappearance could not be confirmed within 1000ms";
			const suffix = groupGone ? "" : `; ${reason}`;
			return {
				code: 124,
				stdout: "",
				stderr: `${argv[0]} timed out after ${timeoutMs}ms in ${cwd}${suffix}`,
				quiescence: groupGone ? { confirmed: true } : { confirmed: false, reason },
			};
		}
		if (outcome.kind !== "completed") {
			const reason = `termination state was uncertain in ${cwd}`;
			return { code: 124, stdout: "", stderr: `${argv[0]} ${reason}`, quiescence: { confirmed: false, reason } };
		}
		const [stdout, stderr, code] = outcome.values;
		// A wrapper can exit while a same-group child continues with ignored stdio. A timed
		// foreground command owns no post-return worker, so quiesce that residual group too.
		if (process.platform !== "win32" && processGroupAlive(proc.pid) && !(await terminateProcessTree(proc))) {
			const reason = `SIGKILL was sent, but process-group disappearance could not be confirmed within 1000ms in ${cwd}`;
			return { code: 124, stdout: "", stderr: `${argv[0]} exited and ${reason}`, quiescence: { confirmed: false, reason } };
		}
		if (process.platform === "win32") {
			const reason = "foreground exit did not confirm descendant process quiescence on Windows";
			return { code, stdout, stderr, quiescence: { confirmed: false, reason } };
		}
		return { code, stdout, stderr, quiescence: { confirmed: true } };
	} finally {
		clearTimeout(timer);
	}
};

export type RootResolution = { kind: "known"; root: string } | { kind: "unknown"; reason: string };

function unknownRoot(argv: readonly string[], cwd: string, result: CommandResult): RootResolution {
	return { kind: "unknown", reason: commandFailure(argv, cwd, result) };
}

function gitOverride(): string | undefined {
	for (const name of ["GIT_DIR", "GIT_WORK_TREE"] as const) {
		const value = process.env[name]?.trim();
		if (value !== undefined && value.length > 0) return `${name}=${value}`;
	}
	return undefined;
}

/**
 * The absolute canonical checkout containing `cwd`: the parent of the git common directory,
 * which every linked worktree of a repository shares. An unknown result is never a root: callers
 * must refuse rather than silently redirecting a ledger operation to `cwd`.
 */
export async function canonicalRoot(cwd: string, run: CommandRunner = spawnCommand): Promise<RootResolution> {
	const override = gitOverride();
	if (override !== undefined) return { kind: "unknown", reason: `refusing git environment override ${override}; it may identify a foreign repository` };
	const argv = ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"] as const;
	const result = await run(argv, cwd, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	if (result.code !== 0) return unknownRoot(argv, cwd, result);
	const common = result.stdout.trim();
	// `--path-format=absolute` promises an absolute path, so anything else is not a common dir
	// and must not be turned into a root: a guessed root would send every `bd` call elsewhere.
	if (!path.isAbsolute(common)) return { kind: "unknown", reason: `git returned a non-absolute common directory for ${cwd}: ${common || "(empty output)"}` };
	return { kind: "known", root: path.dirname(common) };
}

/**
 * The absolute root of the working tree containing `cwd`: the linked worktree an agent works
 * in, which is *not* canonical. An unknown result is never a working tree: callers must refuse
 * rather than guessing one.
 */
export async function worktreeRoot(cwd: string, run: CommandRunner = spawnCommand): Promise<RootResolution> {
	const argv = ["git", "rev-parse", "--path-format=absolute", "--show-toplevel"] as const;
	const result = await run(argv, cwd, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	if (result.code !== 0) return unknownRoot(argv, cwd, result);
	const top = result.stdout.trim();
	// As in `canonicalRoot`: `--path-format=absolute` promises an absolute path, and anything
	// else is not a working tree and must not be turned into one.
	return path.isAbsolute(top) ? { kind: "known", root: top } : { kind: "unknown", reason: `git returned a non-absolute worktree for ${cwd}: ${top || "(empty output)"}` };
}

/** One `git worktree list --porcelain -z` record: `branch` is `null` when detached or bare. */
export interface WorktreeEntry {
	path: string;
	branch: string | null;
}

/** The argv every worktree read uses. `-z` is load-bearing; see this module's header. */
export const WORKTREE_LIST_ARGV: readonly string[] = ["git", "worktree", "list", "--porcelain", "-z"];

/**
 * Every worktree `git worktree list --porcelain -z` reports, canonical included, in order, each
 * with the branch of *its own* record. Path and branch are never read apart: a claim that
 * matched them against two different records would brand a transposed pair.
 *
 * `-z` terminates every attribute with a NUL and ends each record with an empty attribute, so
 * a record boundary is a fact of the stream rather than a guess about which bytes in a path
 * might be a line break. An attribute arriving outside a record is dropped rather than
 * attributed to the record before it.
 */
export function parseWorktreeEntries(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | undefined;
	for (const attribute of stdout.split("\0")) {
		if (attribute.length === 0) {
			current = undefined;
			continue;
		}
		if (attribute.startsWith("worktree ")) {
			const value = attribute.slice("worktree ".length);
			current = value.length === 0 ? undefined : { path: value, branch: null };
			if (current !== undefined) entries.push(current);
			continue;
		}
		if (current === undefined || current.branch !== null || !attribute.startsWith("branch ")) continue;
		const ref = attribute.slice("branch ".length);
		const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		if (branch.length > 0) current.branch = branch;
	}
	return entries;
}

/** The bead an `omp/agent/<bead>` branch names, or `null` for any other branch. */
export function agentBeadOf(branch: string): string | null {
	const match = /^omp\/agent\/(?<bead>[^\s/]+(?:\/[^\s/]+)*)$/u.exec(branch);
	return match?.groups?.bead ?? null;
}

/**
 * What an unscoped `wt step prune` would remove, as its own JSON. This is a *precondition
 * probe*, never a removal: a repository whose prune would touch anything is a repository where
 * a sweep of ours could race a human's or another project's worktree, so the sweep stands down
 * and reports instead. `--dry-run --format json` prints `[]` when nothing is due.
 */
export async function pruneCandidates(canonical: string, run: CommandRunner = spawnCommand): Promise<{ clear: boolean; named: string[] }> {
	const argv = ["wt", "-C", canonical, "step", "prune", "--dry-run", "--format", "json"] as const;
	const result = await run(argv, canonical, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	if (result.code !== 0) return { clear: false, named: [`wt step prune --dry-run failed in ${canonical}: ${commandFailure(argv, canonical, result)}`] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout.trim() || "[]");
	} catch {
		return { clear: false, named: [`wt step prune --dry-run printed output this build cannot parse: ${result.stdout.trim().slice(0, 200)}`] };
	}
	if (!Array.isArray(parsed)) return { clear: false, named: ["wt step prune --dry-run printed a non-array payload"] };
	const named = parsed.map(entry => {
		if (entry !== null && typeof entry === "object") {
			const record = entry as Record<string, unknown>;
			for (const key of ["branch", "path", "worktree", "name"]) {
				const value = record[key];
				if (typeof value === "string" && value.length > 0) return value;
			}
		}
		return JSON.stringify(entry);
	});
	return { clear: named.length === 0, named };
}

/** A list probe has a typed failure so an empty repository cannot be confused with an unreadable one. */
export type WorktreeListResult = { kind: "known"; entries: WorktreeEntry[] } | { kind: "unknown"; reason: string };

export async function projectWorktreeEntries(cwd: string, run: CommandRunner = spawnCommand): Promise<WorktreeListResult> {
	const result = await run(WORKTREE_LIST_ARGV, cwd, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	return result.code === 0 ? { kind: "known", entries: parseWorktreeEntries(result.stdout) } : { kind: "unknown", reason: `git worktree list failed in ${cwd}: ${commandFailure(WORKTREE_LIST_ARGV, cwd, result)}` };
}

/**
 * `target` resolved through symlinks as far as it exists. A path that does not exist yet
 * still resolves its deepest existing ancestor, so containment cannot be defeated by naming
 * a file inside a symlinked directory.
 */
export function resolveDeepest(target: string): string {
	let current = path.resolve(target);
	const tail: string[] = [];
	for (;;) {
		try {
			return path.join(realpathSync(current), ...tail.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(target);
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

/** A registered path is usable only while its recorded directory still exists. */
function isExistingDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** Whether `target` is `root` or sits underneath it, compared by realpath, never lexically. */
export function isInside(target: string, root: string): boolean {
	const a = resolveDeepest(target);
	const b = resolveDeepest(root);
	return a === b || a.startsWith(b + path.sep);
}

export type WorktreeCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Validate a claimant-supplied worktree for `bead`. Nothing is created here: the agent
 * creates its worktree with `wt switch` and passes it in, so the ledger never has to guess a
 * base branch, and a claim can be refused before it is taken rather than rolled back after.
 */
export function checkWorktree(input: { bead: string; worktree: string; branch: string; canonical: string; worktrees: readonly WorktreeEntry[] }): WorktreeCheck {
	const expected = agentBranch(input.bead);
	if (input.branch !== expected) return { ok: false, reason: `branch must be ${expected}, not ${input.branch}` };
	if (!path.isAbsolute(input.worktree)) return { ok: false, reason: `worktree must be an absolute path, not ${input.worktree}` };
	if (isInside(input.worktree, input.canonical)) return { ok: false, reason: `${input.worktree} is inside the canonical checkout ${input.canonical}; a bead's work never mutates canonical` };
	const match = input.worktrees.find(candidate => resolveDeepest(candidate.path) === resolveDeepest(input.worktree));
	if (match === undefined) return { ok: false, reason: `${input.worktree} is not a worktree of this repository (git worktree list does not report it). Create it with \`wt switch -y --create --no-cd --base <base> --format json ${expected}\`` };
	if (!isExistingDirectory(match.path)) return { ok: false, reason: `${match.path} is a registered worktree, but its directory was deleted; recreate it before claiming ${expected}` };
	const where = match.branch === null ? "a detached HEAD" : match.branch;
	if (match.branch !== expected) return { ok: false, reason: `${input.worktree} is checked out on ${where}, not ${expected}; git worktree list must report this path and this branch in one record. Check you passed your own bead's worktree, not another worker's` };
	return { ok: true, path: match.path };
}

/** Validate a lead-supplied integration worktree before any bind writes. */
export function checkLeadWorktree(input: { epic: string; worktree: string; canonical: string; worktrees: readonly WorktreeEntry[] }): WorktreeCheck {
	if (!path.isAbsolute(input.worktree)) return { ok: false, reason: `worktree must be an absolute path, not ${input.worktree}` };
	if (isInside(input.worktree, input.canonical)) return { ok: false, reason: `${input.worktree} is inside the canonical checkout ${input.canonical}; canonical's working tree is never mutated` };
	const match = input.worktrees.find(candidate => resolveDeepest(candidate.path) === resolveDeepest(input.worktree));
	if (match === undefined) return { ok: false, reason: `${input.worktree} is not a worktree of this repository (git worktree list does not report it)` };
	if (!isExistingDirectory(match.path)) return { ok: false, reason: `${match.path} is a registered worktree, but its directory was deleted; recreate it before binding integration files` };
	const expected = integrationBranch(input.epic);
	if (match.branch !== expected) {
		const where = match.branch === null ? "a detached HEAD" : match.branch;
		return { ok: false, reason: `${input.worktree} is checked out on ${where}, not ${expected}; git worktree list must report this exact path and integration branch in one record` };
	}
	return { ok: true, path: match.path };
}

export interface WorktreeRemovalResult extends CommandResult {
	quiescence: CommandQuiescence;
}

/** Remove a bead's worktree and branch without destructive force flags. */
export async function removeWorktree(canonical: string, branch: string, run: CommandRunner = spawnCommand): Promise<WorktreeRemovalResult> {
	const result = await run(["wt", "-C", canonical, "remove", "-y", "--foreground", branch], canonical, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	if (result.quiescence !== undefined) return { ...result, quiescence: result.quiescence };
	if (result.code === 124) {
		return { ...result, quiescence: { confirmed: false, reason: "the command runner returned timeout status without confirming process-group disappearance" } };
	}
	return { ...result, quiescence: { confirmed: true } };
}

/** The independently observed state after `wt remove`; probe failures stay explicit. */
export interface RemovalResidue {
	worktree: boolean;
	path: boolean;
	branch: boolean;
	registeredBranch?: string | null;
	branchCheckedOutAt?: string;
	branchMerged?: boolean;
	worktreeError?: string;
	branchError?: string;
	mergeError?: string;
	pathError?: string;
	quiescenceError?: string;
}

/** Read registration, pathname entry, branch existence, merge, and checkout state independently. */
export async function removalResidue(canonical: string, worktreePath: string, branch: string, run: CommandRunner = spawnCommand): Promise<RemovalResidue> {
	const list = await run(WORKTREE_LIST_ARGV, canonical, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	const entries = list.code === 0 ? parseWorktreeEntries(list.stdout) : [];
	const target = resolveDeepest(worktreePath);
	const registered = entries.find(entry => resolveDeepest(entry.path) === target);
	const checkedOut = entries.find(entry => entry.branch === branch);
	const branchArgv = ["git", "branch", "--list", branch] as const;
	const branches = await run(branchArgv, canonical, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
	const branchPresent = branches.code === 0 && branches.stdout.trim().length > 0;
	const mergedArgv = ["git", "branch", "--merged", "HEAD", "--list", branch] as const;
	const merged = branchPresent ? await run(mergedArgv, canonical, { timeoutMs: GIT_PROBE_TIMEOUT_MS }) : undefined;
	let pathPresent = true;
	let pathError: string | undefined;
	try {
		lstatSync(worktreePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") pathPresent = false;
		else pathError = error instanceof Error ? `${code ?? error.name}: ${error.message}` : String(error);
	}
	return {
		worktree: list.code !== 0 || registered !== undefined,
		path: pathPresent,
		branch: branches.code !== 0 || branchPresent,
		...(registered === undefined ? {} : { registeredBranch: registered.branch }),
		...(checkedOut === undefined ? {} : { branchCheckedOutAt: checkedOut.path }),
		...(merged?.code === 0 ? { branchMerged: merged.stdout.trim().length > 0 } : {}),
		...(list.code === 0 ? {} : { worktreeError: commandFailure(WORKTREE_LIST_ARGV, canonical, list) }),
		...(branches.code === 0 ? {} : { branchError: commandFailure(branchArgv, canonical, branches) }),
		...(merged === undefined || merged.code === 0 ? {} : { mergeError: commandFailure(mergedArgv, canonical, merged) }),
		...(pathError === undefined ? {} : { pathError }),
	};
}

/** Truthful, non-destructive remediation for the exact residue that was observed. */
export function residueRemediation(canonical: string, worktreePath: string, branch: string, residue: RemovalResidue): string {
	const steps: string[] = [];
	if (residue.quiescenceError !== undefined) steps.push(`process quiescence could not be confirmed: ${residue.quiescenceError}; the immediate absence snapshot is not final, so retain the brand and inspect again`);
	if (residue.worktreeError !== undefined) steps.push(`worktree registration could not be observed: ${residue.worktreeError}`);
	else if (residue.worktree) {
		if (residue.registeredBranch !== branch) {
			const owner = residue.registeredBranch === null ? "a detached HEAD" : (residue.registeredBranch ?? "an unknown branch");
			steps.push(`the path ${worktreePath} is now registered on ${owner}, not ${branch}; leave it for its owner`);
		} else if (residue.pathError !== undefined) steps.push(`git registers ${worktreePath} on ${branch}, but pathname state could not be observed: ${residue.pathError}; leave it untouched`);
		else if (residue.path) steps.push(`the worktree ${worktreePath} is still registered on ${branch}: confirm its owner is not live, commit or discard its changes, then \`wt -C ${canonical} remove -y --foreground ${branch}\``);
		else steps.push(`git still registers ${worktreePath} on ${branch}, but the path is absent; confirm its owner is not live, then inspect and repair the stale worktree registration`);
	} else if (residue.pathError !== undefined) steps.push(`pathname state could not be observed for ${worktreePath}: ${residue.pathError}; leave it untouched`);
	else if (residue.path) steps.push(`the path ${worktreePath} exists without a worktree registration; it may have been recreated by another process, so leave it until its owner is identified`);
	if (residue.branchError !== undefined) steps.push(`branch state could not be observed: ${residue.branchError}`);
	else if (residue.branch) {
		if (residue.branchCheckedOutAt !== undefined) steps.push(`the branch ${branch} is checked out at ${residue.branchCheckedOutAt}; leave it for that worktree's owner`);
		else if (residue.worktreeError !== undefined) steps.push(`the branch ${branch} exists, but checkout state could not be observed; do not delete it`);
		else if (residue.mergeError !== undefined || residue.branchMerged === undefined) steps.push(`the branch ${branch} exists and is not checked out, but merge state could not be observed${residue.mergeError === undefined ? "" : `: ${residue.mergeError}`}; inspect it before deciding whether to delete it`);
		else if (residue.branchMerged) steps.push(`the branch ${branch} exists, is not checked out, and is merged into canonical HEAD; delete it with \`git -C ${canonical} branch -d ${branch}\``);
		else steps.push(`the branch ${branch} exists, is not checked out, and is not merged into canonical HEAD; merge it, or drop it deliberately with \`wt -C ${canonical} remove -y -D ${branch}\``);
	}
	return steps.join("; ");
}
