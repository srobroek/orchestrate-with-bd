# Beads store

The run header maps the bound epic, its parent run, the active actor, and the bead-to-dispatch
record. The store is an embedded Dolt database resolved by the beads plugin; orchestrate never
overrides `BEADS_DIR`.

Linked worktrees share the primary checkout's `.beads` directory through the git common directory,
so every worktree resolves the same ledger without a server. If the inherited `BEADS_DIR` points at
another repository, `bd` calls stop with `BEADS_DIR points at <a>, ledger tracks <b>`; orchestrate
never falls back to a local store. An inherited shared-server override is discarded defensively so
it cannot redirect an embedded call to the retired backend.

Embedded Dolt is single-writer. Concurrent ledger calls may contend on the file lock; the runner
retries exact lock-contention failures with bounded backoff rather than serializing workers in code.

Epic close runs `bd dolt push`; the result carries `sync: ok` or `sync: "push-failed: <reason>"`.

bd 1.3.0 exposes no claim-TTL key, so the store default lease of five minutes applies. Nothing
renews it on a timer; the recorded lead's next ledger call after its own epic lease expired issues
one native `bd heartbeat` and proceeds.

Claim, lease, release, and synchronization semantics: see the beads plugin rules `beads-core` and
`beads-dolt-sync-cadence`.
