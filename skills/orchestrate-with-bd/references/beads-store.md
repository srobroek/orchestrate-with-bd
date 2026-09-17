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

A human runs this. A lead that finds an embedded store reports this route and ends its
turn. It never migrates, never edits `.beads/`, and never dispatches an agent to do so.

Run every command from the project root with `BEADS_ACTOR` set.

- `<dir>`: a backup directory outside the checkout.
- `<prefix>`: the id prefix of any existing bead.
- `git ls-remote origin 'refs/dolt/*'`: decides between step 2 and step 3.

1. `bd export > issues.jsonl`, then `bd backup init <dir> && bd backup sync`.
2. When `origin` carries no `refs/dolt/*`, run
   `bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix <prefix>`.
   Set `dolt_mode` to `"server"` in `.beads/metadata.json`. Add `dolt.shared-server: true`
   to `.beads/config.yaml`. Then run `bd backup restore --force <dir>`.
3. When `origin` carries `refs/dolt/data`: `bd dolt push` (a refused non-fast-forward means
   `bd dolt pull` once, then push again), make the same two file edits, then
   `bd bootstrap --yes`.
4. Verify: `bd list --all --json | jq length` equals the pre-migration count and `bd export`
   parses equal to `issues.jsonl` ignoring `updated_at`. Move `.beads/embeddeddolt` out of
   the checkout and confirm the count once more.
5. Commit `.beads/config.yaml` and `.beads/metadata.json`. A clone on another machine runs
   `bd bootstrap` once.

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
