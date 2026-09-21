# Planning

The DAG is the plan. A step with no bead is not work the run knows about.

## Three facts nobody re-derives

1. OMP sends its own notice to a dispatched agent that has `task` and reads `orchestrate` in its brief. `orc-lead` receives the contract that way. A brief for any other agent never contains the word.
2. Beads outranks both the plan and the `todo` list. A plan-mode plan names its beads in a `## Beads` section. A `todo` entry is `<bead-id> <title>` copied from `orc_status.todo`.

## Shape

Two tiers by default: the lead dispatches workers directly, each works in its own Worktrunk path,
and each lands through a PR into the lead's branch (`references/landing.md`).

```
lead (root session, or orc-lead for one epic)   own worktree on its own branch
├─ orc-planner        writes the DAG, returns
├─ orc-implementer    ready task beads       worktree on omp/agent/<bead-id>
├─ orc-reviewer       one review bead each   worktree at the PR head
├─ orc-researcher     one question each
├─ orc-shepherd       one PR bead each, review-only
└─ orc-merger         one accepted-head landing in a throwaway worktree
```

Three tiers apply to a multi-epic run: the root decomposes the run into one epic per feature with
dependency edges, dispatches one `orc-lead` per ready feature, and each epic lead lands one PR
to the default branch. `maxRecursionDepth` is 2 for two tiers and 3 for three.

A cross-epic review is a review bead directly under the run epic. While a child epic is open,
ready child epics are returned; after all child epics close, ready returns the run epic's own
tasks. A `decision` bead under the run epic is not dispatched; the root closes it with
`orc_finish` once the leads have read it.

## Atomic slicing and dispatch

Before dispatching related slices, publish a cross-slice contract naming inputs, outputs, function
headers or signatures, types or schemas, shared constants, file and path ownership, dependency
edges, and one integration owner for each shared boundary.

Split work into atomic slices: each is independently ownable and verifiable, with explicit inputs,
outputs, and a stable ownership boundary. Shard oversized beads, tasks, and multi-file operations
by stable file or interface seams when slices remain merge-safe.

- MUST Decompose an oversized bead into child beads linked to that bead as their parent.
- MUST Record real dependency and review edges for each child; keep independent children unordered.
- MUST Require parent or aggregate fan-in before the parent completes.
- MUST Publish child inputs, outputs, ownership, and the integration owner before dispatch.
Apply `build-main-task-delegation` at every dispatch point and keep only the bead-to-dispatch
mapping: each ready bead maps to its assigned agent and brief. Keep artifact-dependent review
behind the artifact. After acceptance, the integration owner creates the exact-head merge bead;
the merger executes that landing, and the integration owner publishes the next contract.

## Write the DAG

- One epic per feature, ordered by dependency; each feature epic owns one integration branch and
  lands as one PR (`references/landing.md`).
- One task per unit an implementer finishes in one Worktrunk path:
  `bd create --parent <epic> --type task --title <t> --description <d> --metadata role=<r>`.
  The description names paths or symbols and numbered acceptance criteria a reviewer can check.
- `bd dep add <task> <depends-on>` for an order two tasks must keep.
- Every review bead depends on the task or tasks it reviews. Default one review bead per task;
  use one review bead for tightly interacting slices when that is more useful than separate review.
- Order epics with `bd dep add "<epic-B>" "<epic-A>"`.
- bd 1.3.0 refuses a blocking dependency from an epic to its ancestor decision. Gate the epic with
  `bd dep add "<task>" "<decision>"` for each task that needs it.
- Adopt beads that already exist under the epic. NOT Build a parallel DAG beside them.

When the domain is unfamiliar or the DAG does not exist, dispatch `orc-planner`. It creates the
beads and returns their ids. Otherwise write them yourself.

## DAG review

Before implementation starts, one `orc-reviewer` judges the run's DAG; the author of the DAG
(planner or human) makes no difference. Its description lists six guard-rails:

1. Every task names its paths or symbols and carries criteria a reviewer can verify; the
   implementer makes no design decision.
2. A task hides no decision.
3. Every review bead depends on the tasks it reviews.
4. Dependencies exist only for true ordering.
5. Every implementer bead carries a justified `metadata.tier`; `deep` and `max` are a minority.
6. A contract two or more epics share is a `decision` bead before those epics start.

`approve` closes the bead. `change` creates a planner bead (`metadata.role=planner`) that the
review depends on; the planner revises the beads and closes its bead, then the review runs again.
A child epic's lead sees no DAG review: the root review covers the tree.

## Verdicts

A review bead finishes through `orc_finish` with a `verdict`. The tool routes the next dispatch.
Tiers are static: no verdict changes a bead's tier.

| Verdict | Meaning | What `orc_finish` does |
|---|---|---|
| `approve` | every criterion met | closes the review bead |
| `fix` | a defect in the code or its checks | reopens the reviewed tasks unassigned with findings metadata and returns the review bead to open |
| `change` | a stated criterion is not met | reopens as `fix`, plus criteria metadata |
| `escalate` | this tier cannot resolve it | holds the task blocked, unassigned, with its cause; the review returns open |

A reviewer assumes the same implementer fixes a finding once it has the findings and escalates only
what the tier cannot resolve. A defect the criteria do not name is still `fix`; an exploitable
security or integrity defect is `escalate` with cause `security`; a non-blocking scope addition
is a note for the lead, never a verdict.

## The round cap and the lead's decision

`fix` and `change` are rounds. After two rounds at one tier, the third holds the task with cause
`repeated`; the hold records `upgrade` below the maximum tier, or `split` at the maximum tier or
for an unbounded task. The lead decides.

