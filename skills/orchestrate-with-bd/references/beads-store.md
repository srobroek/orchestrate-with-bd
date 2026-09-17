# Beads store

The run's ledger is one Beads database on the machine's shared Dolt server. `bd` finds it
from the tracked `.beads/metadata.json`. Every clone OMP makes for an isolated worker
therefore reads and writes the primary checkout's database. A claim made in a clone is
visible in the primary the moment `bd` returns. No environment variable, redirect file, or
clone directory takes part in that. It is the whole reason the store lives on the server.

Everything below follows from that.

## Mode

`.beads/metadata.json` pins `"dolt_mode": "server"` and names the database in
`dolt_database`; `.beads/config.yaml` carries `dolt.shared-server: true`. The server runs
from `~/.beads/shared-server/` on port 3308.

`bd dolt status` prints `Mode: shared server` when the project is in this mode.

Three carriers can turn shared-server mode on, with different results on bd 1.3.0:

| Carrier | `bd init` result | Effect on an embedded project |
|---|---|---|
| `bd init --shared-server` | complete: server database created | none |
| `BEADS_DOLT_SHARED_SERVER=true` in the environment | complete | every `bd` command fails with `database not found` |
| `dolt.shared-server: true` in `~/.config/bd/config.yaml` | incomplete: `metadata.json` says server, but `bd` creates no database | same failure |

Unless `dolt_mode` is `server`, the plugin's ledger tools refuse to write. A native isolated
clone copies `.beads/embeddeddolt/`, and a worker in that clone would write to a fork nobody
reads.

## Migrate an embedded project

The gates below are evidence, not intent. The run header reports all five and admits the
session only when every blocking one is met. Under a STOP-only header a lead reports this
route and ends its turn: it never migrates, never edits `.beads/`, and never dispatches an
agent to do so. An admitted session migrates and does nothing else — no bead, no skill, no
dispatch — and the plugin refuses every command outside the bounded list below.

| Gate | Evidence |
|---|---|
| `bd-stable` | `bd --version` reports a stable 1.3.0 or later. A prerelease, an `-rc`, or a `+build` suffix is refused: the route was measured against a release. |
| `clients-compatible` | `BEADS_MIGRATION_CLIENTS` names the lowest stable `bd` version any participating client runs, 1.3.0 or later. An older clone reads the migrated store wrong. |
| `backup-verified` | `.beads/dolt-backup.json` names a `file://` native backup, `.beads/dolt-backup-state.json` records a sync no earlier than that backup's `created_at`, and the directory still exists outside the checkout. |
| `designated-migrator` | `BEADS_MIGRATION_MIGRATOR=1` in the environment of the one client designated to migrate, and no other session in this process already migrating this checkout. |
| `post-verification` | Owed after the migration, never before, so it never blocks admission. The contract in the header demands it, and a mismatch is a failed migration. |

A checkout with no readable `.beads/metadata.json` is never admitted: there is no store to
migrate, and the gates would be measuring an absence.

Run every command from the project root with `BEADS_ACTOR` set. Nothing else is permitted:
read other store files with the read tool, and only `.beads/metadata.json` and
`.beads/config.yaml` may be edited.

- `<dir>`: the backup directory the `backup-verified` gate named, outside the checkout.
- `<prefix>`: `issue-prefix` from `.beads/config.yaml`, else the id prefix of an existing bead.
- `git ls-remote origin 'refs/dolt/*'`: decides between step 2 and step 3.

1. Record the bead count from `bd list --all --json`, then `bd export > issues.jsonl`, then
   `bd backup init <dir> && bd backup sync`.
2. When `origin` carries no `refs/dolt/*`, run
   `bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix <prefix>`.
   Set `dolt_mode` to `"server"` in `.beads/metadata.json`. Add `dolt.shared-server: true`
   to `.beads/config.yaml`. Then run `bd backup restore --force <dir>`.
3. When `origin` carries `refs/dolt/data`: `bd dolt push` (a refused non-fast-forward means
   `bd dolt pull` once, then push again), make the same two file edits, then
   `bd bootstrap --yes`.
4. Pending schema migrations on a remote-backed or shared store: `bd migrate --force`, then
   `bd dolt push` to publish the migrated schema. bd refuses the in-place migration without
   `--force` (#4259) because migrating two clones independently forks the schema silently and
   `bd dolt pull` can no longer merge; `--force` is how the single designated migrator
   confirms itself. The `designated-migrator` gate is what makes that claim true.
5. Verify, and treat any mismatch as a failed migration: `bd dolt status` prints
   `Mode: shared server`, `bd list --all --json` holds the pre-migration count, `bd export`
   parses equal to `issues.jsonl` ignoring `updated_at`, then `mv .beads/embeddeddolt <dir>`
   and confirm the count once more.
6. Report the counts and the verification result, and leave `.beads/config.yaml` and
   `.beads/metadata.json` uncommitted for the human. Orchestration is a later turn that finds
   the store in server mode. A clone on another machine runs `bd bootstrap` once.

## Hazards

- **Prefix overlap.** `dolt_database` defaults to the issue prefix. Two projects that share
  a prefix therefore share one database. `dolt --host 127.0.0.1 --port 3308 --user root
  --password '' --no-tls sql -q "SHOW DATABASES"` lists what the server holds. Pass a
  distinct `--prefix` to `bd init`.
- **Server stopped.** Every read and write fails closed within a second. The error is
  `Dolt server unreachable at 127.0.0.1:3308`. Nothing auto-starts. `bd dolt start` takes
  about one second from any shared-mode project. A second project's `bd init` refuses to
  start a rival server on the same port.
- **Push scope.** `bd dolt push` sends the project database only. The target is
  `sync.remote` in `.beads/config.yaml`, else `origin`. The payload is the whole database:
  bead bodies, comments, and actor strings. `bd bootstrap` on a fresh clone pulls it. It
  also repairs a hand-edited `dolt_database` from the tracked `project_id`.
- **Audit log churn.** bd appends every field change to `.beads/interactions.jsonl` in the
  cwd's `.beads`, and bd tracks that file in git by default. Each isolated worker's captured
  branch therefore carries its own appended lines, and the lead's second merge conflicts on
  it. Resolve by keeping both sides, or untrack it in projects that run isolated workers:
  `git rm --cached .beads/interactions.jsonl` and add `interactions.jsonl` to `.beads/.gitignore`.
- **Convergence.** A `cp -R` copy, a linked worktree, and a fresh `git clone` on the same
  machine all reach the same database with no environment variable. A write in any of them
  is visible in all of them.
