# orchestrate-with-bd

An OMP plugin that keeps a [Beads](https://github.com/gastownhall/beads) ledger beside OMP's
native `orchestrate` keyword. OMP runs the agents and lands the result. The plugin records
which beads exist, who holds each one, and how each one ended.

| | |
| --- | --- |
| Status | Prerelease. OMP reports the version it installs. |
| Requires | OMP 18.1.19 or later, `bd` 1.3.0 or later in shared-server mode, `gh` 2.100 or later for the review tools |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md): architecture, tests, development |

## How it works

1. A run is one Beads epic. Its tasks are the beads under it.
2. Typing `orchestrate` in a prompt injects a run header naming the store, the bound epic,
   and the lead contract. The lead dispatches workers through OMP's `task` tool.
3. A worker calls `orc_claim` on the bead its brief names and `orc_finish` with its
   evidence. Beads' atomic assignee is the only lock. Implementers edit in the isolated
   clone OMP gave them; reviewers, researchers, and shepherds edit nothing.
4. The lead's `todo` list is a view of `orc_status`: every entry is `<bead-id> <title>`. An
   entry with no bead behind it draws one advisory message.
5. Every clone reaches the same database because the store runs on the machine's shared
   Dolt server, named by the tracked `.beads/metadata.json`.

## Install

```sh
omp plugin marketplace add srobroek/orchestrate-with-bd
omp plugin install orchestrate-with-bd@orchestrate-with-bd
```

The `operator` helper the implementer may spawn comes from the `build` plugin in the
`srobroek/omp-plugins` marketplace; `scout` ships with OMP.

## Store

The project's Beads store runs in shared-server mode: `.beads/metadata.json` pins
`"dolt_mode": "server"` and `.beads/config.yaml` carries `dolt.shared-server: true`. A new
project gets there with `bd init --shared-server`. On an embedded store the ledger tools
return the migration route and write nothing.

A session migrates an embedded store only when it meets five gates, which
`skills/orchestrate-with-bd/references/beads-store.md` states in full:

- a stable `bd` 1.3.0 or later
- every participating client on a compatible release
- a verified native backup outside the checkout
- one designated migrator
- the post-migration verification the run header demands

Such a session runs a bounded command list and orchestrates nothing. Otherwise `bd`,
`.beads/` writes, the ledger, and dispatch are all refused, and the header carries one
sentence for the human.

## Tools

| Tool | Does |
| --- | --- |
| `orc_bind` | claims the run epic for this lead and writes the locator; the one write outside claim and finish |
| `orc_status` | reads every bead under the bound run; `todo` holds `<bead-id> <title>` for the open ones; writes nothing |
| `orc_claim` | `bd update <bead> --claim`, then reads the assignee back |
| `orc_finish` | writes the comment, then `bd close` or `bd update --status blocked`; on a review bead applies the verdict |
| `orc_decide` | the lead's decision on a held task: retry, upgrade, split, accept, or stop; refuses anyone but the run's lead |
| `orc_bot_review_probe` | classifies a PR's review-bot round at its exact head |
| `orc_bot_review_request` | requests one allowlisted provider review at an exact head |
| `orc_conflict_probe` | predicts merge conflicts and reads CI without touching a tree |
| `orc_review_round_policy` | decides whether an actionable round bounces to a fix bead or escalates |

## Agents

- `orc-lead`, `orc-planner` on `@plan`
- `orc-implementer` on `@task`, `orc-implementer-deep` on `@plan`, `orc-implementer-max` on `@slow`
- `orc-reviewer` on `@slow`, `orc-researcher` on `@smol`, `orc-shepherd` on `@task`

Every model is one of OMP's built-in role aliases, so a fresh install needs no
`modelRoles` entry. Remap an agent with OMP's `task.agentModelOverrides.<agent>`.

- Preflight: when a prompt says `orchestrate`, the plugin resolves each alias through OMP's
  resolver. If one has no callable model, the session stops and names the `modelRoles.<role>`
  key to fix.
- Tiers: the planner marks each implementer bead `metadata.tier` (`basic`, `deep`, `max`);
  `orc_status.wave` names the agent for every ready bead. Tiers are static: no verdict
  changes one.
- Verdicts: a review bead finishes with `approve`, `fix` (a code defect) or `change` (a
  criterion not met), both re-running the same implementer at the same tier for at most two
  rounds, or `escalate` with a cause. A third round or an `escalate` holds the task under
  `orc_status.decisions`; only the lead moves it, with `orc_decide`, and the reason is
  recorded on the bead.
- DAG review: one reviewer judges the DAG against the planner guard-rails before the first
  implementation wave; `orc_status` withholds the wave until that bead exists.
- The marketplace install form (`name@marketplace`) drops agent `model:` lines; list the
  plugin under `extensions:` or set `task.agentModelOverrides` for the eight `orc-*` agents.
  npm and `omp plugin link` installs keep them (`references/roles.md`).
- Isolation: implementers and epic leads run `isolated: true`.

The skill `skill://orchestrate-with-bd` holds the procedure; `references/roles.md` holds the
model, tier, spawn, and depth table.
## License

Apache-2.0.
