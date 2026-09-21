# orchestrate-with-bd

An OMP plugin that records native `orchestrate` runs in a Beads ledger. OMP runs agents and lands results; the plugin records bead ownership, dependencies, and outcomes.

| | |
| --- | --- |
| Status | Prerelease. OMP reports the installed version. |
| Requires | OMP 18.1.19 or later, `bd` 1.3.0 or later, Worktrunk (`wt`) 0.77.0 or later, and `gh` 2.100 or later for review tools |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Required companion plugins

The `beads`, `build`, and `worktrunk` plugins are required. Each extension publishes a presence marker:

- `Symbol.for("com.srobroek.beads.present.v1")`
- `Symbol.for("com.srobroek.build.present.v1")`
- `Symbol.for("com.srobroek.worktrunk.present.v1")`

If a marker is missing, the session stops with:


> STOP. omp-orchestrate requires companion plugins that are not loaded: <list>. Enable them from the srobroek-omp marketplace, then restart the session.

omp-orchestrate is the sole writer of `BD_ACTOR`/`BEADS_ACTOR` for run agents; the beads plugin's `bd-actor-gate` only enforces presence; loader order is irrelevant because the gate reads the rewritten input.

## Concepts

A run is one Beads epic per feature, with tasks and review beads beneath it. Typing `orchestrate` injects a run header naming the store, bound epic, actor, and lead contract. Workers claim their assigned beads, work in Worktrunk linked worktrees, and finish with evidence.

The beads plugin resolves the session's embedded store and `BEADS_DIR`; orchestrate never overrides it. `bd dolt pull` runs before claiming work, and `bd dolt push` runs after each delivered epic or feature. Closing an epic through `orc_finish` also pushes the store and reports push failures without rolling back the close.

## Install

```sh
omp plugin marketplace add srobroek/orchestrate-with-bd
omp plugin install orchestrate-with-bd@orchestrate-with-bd
```

## Tools

| Tool | Does |
| --- | --- |
| `orc_bind` | Binds and claims the run epic. |
| `orc_status` | Reports descendants, leases, ready waves, waiting reviews, and decisions. |
| `orc_next` | Returns the next ready bead for the bound run. |
| `orc_claim` | Claims a bead and records its Worktrunk worktree. |
| `orc_finish` | Records evidence and closes, blocks, or reopens a bead. Epic close pushes the embedded store. |
| `orc_release` | Releases a bead with ownership CAS or an explicit forced reason. |
| `orc_decide` | Records the lead's decision on a held task. |
| `orc_bot_review_probe` | Classifies a review-bot round at its exact head. |
| `orc_bot_review_request` | Requests one allowlisted provider review at an exact head. |
| `orc_conflict_probe` | Predicts merge conflicts and reads CI without touching a tree. |
| `orc_review_round_policy` | Decides whether an actionable review round bounces to a fix bead or escalates. |

## Agents and worktrees

The plugin provides `orc-lead`, `orc-planner`, `orc-implementer`, `orc-implementer-deep`, `orc-implementer-max`, `orc-reviewer`, `orc-researcher`, `orc-shepherd`, and `orc-merger`. Model roles and tiers are listed in [skills/orchestrate-with-bd/references/roles.md](skills/orchestrate-with-bd/references/roles.md).

Workers run in Worktrunk linked worktrees. After `orc_claim`, a worker runs `wt switch -y --create --no-cd --base <base> --format json omp/agent/<bead-id>` and works under the returned path. Native OMP isolation is not used.

The skill [skills/orchestrate-with-bd/SKILL.md](skills/orchestrate-with-bd/SKILL.md) defines the operating procedure. Ledger details are in [skills/orchestrate-with-bd/references/beads-store.md](skills/orchestrate-with-bd/references/beads-store.md).

## License

Apache-2.0.
