# Roles

Eight agents ship with the plugin. Every model is one of OMP's built-in role aliases, so a
fresh install needs no `modelRoles` entry. An agent with no `tools:` line inherits the whole
inventory, including `task`.

Every agent works in its own Worktrunk worktree of the repository. Each claim brands that worktree
on the bead it holds, including a reviewer's disposable tree at the PR head. `orc_finish` reclaims
the reviewer's tree on every verdict, so the next round builds one at the new head
(`references/landing.md`). Only a planner and a DAG review create no worktree.

| Agent | Model | Spawns | Claims |
|---|---|---|---|
| `orc-lead` | `@plan` | planner, the three implementers, reviewer, researcher, shepherd, scout, operator | its epic, at bind |
| `orc-planner` | `@plan` | none (`spawns: false`) | never |
| `orc-implementer` (basic) | `@task` | scout, operator | its task bead |
| `orc-implementer-deep` | `@plan` | scout, operator | its task bead |
| `orc-implementer-max` | `@slow` | scout, operator | its task bead |
| `orc-reviewer` | `@slow` | scout, security-reviewer | its review bead, or the run's DAG review |
| `orc-researcher` | `@smol` | none | its research bead |
| `orc-shepherd` | `@task` | none | its PR bead |

## Implementer tiers

The planner marks a task bead `--metadata tier=<basic|deep|max>`. `orc_status.wave` names
the tier and its agent. The lead dispatches that agent. A missing tier is `basic`. An
unrecognised value is `deep`, so a malformed mark never routes hard work down.

| Tier | Test the planner applies | Agent |
|---|---|---|
| `basic` | mechanical or pattern-following, criteria fully specified, no design decision | `orc-implementer` |
| `deep` | judgment inside a fixed scope (see the list below) | `orc-implementer-deep` |
| `max` | being wrong is expensive: a migration, an irreversible operation, a contract every epic depends on | `orc-implementer-max` |

`deep` covers work that needs judgment inside its scope:

- a hidden algorithm or invariant;
- a surface that handles untrusted input or secrets;
- a surface that handles authentication or the shell;
- a contract other beads consume;
- concurrency or error semantics.

A bead that is not bounded (files unnamed, criteria not verifiable) has no tier. Split it, or
add a `decision` or research bead. `deep` and `max` together stay a minority of a DAG. A DAG
that is mostly `deep` is under-decomposed. If `@plan` and `@slow` resolve to the same model,
the two upper tiers share one model until `modelRoles.slow` differs from `plan`.

## Review roles

Two review beads exist. A bead with `metadata.role` `reviewer` judges the tasks it depends
on. A bead with `metadata.role` `dag-reviewer` judges the run's DAG; `orc_status` returns
the command that creates it and withholds the wave until it exists. A bead with
`metadata.role` `planner` is planner work `orc_finish` created (a DAG revision, or the
decomposition of a task the lead chose to split); the wave dispatches `orc-planner` for it.
The verdict table and the lead's decisions are in `references/planning.md`.

## Model overrides

Remap any agent without touching the plugin through OMP's own per-agent setting:

```yaml
task:
  agentModelOverrides:
    orc-reviewer: "@reviewer"          # a custom alias you define in modelRoles
    orc-implementer-max: "provider/model-id:high"
```

## Marketplace installs

The marketplace form, `omp plugin install orchestrate-with-bd@<marketplace>`, discovers
the agents through OMP's claude-plugins lane, which drops every `model:` line
(`task/discovery.ts`, `ignoreModel`). An npm or `omp plugin link` install is an extension
root and keeps the frontmatter. Under the marketplace form, without one of the two
settings below, the agents run on the caller's model:

- `extensions:` in the OMP config lists the plugin path
  (`~/.omp/plugins/node_modules/@srobroek/orchestrate-with-bd`), so the agents load through
  the extension lane with their frontmatter intact.
- `task.agentModelOverrides` names each of the eight `orc-*` agents with the alias from the
  table above.

The preflight below does not detect this case.

## Model-role preflight

When a prompt says `orchestrate`, the plugin resolves every alias the shipped agents name
through OMP's resolver. Without this check, an alias with no callable model makes OMP run
that agent on the caller's model without notice. Causes: no credentials for the role's
providers, or a role pinned to a model this machine cannot call.

On a failure the header says STOP and names:

- the alias and the agents that name it;
- the `modelRoles.<role>` key to set.

Until a new session starts, the `tool_call` gate refuses `task` and all six ledger tools. The
gate enforces the STOP even if the model tries to continue. Before a ledger call, it verifies that
the active shipped agent's alias resolves to the session's active provider and model id.

For `orc_claim`, the gate also reads the active agent's `ORC-ROLE` marker and requires the matching
`agent` input. A correctly named pool worker proceeds. A missing or different identity is refused
before the claim. The preflight reads shipped frontmatter. It does not inspect
`task.agentModelOverrides`, so it cannot detect a broken override.

## Enforcement that is not prose

- `orc-lead` omits itself from `spawns:`. OMP preflight refuses any name outside an
  explicit `spawns:` list with `Cannot spawn 'orc-lead'`, so a sub-lead cannot start a
  lead. The root session carries no spawn policy and is the only place epic leads start.
- `orc-planner` has `spawns: false`; it cannot dispatch anything.
- Workers have no `todo` tool: OMP withholds it from every dispatched agent. Their only
  progress record is `orc_finish`.
- A worker with an explicit `tools:` line names `orc_claim` and `orc_finish`; the reviewer,
  researcher, and shepherd do. Extension tools are not inherited past an explicit list.

## Depth

`maxRecursionDepth` counts from the root session at depth 0. Two tiers need 2 (lead →
implementer → scout). Three tiers need 3 (root → epic lead → implementer → scout).

## Helpers

Three helpers exist, and none of them claims a bead, commits, or touches a PR.

- `scout` (ships with OMP) answers one bounded read-only question.
- `operator` (`build` plugin, `srobroek-omp` marketplace) performs one exact mechanical
  operation in the caller's checkout.
- `security-reviewer` (ships with OMP) grades one security concern on a named diff.

Before writing where a helper worked, await the helper's terminal result.

## Briefs

A brief names the bead id, the role, and what the bead does not already say. Unless the
agent is `orc-lead`, the brief never contains the word `orchestrate` in lowercase. OMP's own
keyword notice reaches any dispatched agent that has `task` and a brief with that word. The
agents above are the whole surface. Nothing else in this plugin dispatches, claims, or
reviews.

