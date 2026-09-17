# Tools

| Need | Tool |
|---|---|
| Bind the run; `ready` is the wave, `todo` is the list | `orc_status` |
| Take a bead (workers) | `orc_claim`; `claimed: false` names the holder |
| Close or block a bead with evidence (workers, lead for the epic) | `orc_finish` |
| Bot round at the exact PR head | `orc_bot_review_probe`; `unknown` and `declined` are never clean |
| Request a provider review | `orc_bot_review_request`, shepherd only |
| Conflict or CI evidence for a branch | `orc_conflict_probe` |
| Bounce or escalate an actionable round | `orc_review_round_policy` |
| Hold a bead's decision for the lead | `orc_decide`, lead only |
| Release a bead whose worker has ended | `orc_release`; `force: true` needs `hub` evidence |
