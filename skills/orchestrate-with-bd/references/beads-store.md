# Beads store

The run's ledger is **one embedded Dolt database in the canonical checkout's `.beads`**. Every
linked worktree of the repository reaches that same database: `bd` walks up from its cwd, and
when a worktree has no database of its own it resolves the shared one through the repository's
git common directory. No environment variable, no redirect file, and no copied database takes
part in that. A claim made in a worktree is visible everywhere the moment `bd` returns.

Nothing in a run pins the store. `BEADS_DIR` is the highest-priority branch of bd's discovery, so
a stale pin silently redirects every write; the plugin strips it from its own `bd` spawns and no
agent sets it.

## Mode

`.beads/metadata.json` carries `"database": "dolt"`, `"backend": "dolt"`, `"dolt_mode":
"embedded"`, and a `dolt_database` named from the issue prefix with hyphens replaced by
underscores. `.beads/config.yaml` does not enable `dolt.shared-server`. `.beads/embeddeddolt/`
holds the database; there is no `.beads/dolt/` and no server process.

Never remove `dolt_database`: a missing value defaults to `beads` while the database is named
from the prefix, and a name mismatch makes every reopen fail.

Three environment variables re-enable server mode ahead of the files and must be unset in every
shell, launcher, and OMP config that runs `bd`: `BEADS_DOLT_SERVER_MODE`,
`BEADS_DOLT_SHARED_SERVER`, `BEADS_DOLT_SERVER_HOST`.

A new project gets an embedded store from plain `bd init --skip-hooks` (add `--prefix <p>`); a
clone with the tracked config and no database runs `bd bootstrap` once.

## Claim pools

Store `claim.pools` as a project-level, comma-separated database key. `bd config show` reports its provenance as `(database)`.

Use no environment override or file fallback.
Before a run depends on queues, verify that `claim.pools` is set. A run with the key unset is not admitted.

## Contention

Embedded Dolt is **single-writer and file-locked**, so two concurrent `bd` writes are expected to
collide, and a collision is not an error to escalate. `rule://worktrunk-bd-contention-retry`
owns the response: wait briefly and retry the same command, up to three attempts, then report.
The verbatim texts it fires on are

- `a maintenance operation is running on this workspace: retry when it completes`
- `other bd commands are using this workspace: wait for them to finish and retry`
- `lock busy: held by another process`
- `lock already held by another process`
- `workspace gate busy`

`warning: workspace gate unavailable, continuing ungated` and `warning: workspace gate acquisition
failed, continuing ungated` are **not** contention: the command ran. Do not retry on them.

There is no write serialization, no mutex, and no retry wrapper in this plugin. Agents call `bd`
directly.

## Durability

`git push` does not carry `refs/dolt/data`: the branch and the database are separate refspaces.
The run's ledger therefore travels through one **explicit** `bd dolt push` from the canonical
checkout at run close, with its exit status checked and surfaced (`references/landing.md`, step
12). No `wt` or git hook performs it, and `bd export` is not a substitute — a JSONL export holds
issue records, not Dolt branches, history, working-set state, or the non-issue tables.

`bd dolt push` sends the whole project database: bead bodies, comments, and actor strings. Its
target is `sync.remote` in `.beads/config.yaml`, else `origin`. A refused non-fast-forward means
`bd dolt pull` once, then push again.

## Diagnostics

`bd doctor` is narrower under embedded Dolt. Full diagnostics and `--perf`, `--deep`, `--server`,
`--migration`, and `--check=validate` require server mode and are unavailable. Embedded supports
`--check=artifacts`, `--check=conventions`, and `--check=pollution`, and doctor keeps a single
`--check` value, so each one is its own command:

```sh
bd doctor --check=artifacts
bd doctor --check=conventions
bd doctor --check=pollution
```

## Hazards

- **Prefix overlap.** `dolt_database` is derived from the issue prefix. Two projects that share a
  prefix name the same database; pass a distinct `--prefix` to `bd init`.
- **Audit log churn.** bd appends every field change to `.beads/interactions.jsonl` in the cwd's
  `.beads` and tracks that file in git by default. Because every agent branch can carry appended
  lines, a merge conflicts on it: keep both sides, or untrack it
  (`git rm --cached .beads/interactions.jsonl`, then add `interactions.jsonl` to
  `.beads/.gitignore`).
- **Never re-initialise to repair.** `bd init --reinit-local` is a destructive local
  reinitialisation, not a mode fix, and re-init inherits the existing connection mode. A store
  that will not open is a restore-from-backup problem, not an init problem.
