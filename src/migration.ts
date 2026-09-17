/**
 * In-session migration of an embedded Beads store, and the gates that admit it.
 *
 * The blanket prohibition this module replaces was measured, not theoretical: twice a lead
 * on an embedded store improvised a migration out of prose and forked the schema. The
 * failure was an unbounded route on an unverified store, not the migration itself. So a
 * session may migrate only when five gates hold, and it may then run only the commands the
 * header lists. Everything else in an embedded checkout stays refused.
 *
 * The store-command recogniser lives here rather than in `index.ts` because both the
 * refusal gate and the bounded allowlist read it, and `index.ts` imports this module.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bdRun } from "./bd";

/**
 * Shell/path token boundaries. Keeping the dot in `.beads` significant prevents names such as
 * `archive.beads` from being mistaken for the store. Executable prefixes may contain path
 * separators, but a slash after `bd` means it is a directory component, not the executable.
 * Assignment boundaries apply to command and store tokens so `cmd=bd` and `dir=.beads/`
 * remain covered. The normalized candidate handles escaped spellings.
 */
const EXECUTABLE_LEADING_BOUNDARY = String.raw`[\s;&|(){}"'` + "`" + String.raw`<>/=]`;
const EXECUTABLE_TRAILING_BOUNDARY = String.raw`[\s;&|(){}"'` + "`" + String.raw`<>=]`;
const STORE_LEADING_BOUNDARY = String.raw`[\s;&|(){}"'` + "`" + String.raw`<>/=]`;
const STORE_TRAILING_BOUNDARY = String.raw`[\s;&|(){}"'` + "`" + String.raw`<>/=]`;

/** Any `bd` invocation (by basename, so `/usr/bin/bd` counts) or any `.beads` store path. In a
 * session that received the STOP header the ledger already refuses, so no `bd` command has a
 * legitimate use there, and enumerating verbs would only leave gaps (the observed
 * migration began with `bd export`). */
export const BD_OR_STORE = new RegExp(
	String.raw`(?:^|${EXECUTABLE_LEADING_BOUNDARY})(?:[^\s;&|(){}"'` + "`" + String.raw`<>/\\]*[/])*bd(?=$|${EXECUTABLE_TRAILING_BOUNDARY})|(?:^|${STORE_LEADING_BOUNDARY})\.beads(?=$|${STORE_TRAILING_BOUNDARY})`,
	"u",
);

/**
 * Reconstruct conservative shell spellings without turning quoted or escaped delimiters into
 * token boundaries. This is intentionally not expansion: it only joins continuations, removes
 * syntactic quotes, and reconstructs unquoted escapes inside protected names.
 */
const INERT_WORD_CHARACTER = "\u0000";
const QUOTED_BOUNDARY = /[\s;&|(){}"'`<>\\=$]/u;
const DOUBLE_QUOTE_ESCAPE = /[$`"\\]/u;

function normalizedCommand(command: string): string {
	let normalized = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else normalized += QUOTED_BOUNDARY.test(character) ? INERT_WORD_CHARACTER : character;
			continue;
		}
		if (character === "'" && quote === undefined) {
			quote = "'";
			continue;
		}
		if (character === '"') {
			quote = quote === '"' ? undefined : '"';
			continue;
		}
		if (character === "\\") {
			const escaped = command[index + 1];
			if (escaped === undefined) {
				normalized += INERT_WORD_CHARACTER;
				continue;
			}
			if (escaped === "\n" || (escaped === "\r" && command[index + 2] === "\n")) {
				index += escaped === "\r" ? 2 : 1;
				continue;
			}
			index++;
			if (quote === '"' && !DOUBLE_QUOTE_ESCAPE.test(escaped)) {
				normalized += QUOTED_BOUNDARY.test(escaped) ? INERT_WORD_CHARACTER : `\\${escaped}`;
			} else {
				normalized += QUOTED_BOUNDARY.test(escaped) ? INERT_WORD_CHARACTER : escaped;
			}
			continue;
		}
		if (quote !== undefined && QUOTED_BOUNDARY.test(character)) {
			normalized += quote === '"' && (character === "$" || character === "`") ? character : INERT_WORD_CHARACTER;
			continue;
		}
		normalized += character;
	}
	return normalized;
}

