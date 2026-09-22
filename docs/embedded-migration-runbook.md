# Embedded Dolt procedure

This procedure preserves the source until the embedded store passes parity. Run it for one Beads store at a time. Replace each angle-bracket value with an absolute path or store value.

## Preconditions

1. Designate one operator.
2. Quiesce every checkout that resolves to this store.
3. Include every linked worktree.
4. Check sessions with `hub list` and `hub ps`.
5. Stop or release every active writer.

A live writer makes a filesystem copy unsafe.

Run these commands from the store's canonical checkout:

```sh
bd where
jq -r '.dolt_mode' .beads/metadata.json
jq -r '.dolt_database' .beads/metadata.json
bd dolt status
```

Check `.beads/metadata.json`. The `dolt_mode` value must be `server`. If it is `embedded`, stop because the store already uses embedded mode. If `bd where` or `bd dolt status` identifies another store, stop.

Before changing anything, capture the source parity inputs:

```sh
bd count --include-infra --json
bd list --all --include-templates --include-gates --include-infra --limit 0 --json
bd export --all --output <backup-dir>/source.all.jsonl
git -C <repo> ls-remote "<sync-remote>" 'refs/dolt/data*'
```

A returned ref proves that the remote endpoint responded and contains Dolt history. An empty result without a confirmed endpoint response is inconclusive. Treat an authentication or transport error as inconclusive. Stop.

Before continuing, unset these variables in the `bd` shell:

- `BEADS_DOLT_SERVER_MODE`
- `BEADS_DOLT_SHARED_SERVER`
- `BEADS_DOLT_SERVER_HOST`

Check that the shell profile and every launcher also unset these variables. They outrank `metadata.json`.

## Staging rule

Create the backup and destination outside the repository. Keep the repository's `.beads` directory untouched until parity passes. This order prevents destructive operations from destroying the only live copy.

The source directory stays authoritative through G7. The staged directory receives scratch removal and compaction. The operator compares counts and exports twice. Comparisons precede G8 metadata movement. A staged failure leaves the source available for rollback.
Keep the source copy until G8 parity passes.

A staged failure leaves the source unchanged. The failed stage remains available for inspection, and the command remains recorded. The source remains authoritative through count and latency checks.


The source and stage have different roles:

- Source: the last known-good copy. Leave it untouched during staging.
- Staged directory: receives scratch removal and compaction.
- Cache removal and garbage collection: belong only to the staged tree. They can reclaim objects.
- Metadata: stage it separately so a malformed config cannot make the source unreachable.
- Retention: keep both directories through post-swap `bd` reads and a Dolt query.
- Retirement: remove the old carrier only under the rollback rule below.

```sh
BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/beads-backup.XXXXXX")"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/beads-stage.XXXXXX")"
REPO="<absolute-repository-path>"
DB="<dolt-database-name>"
SOURCE_DB="<absolute-server-dolt-data-dir>/$DB"
STAGE_BEADS="$STAGE_DIR/.beads"
STAGE_DB="$STAGE_BEADS/embeddeddolt/$DB"
```

Treat each boundary as a separate checkpoint. G1 changes remote history. G2 creates the staged copy. G3 and G4 change only staging. G5 and G6 compare data before G8 changes checkout resolution.

Do not run these commands:

- `bd init --reinit-local`
- `bd dolt start`
- `dolt sql-server`
- any command with `--discard-remote`

These commands do not provide a safe server-store migration. An in-place reinitialisation can destroy the only copy.

## Per-store procedure

### G0: Quiesce the store

Before conversion, record the stopped sessions and released claims in a P0 bead in this store. That record crosses the cutover with the source data.

If any writer remains, stop. If the source path requires a live server connection, stop.

### G1: Push source history

Run this command from the source checkout:

```sh
cd "$REPO"
bd dolt push
```

If the command fails, stop. Resolve the remote or authentication failure first. Never use `--discard-remote` or force-push.

### G2: Copy the store offline

Before copying, stop every client. Make sure that no process writes `SOURCE_DB`.

```sh
mkdir -p "$STAGE_BEADS/embeddeddolt"
cp -a "$SOURCE_DB" "$STAGE_DB"
cp "$REPO/.beads/config.yaml" "$STAGE_BEADS/config.yaml"
cp "$REPO/.beads/.gitignore" "$STAGE_BEADS/.gitignore"
```

Check that the copy contains `$STAGE_DB/.dolt`. That directory preserves Dolt commits and refs bit for bit.

If the source becomes writable, the copy exits nonzero, or `.dolt` is absent, stop. Keep both copies.

### G3: Drop push scratch

Run this command against the staged copy only:

```sh
rm -rf -- "$STAGE_DB/.dolt/git-remote-cache"
```

Before removal, check that `STAGE_DB` and `SOURCE_DB` are different paths. If they resolve to the same path, stop.

### G4: Run garbage collection

Run garbage collection from the staged Dolt repository:

```sh
cd "$STAGE_DB"
dolt gc --full --archive-level=1
```

Measured `astro_plan` values were:

- 527 MB before scratch removal.
- 433 MB after scratch removal.
- 149 MB after garbage collection in 3.4 seconds.

Treat these values as one store's observation.

### G5: Copy verification

Before garbage collection, run the following commands against both `SOURCE_DB` and `STAGE_DB`:

