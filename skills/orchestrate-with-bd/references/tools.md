# Tools

| Need | Tool |
|---|---|
| Bind the run: claim the epic (an epic parked on a configured queue alias is claimable), record ownership on it and read it back (a child epic inherits the root run above it while that run is live and still claimed by the lead that recorded it), and scope CI away from `omp/**` in the worktree you call it from or in the `worktree` you name | `orc_bind`, lead only |
| Read the run; `ready` is the first wave, `newly_ready` the refill, `todo` the list | `orc_status` |
| Take a bead (workers) | `orc_claim`; it revalidates and returns the bead's worktree, records the one you created, or replaces a recorded one git no longer reports; `claimed: false` names the holder |
| Close or block a bead with evidence (workers, lead for the epic) | `orc_finish`; closing removes the bead's worktree, a review bead's on every verdict, and reports it orphaned when `wt` refuses |
| Bot round at the exact PR head | `orc_bot_review_probe`; `unknown` and `declined` are never clean |
| Request a provider review | `orc_bot_review_request`, shepherd only |
| Conflict or CI evidence for a branch | `orc_conflict_probe` |
| Bounce or escalate an actionable round | `orc_review_round_policy` |
| Hold a bead's decision for the lead | `orc_decide`, lead only |
| Release a bead whose worker has ended | `orc_release`; the bead keeps its worktree for the next holder; `force: true` needs `hub` evidence |
| Pull the next ready bead under a named live run. `claimed: true` returns the bead and pending worktree command. `claimed: false` returns `ready`, `inflight`, and a reason | `orc_next`, worker only |
