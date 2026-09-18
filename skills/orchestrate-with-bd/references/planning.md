# Planning

The DAG is the plan. A step with no bead is not work the run knows about.

## Three facts nobody re-derives

1. OMP sends its own notice to a dispatched agent that has `task` and reads `orchestrate` in its brief. `orc-lead` receives the contract that way. A brief for any other agent never contains the word.
2. Workers have no `todo` list. OMP withholds the `todo` tool from every dispatched agent. A worker tracks nothing outside its bead, and `orc_finish` is its only progress record.
3. Beads outranks both the plan and the `todo` list. A plan-mode plan names its beads in a `## Beads` section. A `todo` entry is `<bead-id> <title>` copied from `orc_status.todo`.

## Shape

Two tiers by default: the lead dispatches workers directly, each works in its own worktree, and
each lands its work through a PR into the lead's branch (`references/landing.md`).

```
lead (root session, or orc-lead for one epic)   own worktree on its own branch
├─ orc-planner        writes the DAG, returns
├─ orc-implementer    ready task beads per wave         worktree on omp/agent/<bead-id>
├─ orc-reviewer       one review bead each              worktree at the PR head
├─ orc-researcher     one question each
└─ orc-shepherd       one PR bead each
```

Three tiers for a multi-epic run, and a multi-epic run is the default shape for anything with more
than one feature: the root session decomposes the run into one epic per feature with dependency
edges between the features, and dispatches one `orc-lead` per ready feature. Each brief names its
epic and contains the word `orchestrate`, so the epic lead receives the same run header. Each epic
lead runs the two-tier shape in its own worktree on `omp/epic/<epic-id>`, and its feature lands as
one PR to the default branch, merged on GitHub. `maxRecursionDepth` is 2 for two tiers and 3 for
three.

A cross-epic review is a review bead placed directly under the run epic. bd refuses a
task-to-epic dependency, so `orc_status.ready` gates it instead:

- While any child epic stays open, `ready` holds epics.
- Once the leads close every child epic, `ready` holds the run epic's own `task` beads.
- Each feature epic's PR merges first, and the root refreshes `omp/run/<run-id>` from the default
  branch after each merge.
- Then the root dispatches that review wave over the run.
- A `decision` bead under the run epic is never a wave item; the root closes it with
  `orc_finish` once the leads have read it.

`orc_status.shape` reports which shape the DAG implies. When a direct child of the run epic
is itself an epic, the shape is `three-tier`; otherwise it is `two-tier`. No separate human
switch exists. The plan the human approved is the input: its `## Beads` section names the
child epics or does not. A prompt that asks for two tiers over a multi-epic DAG gets two
tiers: the lead dispatches the epics' tasks directly.

## Work-conserving waves and atomic slicing

Every spawn-capable agent has the same scheduling duty. A spawn-capable agent is any root lead, epic or sub-lead, task worker, researcher, scout, operator, reviewer, or specialist whose tools permit spawning agents. Role and tier affect routing only; they never exempt an agent from this section.

Before dispatching related slices, publish a cross-slice contract. The contract names input and output variables, function headers or signatures, types or schemas, shared constants, file and path ownership, dependency edges, and integration order. Name one integration owner for every shared boundary.

Split work into atomic slices. An atomic slice is independently ownable and independently verifiable, with explicit inputs, outputs, and a stable ownership boundary. Shard large beads, tasks, and multi-file operations by stable file or interface seams when the slices remain merge-safe.
- MUST Decompose an oversized bead into child beads linked to that bead as their parent.
- MUST Record real dependency and review edges for each child. Keep independent children unordered.
- MUST Require parent or aggregate fan-in before the parent completes.
- MUST Publish child inputs, outputs, ownership, and the integration owner before dispatch.

- MUST Compute the ready set at every scheduler level.
- MUST Dispatch every independent ready atomic slice up to the configured concurrency.
- MUST Serialize only strict dependencies, destructive shared resources, or irreducible shared mutation boundaries.
- MUST Treat shared epic, domain, or feature relationships as non-dependencies.

While critical-path work runs, fill available slots with real independent discovery, implementation, review preparation, verification preparation, or other ready product work. After every completion, failure, cancellation, claim release, or unblock, recompute that scheduler level's ready set and immediately refill available slots. Apply this rule recursively inside every epic or sub-lead and to every spawn-capable role.
- MUST Dispatch the initial ready set in one batch. Do not use that batch as a completion barrier.
- MUST Process each settled slice independently. Do not treat unresolved siblings as landed.
- MUST Integrate only the owned slice, recompute readiness, and refill capacity while other slices continue.
- MUST Serialize shared mutation and integration boundaries under their named owner.

Keep artifact-dependent review behind the artifact. Do not dispatch a review until its required artifact exists. The integration owner merges completed slices and publishes the next contract before dispatching related downstream slices.

## Write the DAG

- One epic per feature, ordered by dependency: each feature epic owns one integration branch and
  lands as one PR (`references/landing.md`).
- One task per unit an implementer finishes in one worktree:
  `bd create --parent <epic> --type task --title <t> --description <d> --metadata role=<r>`.
  The description names the scope (paths and symbols) and numbered acceptance criteria a
  reviewer can check without asking.
