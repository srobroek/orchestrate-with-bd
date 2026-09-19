# Beads store

The run header maps the bound epic, its parent run, the active actor, and the bead-to-dispatch
record. The store is whatever the beads plugin resolved for this session; orchestrate never overrides BEADS_DIR.


Claim, lease, release, and synchronization semantics: see the beads plugin rules `beads-core` and `beads-dolt-sync-cadence`.
