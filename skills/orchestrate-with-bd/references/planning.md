# Planning

The DAG is the plan. A step with no bead is not work the run knows about.

## Shape

Two tiers by default: the lead dispatches workers directly and integrates their branches.

```
lead (root session, or orc-lead for one epic)
├─ orc-planner        writes the DAG, returns          not isolated
├─ orc-implementer    ready task beads per wave          isolated: true
├─ orc-reviewer       one review bead each, in review waves     not isolated
├─ orc-researcher     one question each                  not isolated
└─ orc-shepherd       one PR bead each                   not isolated
```

Three tiers for a multi-epic run. The root session dispatches one `orc-lead` per epic with
`isolated: true`. Each brief names its epic and contains the word `orchestrate`, so the epic
lead receives the same run header. Each epic lead runs the two-tier shape inside its clone.
OMP captures the lead's final tree as `omp/task/<lead-name>`, and the root merges those
branches. `maxRecursionDepth` is 2 for two tiers and 3 for three.

A cross-epic review is a review bead placed directly under the run epic. bd refuses a
task-to-epic dependency, so `orc_status.ready` gates it instead:

- While any child epic stays open, `ready` holds epics.
- Once the leads close every child epic, `ready` holds the run epic's own `task` beads.
- The root merges the epic branches first.
- Then the root dispatches that review wave over the run's `merge-base..HEAD` diff.
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

- One epic per independent deliverable. `bd create --type epic --title <t>`.
- One task per unit an implementer finishes in one isolated checkout:
  `bd create --parent <epic> --type task --title <t> --description <d> --metadata role=<r>`.
  The description names the scope (paths and symbols) and numbered acceptance criteria a
  reviewer can check without asking.
- `bd dep add <task> <depends-on>` for an order two tasks must keep.
- Every review bead depends on the task or tasks it reviews. DEFAULT One review bead per
  task: the review wave fans out to one reviewer each, in one `task` call. A single bead
  spanning the wave gives one reviewer over every implementation. Choose it for a wave of two
  or three beads whose interaction matters more than speed. Both surface as one review wave
  when the tasks land.
- Epic order is an epic-to-epic dependency: `bd dep add <epic-B> <epic-A>`. bd 1.2.2 refuses
  an epic-to-decision dependency, so a decision gates an epic through its tasks:
  `bd dep add <task> <decision>` for each task that needs it.
- An isolated clone carries the root's locator. When a sub-lead calls
  `orc_bind { epic: <child> }` for an epic under the inherited run, the clone rebinds to
  that child and keeps the run root. For any other epic, `orc_bind` refuses: that is a
  different run.
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
one `orc-reviewer`, not isolated. Its description lists the six guard-rails:

1. Every task names its paths or symbols and carries criteria a reviewer can verify; the
   implementer makes no design decision.
2. A task hides no decision.
3. Every review bead depends on the tasks it reviews.
4. Dependencies exist only for true ordering.
5. Every implementer bead carries a justified `metadata.tier`; `deep` and `max` are a minority.
6. A contract two or more epics share is a `decision` bead before those epics start.

`approve` closes the bead; `ready` then holds the implementation wave. `changes` creates a
planner bead (`metadata.role` `planner`) that the review depends on. The next wave is
`orc-planner`. It revises the beads and closes the planner bead; the review re-runs on the
result. A child epic's lead sees no DAG review: the root review covers the tree.

## Verdicts and escalation

A review bead finishes through `orc_finish` with a `verdict`. The tool routes the next wave.

| Verdict | Meaning | What `orc_finish` does |
|---|---|---|
| `approve` | every criterion met | closes the review bead |
| `fix` | every finding is local | reopens the reviewed tasks unassigned with `fix_from`, `fix_round`, and `fix_findings` in their metadata; returns the review bead to open and unassigned |
| `changes` | a criterion misread, a design or contract change, or an exploitable security finding | creates `Fix: <title>` one tier up under the task's parent with `escalated_from`; the review bead depends on it and returns to open and unassigned |

Local findings are of these kinds:

- a type narrowing;
- a missing or flaky test;
- a null check;
- a name.

The grade is by kind, never by count. A finding the criteria do not name is a comment on
the bead, never a verdict, unless the reviewer grades it exploitable.

The ladder is `basic` -> `deep` -> `max`. On a `max` task, `changes` creates no fix bead.
Instead `orc_finish`:

- sets `bounce=max` on the task;
- creates a planner bead `Decompose: <title>`;
- makes the review depend on that bead.

`orc-planner` then splits the task into bounded beads, makes the review depend on each, and
closes the planner bead.

A `fix` re-run reaches the same agent at the same tier. The wave item carries `fix.findings`
for the brief. When an implementer finishes `blocked` on a missing prerequisite, the DAG has
a gap. The lead creates the prerequisite at the same tier. The blocked task depends on it.

## Plan mode

A plan-mode plan for a run has a `## Beads` section. It lists the epic id and every task
bead the plan implements, one per line as `<bead-id> <title>`. Before adding a step without
a bead, create the bead. A plan whose steps outnumber its beads is not approved work.

```markdown
## Beads
- repo-pih            Epic: interactive browser fixture
- repo-pih.1          Add the click harness
- repo-pih.2          Record the network log
```

## Dispatch

Each lead has its own `task.maxConcurrency` (OMP setting, default 32). OMP runs at most that
many workers at once and queues the rest of a wider `task` call. A
three-tier run can hold up to `root cap × (1 + child cap)` agents. Set the cap with that
product in mind; 6 to 8 suits a machine that also runs the human's session.

1. `orc_status` → read `orc_status.ready` as the current wave and rewrite the `todo` list.
2. Dispatch every ready bead in one `task` call. State a reason when the call carries fewer
   items than `ready`.
3. Process each settled item as it returns. Do not treat unresolved siblings as landed.
   Recompute `orc_status` readiness and dispatch newly ready items while other items continue.
   Serialize only named shared mutation or integration boundaries.
4. Run `orc_status` after integrating all artifacts required by the review boundary.
   Review beads that depend on those artifacts form the ready wave.
5. Dispatch them in one `task` call, one `orc-reviewer` per review bead. Each reviewer judges
   its bead against the integrated `merge-base..HEAD` diff and finishes with a verdict.
6. Run `orc_status` again. A `fix` shows the reopened task with `fix.findings`; a `changes`
   shows the fix bead one tier up, or a planner bead. Dispatch that wave; the review bead
   follows once it closes.
6. Turn every `changes` finding into a fix bead for the next wave.
7. Run `orc_status` again and redraw the `todo` list.

## The `todo` list

The `todo` list is a per-turn view of `orc_status`. Every entry is `<bead-id> <title>`
copied from `orc_status.todo`. The plugin's `todo_reminder` handler names any entry whose
first token is not a bead id in the bound run. On that advisory, re-read `orc_status` and
rewrite the list. `todo done` redraws the view; `orc_finish` changes the state.