```sh
dolt --data-dir "$SOURCE_DB" sql -q 'SELECT COUNT(*) AS issues FROM issues'
dolt --data-dir "$SOURCE_DB" sql -q 'SELECT COUNT(*) AS comments FROM comments'
dolt --data-dir "$SOURCE_DB" sql -q 'SELECT COUNT(*) AS dependencies FROM dependencies'
dolt --data-dir "$SOURCE_DB" log --oneline | wc -l

dolt --data-dir "$STAGE_DB" sql -q 'SELECT COUNT(*) AS issues FROM issues'
dolt --data-dir "$STAGE_DB" sql -q 'SELECT COUNT(*) AS comments FROM comments'
dolt --data-dir "$STAGE_DB" sql -q 'SELECT COUNT(*) AS dependencies FROM dependencies'
dolt --data-dir "$STAGE_DB" log --oneline | wc -l
```

Compare these four values:

- issue count
- comment count
- dependency count
- commit count

Compare the Dolt refs as well. If a count, ref, or table differs, stop. Keep `source.all.jsonl` for the later export comparison.

### G6: Verify garbage collection

After `dolt gc`, run the four staged queries from G5 again. Compare every value with the source value. Compare the refs again.

Run this read probe from the source checkout and record its wall time:

```sh
cd "$REPO"
time bd list --all --limit 1 --json
```

Treat a large regression or a failed read as a stop condition. The measured `astro_plan` read changed from 6.6 seconds on the loaded server to 1.5 seconds after migration.

### G7: Prepare embedded metadata

Write staged metadata with these values:

```json
{
  "database": "dolt",
  "backend": "dolt",
  "dolt_mode": "embedded",
  "dolt_database": "<unchanged database name>",
  "project_id": "<unchanged project id>"
}
```

If the key exists, its value is `false` in the staged config.
Remove these server settings from the staged config:
- host
- port
- user
- server-mode fallback
Keep `dolt_database`. The embedded driver needs that name to reopen the database.

### G8: Swap the checkout

After G5 and G6 pass, swap directories. Before the swap, record the old path:

```sh
OLD_BEADS="$REPO/.beads.server.$(date +%Y%m%d%H%M%S)"
mv "$REPO/.beads" "$OLD_BEADS"
printf '%s\n' "$OLD_BEADS" > "$BACKUP_DIR/old-beads-path"
mv "$STAGE_BEADS" "$REPO/.beads"
cd "$REPO"
```

Prove that the checkout resolves the intended embedded store:

```sh
bd where
jq -r '.dolt_mode, .dolt_database, .project_id' .beads/metadata.json
bd dolt status
bd count --include-infra --json
bd export --all --output "$BACKUP_DIR/embedded.all.jsonl"
shasum -a 256 "$BACKUP_DIR/source.all.jsonl" "$BACKUP_DIR/embedded.all.jsonl"
env -u BEADS_DIR bd where
```

Check all of these results:

- `bd where` resolves this checkout's `.beads`.
- `dolt_mode` is `embedded`.
- `dolt_database` and `project_id` are unchanged.
- `bd dolt status`, `bd count`, and `bd export` succeed.
- Both exports have the same SHA-256.
- Every linked worktree resolves the same store with `env -u BEADS_DIR bd where`.

If any result differs, stop and retain the old directory.

### G9: Retain the source through parity

Do not delete `OLD_BEADS`, `SOURCE_DB`, or `BACKUP_DIR` until every linked worktree passes G8. The source copy is the only rollback input during this window. After the operator records parity, remove retained paths.

## Failure conditions

The following conditions block the swap:

- A writer remains active.
- A required path is absent.
- `bd dolt push` fails.
- Remote classification fails.
- A copy or garbage-collection command fails.
- A count or ref changes.
- The project identity changes.
- The export hashes differ.

Preserve both copies and the backup. Do not start a server or reinitialise the repository to recover.

A checkout that still points to a removed server database shows:

```text
Error 1045 (28000): Access denied for user 'root'
```

Confirm that cause in `.beads/metadata.json`. The file still contains `"dolt_mode": "server"`, and its database is absent. Retire the stale server-mode carrier. Complete the embedded cutover or remove the dead checkout from the fleet. Do not resurrect a shared server. Do not change credentials, ports, or autostart settings.

## Rollback

Rollback requires the old `.beads` directory and staged backup. Keep both until the operator accepts parity.

From the repository root, run:

```sh
mv .beads .beads.embedded.failed
mv "$(cat "$BACKUP_DIR/old-beads-path")" .beads
bd dolt status
```

Keep `.beads.embedded.failed` and `BACKUP_DIR` until the restored source passes parity. The source copy is the only rollback input during this window. Deleting the source copy ends rollback. After deletion, no procedure here can recreate it. The estate has no `astro_plan` server rollback because `~/.beads/shared-server/dolt/` is empty. Retained paths remain available until every linked worktree passes parity.

## Shared-server shutdown gate

This runbook migrates one store. It does not stop the shared server.

Before server shutdown, satisfy the fleet-wide entry and verification contract in `omp-orchestrate-osr3.13`. That bead owns the parity tables and lifecycle stop command. It also owns environment-carrier checks and final server-state removal. Passing this runbook for one store does not authorize shutdown.
