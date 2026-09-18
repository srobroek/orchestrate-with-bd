---
name: orchestrate-with-bd
description: Durable Beads-backed orchestration on native OMP task dispatch. Use when the user says orchestrate, or when resuming a run recorded in Beads.
---

# Orchestrate with bd

TRIGGER
+ The prompt says `orchestrate`; the plugin's run header arrives on that word alone.
+ Resuming a run: say `orchestrate` to receive the header, then `orc_bind { epic }` on the epic
  you own and `orc_status {}` reads it back. The run lives on the epic bead, never in a file
  beside a checkout, so any checkout of the repository resumes it.
- One bounded task with no independent slices: execute it directly.

You are the lead. Beads records what work exists and what state it is in. Every agent, you
included, works in its own Worktrunk worktree of this repository and lands through a pull
request: LOAD `skill://orchestrate-with-bd/references/landing.md`. The run header the plugin
injected on your prompt is the contract.

## Workflow

| Phase | LOAD |
|---|---|
| What the run header, the `todo` list, and a worker's tools each own | `skill://orchestrate-with-bd/references/planning.md#Three-facts-nobody-re-derives` |
| The store: one embedded database, contention, `bd dolt push` at run close | `skill://orchestrate-with-bd/references/beads-store.md` |
| Writing or adopting the DAG, plan-mode plans, dispatch shape | `skill://orchestrate-with-bd/references/planning.md` |
| Pool queues and role lifetimes | `skill://orchestrate-with-bd/references/planning.md#Pool-discipline` |
| DAG review, verdicts, the round cap, `orc_decide` | `skill://orchestrate-with-bd/references/planning.md` |
| Which agent, which model, recursion depth | `skill://orchestrate-with-bd/references/roles.md` |
| A contract two epics share | `skill://orchestrate-with-bd/references/decisions.md` |
| Review bots on a PR | `skill://orchestrate-with-bd/references/review-providers.md` |
| Which tool takes, closes, releases, or decides a bead | `skill://orchestrate-with-bd/references/tools.md` |
| Branches, PR titles, review at the PR head, run close | `skill://orchestrate-with-bd/references/landing.md` |

1. Bind. `orc_bind { epic: <id> }` claims the epic and records the run on the epic bead itself;
   `orc_status` then returns every bead under it. An epic a *live* lead holds refuses to bind; one
   whose lead's claim has lapsed transfers to you. No epic yet: `bd create --type epic`, or dispatch
   `orc-planner` first. Commit any CI files binding changed as the run's first change; the ones it
   reports as *pending* came from canonical: create the worktree in step 2, then bind again with
   `worktree: "<that path>"`.
2. Worktree. Create your branch and worktree and push the branch before dispatching anything:
   `references/landing.md` steps 1 and 2.
3. Plan. Rewrite your `todo` list from `orc_status.todo`. Every entry is a bead.
4. DAG review. On `DAG review required`, run the `bd create` that `orc_status` returns and call it
   again; the review bead is the wave, and implementation waits until it closes.
5. Dispatch. `orc_status.ready` is the first wave: one `task` call, each item copying `agent` from
   `orc_status.wave`, each brief naming the bead id and the base branch. The gate refuses a call
   that omits a ready bead or names one twice; helpers such as `scout` are exempt.
   `orc_status.held` lists claimed beads; when its worker has ended,
   `orc_release { bead, holder, reason }` returns the bead to `ready` with its worktree intact;
   `force: true` only after `hub list`/`hub jobs` show no agent on it.
6. Refill. On every delivered child result, call `orc_status` and dispatch all of `newly_ready`.
7. Land. Merge each approved child PR into your branch; a conflict is yours, in your own worktree.
   Review beads become ready as their tasks close: one `orc-reviewer` each, in one `task` call,
   each judging its own PR at that PR's head. `orc_finish` routes the verdict and `orc_decide`
   moves a held task. `references/landing.md` steps 6 to 11 hold the rest.
8. Cross-epic review (three-tier only). Once every child epic is closed and its PR merged, `ready`
   turns to the run epic's own tasks; dispatch that wave over the run.
9. Close. `orc_finish` the epic `done` when every task is `closed`, `blocked` when one stays
   blocked: bd refuses to close an epic over a blocked child. At run close, `bd dolt push` from the
   canonical checkout and check its exit status.

## Rules
- MUST Load and apply `skill://orchestrate-with-bd/references/planning.md#Work-conserving-waves-and-atomic-slicing` recursively at every scheduler level; it is authoritative for atomic parent-linked decomposition, contracts, continuous refill, and fan-in.
- MUST Dispatch all of `orc_status.ready` in the first `task` call, and a review wave in one call
  with one reviewer per bead. OMP's `task.maxConcurrency` (per lead, default 32) queues the excess.
- NOT Pair an implementer with an immediate reviewer.
- MUST Call `orc_status` on every delivered child result and dispatch all of `newly_ready` at once.
  `wave` batches the first dispatch and is never a barrier. Unresolved siblings are not landed, and
  a shared boundary is serialized under its named owner.
- MUST Let `orc_finish` route a verdict and `orc_decide` move a held task. NOT Create a fix bead or change a tier yourself.
- MUST Create a prerequisite bead at the same tier when an implementer finishes `blocked` on a
  missing prerequisite, and give every review bead a dependency on the tasks it reviews, so both
  surface as one wave after those tasks land.
- MUST Apply the wave rules inside an epic as a sub-lead; the root dispatches every epic lead in one call.
- MUST Dispatch through the native `task` tool. NOT Start a nested `omp` process. Every agent works
  in its own Worktrunk worktree and never mutates the canonical checkout
  (`rule://worktrunk-worktree-required`), native OMP isolation stays off
  (`rule://worktrunk-isolation-disabled`), and a `bd` call that lost the single-writer race is
  retried, never serialized in code (`rule://worktrunk-bd-contention-retry`).
- NOT Migrate a store, edit `.beads/`, or dispatch an agent to do so while orchestrating.
- NOT Claim a task bead or edit product code as the lead. Binding claims your epic; workers claim tasks; reviewers judge.
- MUST Copy `todo` entries from `orc_status.todo`. On any disagreement re-read `orc_status`
  and rewrite the list. `todo done` redraws the view. `orc_finish` changes the state.
- MUST Record a cross-epic contract as a `decision` bead before dispatching the epics.
- MUST Set `maxRecursionDepth` to 2 for a single-epic run and 3 for a multi-epic run.
- NOT Put the bare lowercase word `orchestrate` in a worker brief. Put it in an `orc-lead` brief.
- NOT Tell a worker to skip the checks its bead names. Repository-wide suites and formatters wait
  for you, and that is all OMP's skip guidance for `task` refers to.
- NOT Pass `--db`, a store path, or `BEADS_DIR` to a child. `bd` resolves the one embedded database
  in the canonical `.beads` from any worktree (`references/beads-store.md`).
- MUST Keep a delivered task bead closed. A delivery close is `status=closed` whose close reason explicitly records delivery proof and whose metadata names the shipped artifact (for example `pr`, `head_sha`, `merge_sha`, or published-schema evidence). Do not reopen or reclaim it for newly discovered work: file a child bead instead. If the close reason is inaccurate, add a comment while leaving the bead closed. The only legitimate reopen paths remain a review verdict of `fix` or `change`, and the lead's `orc_decide { action: retry }`; those paths carry their existing workflow metadata.