- `bd dep add <task> <depends-on>` for an order two tasks must keep.
- Every review bead depends on the task or tasks it reviews. DEFAULT One review bead per
  task: the review wave fans out to one reviewer each, in one `task` call. A single bead
  spanning the wave gives one reviewer over every implementation. Choose it for a wave of two
  or three beads whose interaction matters more than speed. Both surface as one review wave
  when the tasks land.
- Order epics with `bd dep add "<epic-B>" "<epic-A>"`.
- bd 1.3.0 refuses a blocking dependency from an epic to its ancestor decision. Gate the
  epic with `bd dep add "<task>" "<decision>"` for each task that needs it.
- Binding is ownership on the epic bead, not a file: `orc_bind { epic: <child> }` records this
  lead on that epic, and every session resolves the run by walking parent edges from the bead it
  holds. An epic a live lead owns refuses to bind, in any checkout; a run whose lead's claim has
  lapsed transfers, because ownership is a record and only the claim beside it expires.
- At the epic tier, `orc_status.ready` lists a child epic under three conditions. `bd ready`
  reports it unblocked. No lead holds it (binding claims the epic). At least one of
  its tasks is ready. An epic with no tasks stays in the wave; its lead plans it.
- `bd ready --parent <epic> --unassigned` is what `orc_status.ready` reads. A dependency is
  the only thing that keeps a task out of a wave.
- Independent tasks have no dependency between them.
- Before either epic runs, record a contract two epics share as a `decision` bead:
  LOAD `skill://orchestrate-with-bd/references/decisions.md`.
- Adopt beads that already exist under the epic. NOT Build a parallel DAG beside them.

When the domain is unfamiliar or the DAG does not exist, dispatch `orc-planner`. It creates
the beads and returns their ids. Otherwise write them yourself.

## DAG review

Before implementation starts, one `orc-reviewer` judges the run's DAG; the author of the DAG
(planner or human) makes no difference. Until a bead with `metadata.role` `dag-reviewer` exists under a
root run that has task beads, `orc_status` withholds `ready` and returns the `bd create` for
that bead. The lead runs that command. On the next `orc_status` the review bead is the wave:
one `orc-reviewer`. Its description lists the six guard-rails:

1. Every task names its paths or symbols and carries criteria a reviewer can verify; the
   implementer makes no design decision.
2. A task hides no decision.
3. Every review bead depends on the tasks it reviews.
4. Dependencies exist only for true ordering.
5. Every implementer bead carries a justified `metadata.tier`; `deep` and `max` are a minority.
6. A contract two or more epics share is a `decision` bead before those epics start.

`approve` closes the bead; `ready` then holds the implementation wave. `change` creates a
planner bead (`metadata.role` `planner`) that the review depends on. The next wave is
`orc-planner`. It revises the beads and closes the planner bead; the review re-runs on the
result. A child epic's lead sees no DAG review: the root review covers the tree.

## Verdicts

A review bead finishes through `orc_finish` with a `verdict`. The tool routes the next wave.
Tiers are static: no verdict changes a bead's tier.

| Verdict | Meaning | What `orc_finish` does |
|---|---|---|
| `approve` | every criterion met | closes the review bead |
| `fix` | a defect in the code: a bug, a failing or missing test, an unhandled input, a name | reopens the reviewed tasks unassigned with `fix_from`, `fix_kind`, `fix_round`, and `fix_findings` in their metadata; returns the review bead to open and unassigned |
| `change` | a stated criterion is not met; `criteria` names which | as `fix`, plus `fix_criteria` |
| `escalate` | this tier cannot resolve it; `cause` is `design`, `contract`, `security`, or `unbounded` | holds the task: `blocked`, unassigned, `held=<cause>`; the review returns to open |

A reviewer assumes the same implementer fixes a finding once it has the findings, and
escalates only what the tier cannot resolve. A defect the criteria do not name is still a
`fix`; an exploitable security or integrity defect is `escalate` with cause `security`; a
non-blocking scope addition is a note for the lead, never a verdict.

## The round cap and the lead's decision

`fix` and `change` are rounds. After two rounds at one tier, the third holds the task with
cause `repeated`: it bounced, was fixed, and bounced again, which is the history that
suggests an upgrade. The hold records the suggestion (`upgrade` below `max`, `split` at `max`
or for `unbounded`); the lead decides.

`orc_status.decisions` lists every held task with its tier, cause, rounds, the review that
raised it, and prior decisions. Only the lead holding the run epic may call `orc_decide`, and
each decision is a comment on the task:

| Action | When | What `orc_decide` does |
|---|---|---|
| `retry` | the findings changed between rounds | reopens the task at the same tier, rounds reset |
| `upgrade` | the same criterion failed twice, or the reviewer escalated for design, contract, or security | creates `Fix: <title>` one tier up with `escalated_from` and the decision history; the review depends on it; the task closes as superseded |
| `split` | cause `unbounded`, the task is `max`, or an upgrade already failed | creates a planner bead `Decompose: <title>`; the review depends on it; the task closes as superseded |
| `accept` | a `repeated` or `unbounded` hold whose findings do not describe a criterion-blocking defect; the reason is mandatory and recorded on the bead | closes the task and its reviews; a follow-up bead carries the residue; refused on `design`, `contract`, or `security` |
| `stop` | last resort | refused until an upgrade or split has been tried; then parks the task for the human |

