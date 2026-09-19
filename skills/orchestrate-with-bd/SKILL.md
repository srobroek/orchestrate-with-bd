---
name: orchestrate-with-bd
description: Durable Beads-backed orchestration on OMP task dispatch. Use when the user says orchestrate, or when resuming a run recorded in Beads.
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
| The store mapping and lifecycle/synchronization contract | `skill://orchestrate-with-bd/references/beads-store.md` |
| Writing or adopting the DAG and dispatch shape | `skill://orchestrate-with-bd/references/planning.md` |
| DAG review, verdicts, the round cap, `orc_decide` | `skill://orchestrate-with-bd/references/planning.md` |
| Which agent and recursion depth | `skill://orchestrate-with-bd/references/roles.md` |
| A contract two epics share | `skill://orchestrate-with-bd/references/decisions.md` |
| Review bots on a PR | `skill://orchestrate-with-bd/references/review-providers.md` |
| Which tool takes, closes, releases, or decides a bead | `skill://orchestrate-with-bd/references/tools.md` |
| Pull the next ready bead or release a lapsed holder | `orc_next`, `orc_release` |
| Branches, PR titles, review at the PR head, run close | `skill://orchestrate-with-bd/references/landing.md` |

1. Bind. `orc_bind { epic: <id> }` claims the epic and records the run on the epic bead itself;
   `orc_status` then returns every bead under it. A foreign-held epic with a live lease refuses;
   an expired lease may transfer only when its holder is not live. Liveness comes from the hub
   list. `force: true` is always honored as a user override, recorded with reason `user override`.
   No epic yet: `bd create --type epic`, or dispatch `orc-planner` first.
2. Companion worktree. After `orc_claim`, run
   `wt switch -y --create --no-cd --base <base> --format json omp/agent/<bead-id>` and work
   under the returned path. `Never pass isolated: true.` Push the branch before dispatching.
3. Plan. Keep the `todo` list equal to `orc_status.todo`; every entry is a bead.
4. DAG review. On `DAG review required`, run the `bd create` returned by `orc_status`, then call
   it again; implementation waits until the review bead closes.
5. Dispatch. Apply `build-main-task-delegation` at every dispatch point. Preserve only the
   bead-to-dispatch mapping: each ready bead maps to its assigned agent and brief.
   `orc_status.held` lists claimed beads; when its worker has ended,
   `orc_release { bead, holder, reason }` returns the bead to `ready` with its worktree intact;
   `force: true` only after `hub list` and `hub jobs` show no agent on it.
6. Land. Merge each approved child PR into your branch; a conflict is yours, in your own
   worktree. Review beads become ready as their tasks close: one `orc-reviewer` each, in one
   `task` call, each judging its own PR at that PR's head. `orc_finish` routes the verdict and
   `orc_decide` moves a held task. `references/landing.md` holds the rest.
7. Cross-epic review (three-tier only). Once every child epic is closed and its PR merged, ready
   turns to the run epic's own tasks; dispatch them over the run.
8. Close. `orc_finish` the epic `done` when every task is `closed`, `blocked` when one stays
   blocked: bd refuses to close an epic over a blocked child.

## Pull workers

A run may replace per-wave dispatch with a fixed batch of long-lived workers that pull their own
work through `orc_next`. LOAD `skill://orchestrate-with-bd/references/planning.md#Pull-mode-dispatch`
for the loop, the batch size, and the exit condition.

**The session's cwd does not follow `wt switch`. After `orc_finish` reclaims bead A's tree and
`orc_next` hands the worker bead B, use an absolute path under B's tree for every read, edit, and
command. You may pass `-C <worktree>` or `cwd: <worktree>` instead. Otherwise work can land on the
wrong branch.**

## Rules
- MUST Dispatch every bead in `orc_status.ready` in one `task` call, and a review wave in one call
  with one reviewer per bead. A pull-worker run dispatches one batch sized against the ready count
  instead; a worker then takes `newly_ready` itself through `orc_next`, so the lead re-dispatches only
  to replace a worker that ended. Refill and fan-in follow `build-main-task-delegation`.
- NOT Pair an implementer with an immediate reviewer.
- MUST Let `orc_finish` route a verdict and `orc_decide` move a held task. NOT Create a fix bead or change a tier yourself.
- MUST Create a prerequisite bead at the same tier when an implementer finishes `blocked` on a
  missing prerequisite, and give every review bead a dependency on the tasks it reviews.
- MUST Apply `build-main-task-delegation` inside an epic as a sub-lead; the root dispatches every epic lead in one call.
- MUST Dispatch through the native `task` tool. NOT Start a nested `omp` process. Every agent
  works in its own Worktrunk worktree and never mutates the canonical checkout
  (`rule://worktrunk-worktree-required`), and a `bd` call that lost the single-writer race is
  retried, never serialized in code (`rule://worktrunk-bd-contention-retry`).
- NOT Migrate a store, edit `.beads/`, or dispatch an agent to do so while orchestrating.
- NOT Claim a task bead or edit product code as the lead. Binding claims your epic; workers claim tasks; reviewers judge.
- MUST Keep the `todo` list equal to `orc_status.todo`; on disagreement re-read `orc_status` and rewrite it. `todo done` redraws the view; `orc_finish` changes the state.
- MUST Record a cross-epic contract as a `decision` bead before dispatching the epics.
- MUST Set `maxRecursionDepth` to 2 for a single-epic run and 3 for a multi-epic run.
- NOT Put the bare lowercase word `orchestrate` in a worker brief. Put it in an `orc-lead` brief.
- NOT Tell a worker to skip the checks its bead names. Repository-wide suites and formatters wait for you, and that is all OMP's skip guidance for `task` refers to.
- NOT Pass `--db` or a store path to a child. The beads plugin resolves the store for the session (`references/beads-store.md`).
- MUST Keep a delivered task bead closed. A delivery close is `status=closed` whose close reason
  explicitly records delivery proof and whose metadata names the shipped artifact (for example
  `pr`, `head_sha`, `merge_sha`, or published-schema evidence). Do not reopen or reclaim it for
  newly discovered work: file a child bead instead. The only legitimate reopen paths remain a
  review verdict of `fix` or `change`, and the lead's `orc_decide { action: retry }`.
- MUST Treat a live holder's lease as authoritative. A stale node with a live owner says `owner live; leave`. A stale node whose owner is not live may be reclaimed with `orc_release {id, force:true, reason:"owner not live"}`. Liveness comes from `hub list`.
- A user instruction to reclaim or reassign a bead is always honored with `force: true` and `reason: "user override"`; record the evidence before reassignment.
- S1 provider wait: leave the bead `in_progress` and comment `review-pending: PROVIDER ISO-TIME`.
  If waiting exceeds 15 minutes, redispatch the bead.
- S2 integration conflict: stop the affected integration, preserve both sides, and dispatch an
  integration worker through `task` with the conflict paths, source revisions, and acceptance
  gates; the worker resolves in the integration owner's Worktrunk path and reruns the gates.
- C6 integration failure: run `bd update TASK -s open` and `bd comment TASK "integration-failed: REASON"`, then dispatch the same-tier integration worker again.
- C7 bd unavailable: tools report `bd-unavailable: REASON`; the lead reruns `orc_status` and does not substitute a second store or mutate `.beads/`.
