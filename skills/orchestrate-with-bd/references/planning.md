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
| `accept` | non-blocking residue only, never a `security` hold | closes the task and its reviews; a follow-up bead carries the residue |
| `stop` | last resort | refused until an upgrade or split has been tried; then parks the task for the human |

The decision history (`decided`) follows every successor bead, so a part of a split or an
upgraded fix that is held again may be stopped.

A same-tier re-run reaches the same implementer agent. The wave item carries `fix.findings`
for the brief, and the lead adds the previous worker's transcript (`history://<agent name>`)
so the new agent starts from the earlier work. When an implementer finishes `blocked` on a
missing prerequisite, the DAG has a gap. The lead creates the prerequisite at the same tier.
The blocked task depends on it.

## Dispatch

Each lead has its own `task.maxConcurrency` (OMP setting, default 32). OMP runs at most that
many workers at once and queues the rest of a wider `task` call. A
three-tier run can hold up to `root cap × (1 + child cap)` agents. Set the cap with that
product in mind; 6 to 8 suits a machine that also runs the human's session.

1. `orc_status` → read `orc_status.ready` as the current wave and rewrite the `todo` list.
2. Dispatch every ready bead in one `task` call. State a reason when the call carries fewer
   items than `ready`.
3. When the wave lands, merge every captured `omp/task/<agent-name>` branch into your tree.
   Resolve conflicts there. When `.beads/interactions.jsonl` conflicts, keep both sides.
4. Run `orc_status` again. The review beads, which depend on the landed tasks, are now the
   `ready` wave.
5. Dispatch them in one `task` call, one `orc-reviewer` per review bead. Each reviewer judges
   its bead against the integrated `merge-base..HEAD` diff and finishes with a verdict.
6. Run `orc_status` again. A `fix` or `change` shows the reopened task with `fix.findings`;
   dispatch it. A held task appears under `decisions`: read its comments, call `orc_decide`,
   then run `orc_status` again; the successor bead is the wave.
7. Run `orc_status` again and redraw the `todo` list.

## The `todo` list

The `todo` list is a per-turn view of `orc_status`. Every entry is `<bead-id> <title>`
copied from `orc_status.todo`. The plugin's `todo_reminder` handler names any entry whose
first token is not a bead id in the bound run. On that advisory, re-read `orc_status` and
rewrite the list. `todo done` redraws the view; `orc_finish` changes the state.
