---
name: orchestrate-with-bd
description: Durable Beads-backed orchestration on native OMP task dispatch. Use when the user says orchestrate, or when resuming a run recorded in Beads.
---

# Orchestrate with bd

TRIGGER
+ The prompt says `orchestrate`; the plugin's run header arrives on that word alone.
+ Resuming a run: the checkout carries `.orchestration/.active-run`; say `orchestrate` in
  the prompt to receive the header, then `orc_status {}` reads the bound run.
- One bounded task with no independent slices: execute it directly.

You are the lead. OMP owns the agents and their workspaces. Beads records what work exists and what state it is in. The run header the plugin injected on your prompt is the contract.

## Three facts nobody re-derives

1. OMP sends its own notice to a dispatched agent that has `task` and reads `orchestrate` in its brief. `orc-lead` receives the contract that way. A brief for any other agent never contains the word.
2. Workers have no `todo` list. OMP withholds the `todo` tool from every dispatched agent. A worker tracks nothing outside its bead, and `orc_finish` is its only progress record.
3. Beads outranks both the plan and the `todo` list. A plan-mode plan names its beads in a `## Beads` section. A `todo` entry is `<bead-id> <title>` copied from `orc_status.todo`.

## Workflow

| Phase | LOAD |
|---|---|
| Store setup, migration, or a `Dolt server unreachable` error | `skill://orchestrate-with-bd/references/beads-store.md` |
| Writing or adopting the DAG, plan-mode plans, dispatch shape | `skill://orchestrate-with-bd/references/planning.md` |
| Which agent, which model, `isolated`, recursion depth | `skill://orchestrate-with-bd/references/roles.md` |
| A contract two epics share | `skill://orchestrate-with-bd/references/decisions.md` |
| Review bots on a PR | `skill://orchestrate-with-bd/references/review-providers.md` |

1. Bind. `orc_bind { epic: <id> }` claims the epic for you and binds the run to this
   checkout; then `orc_status` returns every bead under the epic. An epic another lead
   holds refuses to bind. No epic yet: `bd create --type epic`, or dispatch `orc-planner`
   when the domain is unfamiliar, then bind.
2. Plan. Rewrite your `todo` list from `orc_status.todo`. Every entry is a bead.
3. DAG review. When `orc_status` reports `DAG review required`, run the `bd create` it
   returns and call `orc_status` again. The review bead is the wave: one `orc-reviewer`.
   It judges every bead under the run epic against the guard-rails in its description.
   On `change`, `orc_finish` creates a planner bead the review depends on. The next wave
   is `orc-planner`, then the review again. Implementation waits until the review closes.
4. Dispatch. `orc_status.ready` is the wave. Dispatch every ready bead in one `task` call,
   each item copying `agent` and `isolated` from `orc_status.wave`. When the call carries
   fewer items than `ready`, state the reason.
5. Integrate. When the wave lands, merge every captured `omp/task/<agent-name>` branch into
   your tree and resolve conflicts there. When `.beads/interactions.jsonl` (bd's per-clone
   audit log) conflicts, keep both sides.
6. Review. Review beads depend on their tasks, so they are the next `ready` wave.
   Dispatch them in one `task` call, one `orc-reviewer` for each. Each reviewer judges its
   bead against the integrated diff from the merge base to `HEAD`. Each finishes with a
   verdict, and the tool routes the result. `fix` and `change` reopen the task for the same
   implementer at the same tier. Two rounds are the limit. `escalate`, or a third round, holds the
   task under `orc_status.decisions`. You alone move a held task, with `orc_decide` (retry,
   upgrade, split, accept; stop last). The successor bead is the next wave. Tiers never
   change from a verdict.
7. Cross-epic review (three-tier only). Once the leads close every child epic and you merge
   every epic branch, `ready` turns to the tasks directly under the run epic. Dispatch that
   review wave over the merged run; each reviewer judges the run's `merge-base..HEAD` diff.
8. Close. When every task is `closed`, `orc_finish` the epic `done`. When a task stays
   `blocked`, finish the epic `blocked` too: bd refuses to close an epic over a blocked child.

## Rules

- MUST Dispatch all of `orc_status.ready` in one `task` call. OMP's `task.maxConcurrency`
  (per lead, default 32) queues the excess; set it to bound each lead's parallel workers.
- MUST Wait for the whole `task` call to return before treating a wave as landed. NOT Re-read
  `orc_status` on the first result.
- MUST Merge a landed wave before dispatching the review wave that follows it.
- MUST Dispatch the review wave in one `task` call, one reviewer for each bead in it.
- NOT Pair an implementer with an immediate reviewer.
- MUST Let `orc_finish` route a verdict and `orc_decide` move a held task. NOT Create a fix
  bead or change a tier yourself; the tools create successors and record the decision.
- MUST Create a prerequisite bead at the same tier when an implementer finishes `blocked`
  on a missing prerequisite, with the blocked task depending on it.
- MUST Give every review bead a dependency on the task or tasks it reviews, so review beads
  surface as one wave after the tasks land.
- MUST Apply the wave rules inside an epic as a sub-lead. The root dispatches all epic leads
  in one call. At the epic tier, `ready` already applies the readiness rules in
  `references/planning.md`.
- MUST Dispatch through the native `task` tool. NOT Start a nested `omp` process. NOT
  Create a worktree for an agent; OMP's `isolated: true` is the worker's workspace.
- MUST Keep the store in server mode. Native isolation clones the checkout, and an embedded
  Dolt store forks with it. Every ledger tool returns the migration text on an embedded store.
- NOT Migrate a store, edit `.beads/`, or dispatch an agent to do so. On an embedded or
  missing store, report the route from `references/beads-store.md` to the human and end the
  turn; a human runs the migration.
- NOT Claim a task bead or edit product code as the lead. Binding claims your epic; workers
  claim tasks; reviewers judge.
- MUST Copy `todo` entries from `orc_status.todo`. On any disagreement re-read `orc_status`
  and rewrite the list. `todo done` redraws the view. `orc_finish` changes the state.
- MUST Record a cross-epic contract as a `decision` bead before dispatching the epics.
- MUST Set `maxRecursionDepth` to 2 for a single-epic run and 3 for a multi-epic run.
- NOT Put the bare lowercase word `orchestrate` in a worker brief. Put it in an `orc-lead`
  brief.
- NOT Tell a worker to skip the checks its bead names. An implementer runs every criterion's
  check and the tests it adds. Repository-wide suites and formatters wait for you, and that
  is all OMP's skip guidance for `task` refers to.
- NOT Pass `--db` or a store path to a child yourself. `bd` resolves the shared server
  from the tracked `.beads/metadata.json` in every clone. The `beads` plugin pins
  `BEADS_DIR` to the primary checkout's `.beads` on every bash call; that names the same
  server database and is not a fork.

## Tools

| Need | Tool |
|---|---|
| Bind the run; `ready` is the wave, `todo` is the list | `orc_status` |
| Take a bead (workers) | `orc_claim`; `claimed: false` names the holder |
| Close or block a bead with evidence (workers, lead for the epic) | `orc_finish` |
| Bot round at the exact PR head | `orc_bot_review_probe`; `unknown` and `declined` are never clean |
| Request a provider review | `orc_bot_review_request`, shepherd only |
| Conflict or CI evidence for a branch | `orc_conflict_probe` |
| Bounce or escalate an actionable round | `orc_review_round_policy` |