export function mutatesStore(command: string): boolean {
	return BD_OR_STORE.test(normalizedCommand(command));
}
/** The `bd` release the migration route was measured against; an older `bd` never migrates a store in-session. */
export const MIN_BD_VERSION: readonly [number, number, number] = [1, 3, 0];

/**
 * The stable release a version string names, or `null` when it names none. `bd version
 * 1.3.0 (f45b249ce)` parses; `1.3.0-rc.1`, `1.3.0+dev`, `1.3.0.2`, and a bare `dev` do not,
 * because a prerelease or a local build is not the release the route was measured against
 * and a migration it half-runs cannot be un-run.
 */
export function parseStableVersion(output: string): [number, number, number] | null {
	const match = /(?<![\w.+-])v?(\d+)\.(\d+)\.(\d+)(?![\w.+-])/u.exec(output);
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `output` names a stable release at or above `MIN_BD_VERSION`. */
export function stableAtLeast(output: string): boolean {
	const version = parseStableVersion(output);
	if (version === null) return false;
	for (let part = 0; part < MIN_BD_VERSION.length; part++) {
		if (version[part] !== MIN_BD_VERSION[part]) return version[part] > MIN_BD_VERSION[part];
	}
	return true;
}

/**
 * One migration gate. `after` is the post-migration verification: it is an obligation the
 * contract states, never a precondition, so it is reported and never blocks admission.
 */
export interface MigrationGate {
	name: string;
	state: "met" | "missing" | "after";
	detail: string;
}

/** Whether every blocking gate is met. No gates at all is never eligible: an absent measurement is not a pass. */
export function migrationEligible(gates: readonly MigrationGate[] | undefined): boolean {
	return gates !== undefined && gates.length > 0 && gates.every(gate => gate.state !== "missing");
}

/**
 * The environment names the one client designated to migrate and the releases the other
 * clients run. Deliberately the environment and not `.beads/config.yaml` or a committed
 * file: a clone inherits a committed value and would read itself as the designated migrator.
 */
const CLIENTS_ENV = "BEADS_MIGRATION_CLIENTS";
const MIGRATOR_ENV = "BEADS_MIGRATION_MIGRATOR";

/** A verified full native backup at `root`, or why there is none. */
export type BackupEvidence = { dir: string } | { missing: string };

/**
 * Evidence that a restorable native backup exists outside the checkout. `bd backup init`
 * writes `.beads/dolt-backup.json` and `bd backup sync` writes `.beads/dolt-backup-state.json`;
 * the pair is evidence only when the backup is a local native one (`file://`), a sync landed
 * no earlier than the backup was created, and the directory still exists outside the
 * checkout — a backup inside it is destroyed by the same `--reinit-local` it exists to undo.
 */
export function backupEvidence(root: string): BackupEvidence {
	let backup: unknown;
	let state: unknown;
	try {
		backup = JSON.parse(readFileSync(path.join(root, ".beads", "dolt-backup.json"), "utf8"));
		state = JSON.parse(readFileSync(path.join(root, ".beads", "dolt-backup-state.json"), "utf8"));
	} catch {
		return { missing: "no readable .beads/dolt-backup.json and .beads/dolt-backup-state.json; run `bd backup init <dir> && bd backup sync`" };
	}
	if (typeof backup !== "object" || backup === null || typeof state !== "object" || state === null) {
		return { missing: "the backup records are not JSON objects" };
	}
	const url = "backup_url" in backup ? backup.backup_url : undefined;
	const created = "created_at" in backup ? backup.created_at : undefined;
	const synced = "last_sync" in state ? state.last_sync : undefined;
	if (typeof url !== "string" || !url.startsWith("file://")) return { missing: "backup_url names no local native backup" };
	if (typeof created !== "string" || typeof synced !== "string" || !(Date.parse(synced) >= Date.parse(created))) {
		return { missing: "the backup records no sync at or after its own creation; run `bd backup sync`" };
	}
	let dir: string;
	try {
		dir = fileURLToPath(url);
	} catch {
		return { missing: `backup_url is not a usable path: ${url}` };
	}
	if (!existsSync(dir)) return { missing: `the backup directory is gone: ${dir}` };
	const inside = path.resolve(dir) === path.resolve(root) || path.resolve(dir).startsWith(path.resolve(root) + path.sep);
	if (inside) return { missing: `the backup is inside the checkout and the reinit would take it too: ${dir}` };
	return { dir };
}

/** Who is asking, so the gates can serialize one designated migrator per checkout. */
export interface MigrationAsk {
	session: string;
	/** The session this checkout's migrator slot is already reserved for, when one holds it. */
	designated?: string;
	env?: Record<string, string | undefined>;
}

/**
 * The five gates that decide whether this session may migrate the embedded store at `root`.
 * Four carry evidence: the local `bd` release is measured from the binary, the participating
 * clients and the designated migrator are explicit environment signals, and the backup is
 * read from what `bd backup` wrote. The fifth is the post-migration verification, which
 * cannot exist yet, so it is reported as owed and never blocks.
 *
 * A store the plugin cannot read has no gates at all and stays refused: eligibility is
 * never inferred from an absent file.
 */
export async function migrationGates(root: string, ask: MigrationAsk): Promise<MigrationGate[]> {
	const env = ask.env ?? process.env;
	// `bd --version` is measured, never declared: the release the route was tested against
	// is the one this session would actually run. A missing or failing binary is simply not it.
	let local: string | null = null;
	try {
		const reported = await bdRun(["--version"], root, {}, 5_000);
		local = reported.code === 0 ? reported.stdout : null;
	} catch {
		local = null;
	}
	const clients = (env[CLIENTS_ENV] ?? "").trim();
	const backup = backupEvidence(root);
	const designated = (env[MIGRATOR_ENV] ?? "").trim() === "1";
	const floor = MIN_BD_VERSION.join(".");
	const taken = ask.designated !== undefined && ask.designated !== ask.session;
	return [
		local !== null && stableAtLeast(local)
			? { name: "bd-stable", state: "met", detail: `bd reports ${local.trim()}` }
			: { name: "bd-stable", state: "missing", detail: `bd must report a stable ${floor} or later; it reports ${local === null ? "nothing runnable" : local.trim()}` },
		stableAtLeast(clients)
			? { name: "clients-compatible", state: "met", detail: `${CLIENTS_ENV}=${clients}` }
			: { name: "clients-compatible", state: "missing", detail: `set ${CLIENTS_ENV} to the lowest stable bd version every participating client runs, ${floor} or later; it is ${clients === "" ? "unset" : clients}` },
		"dir" in backup
			? { name: "backup-verified", state: "met", detail: `native backup synced at ${backup.dir}` }
			: { name: "backup-verified", state: "missing", detail: backup.missing },
		designated && !taken
			? { name: "designated-migrator", state: "met", detail: `${MIGRATOR_ENV}=1 and no other session in this process is migrating this checkout` }
			: {
					name: "designated-migrator",
					state: "missing",
					detail: taken ? `session ${ask.designated} is already the designated migrator for this checkout` : `set ${MIGRATOR_ENV}=1 in the environment of the one client designated to migrate`,
				},
		{
			name: "post-verification",
			state: "after",
			detail: "owed after the migration, never before: the bead count from `bd list --all --json` and `bd export` equal to issues.jsonl ignoring updated_at, and that count again once `.beads/embeddeddolt` is out of the checkout",
		},
	];
}

/**
 * What an admitted migration session is told instead of the lead contract. It names no skill
 * and no bead: the session's whole job is the migration, and the header lists every command
 * it may run, because the observed failure was a lead improvising a route out of prose.
 */
export const MIGRATION_CONTRACT = [
	"MIGRATE, then stop. This checkout's Beads store is embedded and every blocking gate above is met, so this session runs the migration itself. It does nothing else: no skill to read, no bead to create, no agent to dispatch. Every ledger tool and every `task` call is refused here, and so is every command this header does not list.",
	"- Run only these, one per call: `bd --version`; `bd export > issues.jsonl`; `bd backup init <dir>`; `bd backup sync`; `bd backup restore --force <dir>`; `bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix <prefix>`; `bd bootstrap --yes`; `bd dolt status|start|push|pull`; `bd migrate --force`; `bd list --all --json`; `mv .beads/embeddeddolt <dir>`. Only `.beads/metadata.json` and `.beads/config.yaml` may be edited. Read every other store file with the read tool: a shell command naming `bd` or `.beads/` in any other shape is refused, and so is any command carrying a shell expansion, a subshell, a substitution, or an input redirect.",
	"- Record the pre-migration bead count from `bd list --all --json` and write `bd export > issues.jsonl` before anything else. `<prefix>` is `issue-prefix` from `.beads/config.yaml`, else the id prefix of an existing bead. `<dir>` is the backup directory the `backup-verified` gate above names.",
	"- Then `git ls-remote origin 'refs/dolt/*'` decides the route. No `refs/dolt/*`: `bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix <prefix>`, set `dolt_mode` to `\"server\"` in `.beads/metadata.json`, add `dolt.shared-server: true` to `.beads/config.yaml`, then `bd backup restore --force <dir>`. With `refs/dolt/data`: `bd dolt push` (a refused non-fast-forward means one `bd dolt pull`, then push again), the same two file edits, then `bd bootstrap --yes`.",
	"- Pending schema migrations on the remote-backed store: `bd migrate --force`, which is how the single designated migrator confirms itself, then `bd dolt push` to publish the migrated schema. Running it in two clones independently forks the schema silently, which is exactly what the `designated-migrator` gate serializes.",
	"- Verify before reporting and treat any mismatch as a failed migration: `bd dolt status` prints `Mode: shared server`, `bd list --all --json` holds the pre-migration count, `bd export` parses equal to `issues.jsonl` ignoring `updated_at`, and that count holds once more after `mv .beads/embeddeddolt <dir>`.",
	"- Then stop. Report the pre- and post-migration counts, the verification result, and that `.beads/metadata.json` and `.beads/config.yaml` are left uncommitted for the human. Orchestration is a later turn that finds the store in server mode; nothing is dispatched in this one.",
].join("\n");

/**
 * The commands a migration session may run, each anchored over one pipeline segment. An
 * allowlist, not a denylist: this is the only sanctioned route, and a denylist over a route
 * that starts with `bd init --reinit-local` would only leave gaps.
 */
const MIGRATION_COMMANDS: readonly RegExp[] = [
	/^bd --version$/u,
	/^bd export(?:\s*>\s*(?!\S*\.beads)[\w./-]+)?$/u,
	/^bd backup init (?!\S*\.beads)[\w./-]+$/u,
	/^bd backup sync$/u,
	/^bd backup restore --force (?!\S*\.beads)[\w./-]+$/u,
	/^bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix [\w-]+$/u,
	/^bd bootstrap(?: --yes)?$/u,
	/^bd dolt (?:status|start|push|pull)$/u,
	/^bd migrate --force(?: --yes| --json)*$/u,
	/^bd list --all --json$/u,
	/^mv \.beads\/embeddeddolt (?!\S*\.beads)[\w./-]+$/u,
];

/**
 * A shell expansion, a subshell, a command substitution, or an input redirect. Any of them
 * makes a segment unreadable as a shape, so a segment carrying one is never bounded:
 * `bd${IFS}delete x` must not pass for want of a literal `bd ` prefix.
 */
const UNBOUNDED = /[`$()<]/u;

/** Pipeline and list separators, so each shape is matched against one command, not a chain. */
const SEGMENT = /\s*(?:\|\||&&|[;\n|&])\s*/u;

/**
 * Whether `command` is one of the bounded migration shapes. Expansions fail closed first,
 * over every segment, before any shape is tried. A segment that names neither `bd` nor
 * `.beads/` is what any session may already run (`git ls-remote`, `jq length`), so it is
 * left alone; a segment that names either must match a shape exactly.
 */
export function boundedMigration(command: string): boolean {
	const segments = normalizedCommand(command)
		.split(SEGMENT)
		.map(segment => segment.trim())
		.filter(segment => segment.length > 0);
	if (segments.length === 0) return false;
	if (segments.some(segment => UNBOUNDED.test(segment))) return false;
	return segments.every(segment => !BD_OR_STORE.test(segment) || MIGRATION_COMMANDS.some(shape => shape.test(segment)));
}

/** The two store files a migration session may edit: `dolt_mode` and `dolt.shared-server` live in them. */
export const MIGRATION_FILES = /(?:^|[\\/])\.beads[\\/](?:metadata\.json|config\.yaml)$/u;
