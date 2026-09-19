# Beads store

The run header maps the bound epic, its parent run, the active actor, and the bead-to-dispatch
record. The store is whatever the beads plugin resolved for this session; orchestrate never overrides `BEADS_DIR`.

If the inherited `BEADS_DIR` points at another repository, `bd` calls stop with
`BEADS_DIR points at <a>, ledger tracks <b>`; orchestrate never falls back to a local store.
Only `BEADS_DOLT_SHARED_SERVER` is removed from the child environment.

Epic close runs `bd dolt push`; the result carries `sync: ok` or `sync: "push-failed: <reason>"`.

bd 1.3.0 exposes no claim-TTL key, so the store default lease of five minutes applies. Nothing
renews it on a timer; the recorded lead's next ledger call after its own epic lease expired
issues one native `bd heartbeat` and proceeds.

Claim, lease, release, and synchronization semantics: see the beads plugin rules `beads-core` and `beads-dolt-sync-cadence`.
