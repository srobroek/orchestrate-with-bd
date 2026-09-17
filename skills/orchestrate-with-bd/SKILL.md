---
name: orchestrate-with-bd
description: Durable Beads-backed orchestration on native OMP task dispatch. Use when the user says orchestrate, or when resuming a run recorded in Beads.
---

# Orchestrate with bd

TRIGGER
+ The prompt says `orchestrate`; the plugin's run header arrives on that word alone.
+ Resuming a run: the checkout carries `.orchestration/.active-run`; say `orchestrate` to receive
  the header, then `orc_status {}` reads the bound run. A locator naming a closed or foreign-held
  epic is reported STALE and must be rebound.
- One bounded task with no independent slices: execute it directly.

You are the lead. OMP owns the agents and their workspaces. Beads records what work exists and what state it is in. The run header the plugin injected on your prompt is the contract.

## Workflow

| Phase | LOAD |
|---|---|
| What the run header, the `todo` list, and a worker's tools each own | `skill://orchestrate-with-bd/references/planning.md#Three-facts-nobody-re-derives` |
| Store setup, migration, or a `Dolt server unreachable` error | `skill://orchestrate-with-bd/references/beads-store.md` |
| Writing or adopting the DAG, plan-mode plans, dispatch shape | `skill://orchestrate-with-bd/references/planning.md` |
| DAG review, verdicts, the round cap, `orc_decide` | `skill://orchestrate-with-bd/references/planning.md` |
| Which agent, which model, `isolated`, recursion depth | `skill://orchestrate-with-bd/references/roles.md` |
| A contract two epics share | `skill://orchestrate-with-bd/references/decisions.md` |
| Review bots on a PR | `skill://orchestrate-with-bd/references/review-providers.md` |
| Which tool takes, closes, releases, or decides a bead | `skill://orchestrate-with-bd/references/tools.md` |

1. Bind. `orc_bind { epic: <id> }` claims the epic for you and binds the run to this
   checkout; then `orc_status` returns every bead under the epic. An epic another lead
   holds refuses to bind. No epic yet: `bd create --type epic`, or dispatch `orc-planner`
   when the domain is unfamiliar, then bind.
2. Plan. Rewrite your `todo` list from `orc_status.todo`. Every entry is a bead.
3. DAG review. On `DAG review required`, run the `bd create` that `orc_status` returns and call
   it again; the review bead is the wave, and implementation waits until it closes.
4. Dispatch. `orc_status.ready` is the wave. Dispatch every ready bead in one `task` call, each item copying `agent` and `isolated` from `orc_status.wave`. The gate refuses a `task` call that omits a ready bead or names one twice; helpers such as `scout` are exempt. A settled batch wakes you with a `task-batch-wake` message: integrate, `orc_status`, dispatch. `orc_status.held` lists claimed beads; when its worker has ended, `orc_release { bead, holder, reason }` returns the bead to `ready`; `force: true` only after `hub list`/`hub jobs` show no agent on it.
5. Integrate. When the wave lands, merge every captured `omp/task/<agent-name>` branch into
   your tree and resolve conflicts there. When `.beads/interactions.jsonl` (bd's per-clone
   audit log) conflicts, keep both sides.
6. Review. Review beads depend on their tasks, so they are the next `ready` wave: one
   `orc-reviewer` each, in one `task` call, judging the integrated `merge-base..HEAD` diff.
   `orc_finish` routes the verdict and `orc_decide` moves a held task.
7. Cross-epic review (three-tier only). Once the leads close every child epic and you merge
   every epic branch, `ready` turns to the run epic's own tasks; dispatch that wave over the run.
8. Close. `orc_finish` the epic `done` when every task is `closed`, and `blocked` when one
   stays blocked: bd refuses to close an epic over a blocked child.

## Rules
- MUST Load and apply `skill://orchestrate-with-bd/references/planning.md#Work-conserving-waves-and-atomic-slicing` recursively at every scheduler level; it is authoritative for atomic parent-linked decomposition, contracts, continuous refill, and fan-in.
- MUST Dispatch all of `orc_status.ready` in one `task` call, and the review wave in one call with
  one reviewer per bead, never pairing an implementer with its own reviewer. OMP's
  `task.maxConcurrency` (per lead, default 32) queues the excess.
- MUST Process a settled `task-batch-wake` and every independently settled slice: integrate the
  owned slice, re-read `orc_status`, refill immediately. Unresolved siblings are not landed, and
  a shared boundary is serialized under its named owner.
- MUST Let `orc_finish` route a verdict and `orc_decide` move a held task. NOT Create a fix
  bead or change a tier yourself; the tools create successors and record the decision.
- MUST Create a prerequisite bead at the same tier when an implementer finishes `blocked` on a
  missing prerequisite, and give every review bead a dependency on the tasks it reviews, so both
  surface as one wave after those tasks land.
- MUST Apply the wave rules inside an epic as a sub-lead; the root dispatches every epic lead in one call.
- MUST Dispatch through the native `task` tool. NOT Start a nested `omp` process. NOT
  Create a worktree for an agent; OMP's `isolated: true` is the worker's workspace.
- MUST Keep the store in server mode. Native isolation clones the checkout, and an embedded
  Dolt store forks with it. Every ledger tool returns the migration text on an embedded store.
- NOT Migrate a store, edit `.beads/`, or dispatch an agent to do so while orchestrating. On an
  embedded or missing store the run header decides: STOP-only unless every migration gate in
  `references/beads-store.md` is met, and a session it admits runs only the header's bounded
  commands. Under a STOP-only header, report that route and end the turn.
- NOT Claim a task bead or edit product code as the lead. Binding claims your epic; workers claim tasks; reviewers judge.
- MUST Copy `todo` entries from `orc_status.todo`. On any disagreement re-read `orc_status`
  and rewrite the list. `todo done` redraws the view. `orc_finish` changes the state.
- MUST Record a cross-epic contract as a `decision` bead before dispatching the epics.
- MUST Set `maxRecursionDepth` to 2 for a single-epic run and 3 for a multi-epic run.
- NOT Put the bare lowercase word `orchestrate` in a worker brief. Put it in an `orc-lead` brief.
- NOT Tell a worker to skip the checks its bead names. Repository-wide suites and formatters wait
  for you, and that is all OMP's skip guidance for `task` refers to.
- NOT Pass `--db` or a store path to a child yourself. `bd` resolves the shared server from the
  tracked `.beads/metadata.json` in every clone, and the plugin's `BEADS_DIR` pin names it too.