The decision history (`decided`) follows every successor bead, so a part of a split or an
upgraded fix that is held again may be stopped.

A same-tier re-run reaches the same implementer agent. The wave item carries `fix.findings`
for the brief, and the lead adds a pointer to the previous worker's transcript
(`history://<agent name>`); the implementer searches it for the findings' paths and criteria
and reads only those ranges, never the whole transcript. When an implementer finishes `blocked` on a
missing prerequisite, the DAG has a gap. The lead creates the prerequisite at the same tier.
The blocked task depends on it.

## Dispatch

Each lead has its own `task.maxConcurrency` (OMP setting, default 32). OMP runs at most that
many workers at once and queues the rest of a wider `task` call. A
three-tier run can hold up to `root cap × (1 + child cap)` agents. Set the cap with that
product in mind; 6 to 8 suits a machine that also runs the human's session.

1. `orc_status` → read `orc_status.ready` as the first wave and rewrite the `todo` list.
2. Push your own branch before dispatching anything, and name the bead id and the base branch in
   every brief. A worker rebases its worktree onto `origin/<your branch>` before its first commit
   (`references/landing.md` steps 1 to 4); a stale base makes its push non-fast-forward. A worker
   starts from the branch its claim's worktree carries, never from a tree it did not create.
3. Dispatch every ready bead in one `task` call. State a reason when the call carries fewer items
   than `ready`.
4. On every delivered result, call `orc_status` and dispatch all of `newly_ready` at once. Never
   hold a newly unblocked bead for the rest of the wave. Serialize only named shared mutation or
   integration boundaries.
5. Merge each approved child PR into your branch, then run `orc_status`: review beads whose tasks
   have landed are in the ready set.
6. Dispatch them in one `task` call, one `orc-reviewer` per review bead. Each reviewer judges its
   bead at its PR's head and finishes with a verdict.
7. Run `orc_status` again. A `fix` or `change` shows the reopened task with `fix.findings`;
   dispatch it, and its claim returns the worktree and PR the previous round used. A held task
   appears under `decisions`: read its comments, call `orc_decide`, then run `orc_status` again;
   the successor bead is the wave.
8. Run `orc_status` again and redraw the `todo` list.

## The `todo` list

The `todo` list is a per-turn view of `orc_status`. Every entry is `<bead-id> <title>`
copied from `orc_status.todo`. The plugin's `todo_reminder` handler names any entry whose
first token is not a bead id in the bound run. On that advisory, re-read `orc_status` and
rewrite the list. `todo done` redraws the view; `orc_finish` changes the state.

## Pool discipline

Treat a pool alias as a shared ready queue. Never treat it as a durable worker identity. A successful claim replaces the alias with the concrete actor.

Name an alias after the agent that may take from it, prefixed once: `pool:orc-implementer`, `pool:orc-implementer-deep`, `pool:orc-implementer-max`, `pool:orc-reviewer`, `pool:orc-researcher`, `pool:orc-shepherd`, `pool:orc-merger`, `pool:orc-lead`. Eligibility is then a comparison against an agent's own identity rather than prose. Match aliases as exact strings. A prefix never selects a queue.

Escalate a tier by creating a clean `Fix:` successor bead in the deeper tier's queue. The predecessor closes as superseded and keeps its worktree and pull request; the successor carries the findings and decision history, but starts with no worktree or pull request, creates its own branch from the predecessor's branch, and opens its own pull request.

A merge slot belongs to its target's owner. It carries that owner's identity, and a reaper restores it to them. Only work beads carry `phase`.

A lead takes its epic from `pool:orc-lead` the same way a worker takes a task. An epic held by a live concrete actor stays refused, which is what keeps one lead per epic.

Record the phase alias on the bead when dispatching it. A reaper reads that recorded phase and restores the alias when reclaiming the bead.

Let a holder hand its own bead onward with one `bd update` write. A third party cannot hand the bead onward.

Do not claim the merge-bead protocol is verified end to end. The installed plugin has no interfaces to carry it. The one end-to-end run used lead-managed merges.

## Role lifetimes

| Role | Lifetime and boundary |
|---|---|
| Implementer | Keep one pulling implementer agent long-lived and reuse one worktree. |
| Researcher | Start a fresh agent for each research bead. |
| Reviewer | Start a fresh agent for each review round. |
| Security reviewer | Start a fresh agent for each security review. |
| Bot reviewer | Start a fresh agent for each bot-review round. |
| Scout or operator | Start a fresh helper for each invocation. |
| Coordinator | Keep one coordinator long-lived; it may order ready merge beads but never modifies a repository. |
| Merger | Start a fresh isolated agent for each merge bead. It rechecks the exact source revision and every required gate before integrating. |