`orc_status.decisions` lists every held task with its tier, cause, rounds, review, and prior
decisions. Only the lead holding the run epic may call `orc_decide`, and each decision is a
comment on the task:

| Action | When | What `orc_decide` does |
|---|---|---|
| `retry` | findings changed between rounds | reopens the task at the same tier and resets rounds |
| `upgrade` | the same criterion failed twice, or review escalated for design, contract, or security | creates `Fix: <title>` one tier up and closes the task as superseded |
| `split` | cause `unbounded`, task is `max`, or an upgrade already failed | creates `Decompose: <title>` and closes the task as superseded |
| `accept` | a repeated or unbounded hold is not criterion-blocking | closes the task and records the mandatory reason; a follow-up bead carries residue |
| `stop` | last resort | parks the task for the human after upgrade or split was tried |

Decision history follows every successor bead. A same-tier rerun reaches the same implementer and
its brief carries the findings plus a pointer to the previous worker transcript. The implementer
reads only the affected ranges. A missing prerequisite becomes a same-tier prerequisite bead on
which the blocked task depends.

## Dispatch

1. Run `orc_status` and copy its ready bead-to-agent mapping into the `todo` list and briefs.
2. Push your branch before dispatching; name the bead id and base branch in every brief.
3. Apply `build-main-task-delegation` and dispatch each ready mapping through one `task` call.
4. After a review accepts a pull request, create one merge bead for that accepted head. Assign
   `pool:orc-merger`; set `role=merger`, `target`, `base`, `head_sha`, and `receipt=landed+cleaned`;
   and depend on the accepted review. Construct its sole command as
   `gh pr merge PR_URL MERGE_METHOD --match-head-commit REVIEWED_HEAD`, with one approved method.
5. Run `orc_status` and dispatch the merge bead to `orc-merger`. Consume its target, base,
   exact-head, merge-SHA or failure, terminal disposition, and cleanup receipt before advancing.
6. Every attempt closes terminally, including a failed landing, so `orc_finish` runs worktree
   reclamation. Create no replacement until the old bead is closed and its registration, path,
   and branch are gone. Cleanup residue is reclaimed and recorded first.
7. A conflict belongs to the lead's integration worktree and a changed head requires fresh review.
   The merger never resolves it or owns integration policy. A `fix` or `change` returns to the same
   implementer; a held task requires `orc_decide`, after which `orc_status` supplies the successor
   mapping.

## Pull-mode dispatch

Pull mode replaces per-wave dispatch with a fixed batch of long-lived workers. The lead binds the
run and sends one `task` call. Every brief names the run epic id AND the base branch its worktrees
branch from, because the worker substitutes that base itself.

A worker starts in the parent's cwd with native isolation off, then repeats until no reachable work
remains:

1. Call `orc_next { run, agent }` with the id from the brief.
2. `claimed: true` arrives in one of two shapes, and they are not interchangeable:
   - `worktree` present, no `pending` → a prior attempt already branded this bead. Work in that
     tree; create nothing.
   - `pending` present → the bead has no worktree. Run the command `pending` carries, substituting
     the brief's base for its literal `<base-branch>`.
3. Call `orc_claim` either way, because `orc_next` only reads the brand while `orc_claim` revalidates
   it against `git worktree list` and handles a tree pruned or reused between attempts. After
   `pending`, pass `worktree` as the absolute path `wt switch` printed and `branch` as
   `omp/agent/<bead-id>`: without them the bead stays unbranded and the next call returns the same
   pending instruction. When adopting, omit both and `orc_claim` revalidates the recorded tree.
4. Do the work, then call `orc_finish`.
5. Pull the next bead.

**A session's cwd does not follow `wt switch`. After `orc_finish` reclaims bead A's tree and
`orc_next` hands over bead B, every read, edit, and command must use an absolute path under B's
tree, or pass `-C <worktree>` / `cwd: <worktree>`.**

`claimed: false` carries the exit condition. Nonzero `inflight` → wait about one second and pull
again, because a sibling may make work ready; a tight spin wastes calls and contends on the ledger.
`inflight` zero → report completion and exit.

Choose the batch size against `orc_status.ready` and `task.maxConcurrency`: cover the ready set when
practical, never exceed the cap, and avoid a large idle surplus.

Pull mode changes who selects work, and nothing else. `orc_next` and `orc_status` share the
ready-selection path, so the DAG-review gate remains in force. Review beads still depend on the
tasks they review, delivered beads stay closed, and the lead still owns integration, review verdicts
through `orc_finish`, `orc_decide`, and cross-epic contracts.


## The `todo` list

The `todo` list is a per-turn view of `orc_status`: keep every entry as `<bead-id> <title>` copied from `orc_status.todo`; when it disagrees, re-read `orc_status` and rewrite it, `todo done` redraws the view, and `orc_finish` changes the state.

## Role lifetimes

| Role | Lifetime and boundary |
|---|---|
| Implementer | Keep one pulling implementer agent long-lived and reuse one Worktrunk path. |
| Researcher | Start a fresh agent for each research bead. |
| Reviewer | Start a fresh agent for each review round. |
| Security reviewer | Start a fresh agent for each security review. |
| Bot reviewer | Start a fresh agent for each bot-review round. |
| Scout or operator | Start a fresh helper for each invocation. |
| Coordinator | Keep one coordinator long-lived; it may order ready merge beads but never modifies a repository. |
| Merger | Start a fresh Worktrunk companion for each merge bead; it rechecks the exact source revision and every required gate before integrating. |

## Tier escalation

Escalate a tier by creating a clean `Fix:` successor bead in the deeper tier's queue. The predecessor closes as superseded and keeps its worktree and pull request; the successor carries the findings and decision history, but starts with no worktree or pull request, creates its own branch from the predecessor's branch, and opens its own pull request.
