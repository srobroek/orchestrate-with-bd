# Beads store

The session lifecycle pins `BEADS_DIR` to the canonical checkout's `.beads`. Every linked worktree
shares that embedded ledger through the pin; `bd` calls must never pass `--db` or replace it.

## Allowlist

- The ledger is embedded Dolt (`dolt_mode: embedded`); do not start or configure a server.
- Keep the canonical `.beads` path absolute and repository-owned.
- Use `bd init --skip-hooks` for a new store and `bd bootstrap` for a clone with tracked metadata.
- Before queue work, verify `claim.pools` with `bd config show`; an unset key is not admitted.

## Stop behaviour

If `BEADS_DIR` is absent, let the session lifecycle establish it. If it points at another repository,
stop: `bdRun` reports `BEADS_DIR points at <a>, ledger tracks <b>`. Do not fall back to a local store.
For embedded write contention, follow `rule://worktrunk-bd-contention-retry`; wait and retry the same
command up to three times, then report. For store setup and recovery, follow `skill://beads-storage-mode`.

The ledger's Dolt refs are separate from Git refs. Run the explicit `bd dolt push` at run close and
check its status; ordinary `git push` is not a database push.

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
