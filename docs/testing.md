# Testing orchestrate-with-bd

Contributor reference: how each behaviour of the plugin is exercised end to end, and what each
run showed. Every scenario is a headless OMP session against a disposable fixture with its own
embedded Dolt store, so no run can touch another project's ledger. Most prompts name the epic plus
the scenario's own steering (the failure to provoke, the helper to use); the run header and the
skill are the plugin steering under test.

## Harness

### Fixture

```sh
mkdir -p /tmp/orc-e2e/<name>/repo && cd /tmp/orc-e2e/<name>/repo && git init -q -b main
printf '{"name":"calc","type":"module","private":true}\n' > package.json
mkdir src && printf 'export function add(a: number, b: number): number {\n\treturn a + b;\n}\n' > src/calc.ts
printf 'import { expect, test } from "bun:test";\nimport { add } from "./calc";\ntest("add", () => expect(add(2, 3)).toBe(5));\n' > src/calc.test.ts
printf 'node_modules/\n' > .gitignore && git add -A && git commit -q -m init
BEADS_ACTOR=omp/e2e-setup bd init --skip-hooks --skip-agents --prefix e2e$(openssl rand -hex 2)
test -d .beads/embeddeddolt || { echo "fixture is not embedded"; exit 1; }
printf 'interactions.jsonl\n' >> .beads/.gitignore && git rm -q --cached .beads/interactions.jsonl
git add -A && git commit -q -m "beads: embedded store"
```

A worktree fixture adds the worktrees the run needs; agents create their own, so the harness only
has to prove the store is shared:

```sh
wt -C /tmp/orc-e2e/<name>/repo switch -y --create --no-cd --base main --format json omp/integration/probe
bd -C "$(wt -C /tmp/orc-e2e/<name>/repo list --format json | jq -r '.items[]|select(.branch=="omp/integration/probe")|.worktree.path')" where
```

The printed path must be the fixture's own `.beads`, not the worktree's: that is the common-directory
sharing every scenario depends on.

Create beads with `BEADS_ACTOR=omp/e2e-setup bd create ... --json`. A task bead carries
`--metadata '{"role":"implementer"}'` (or `reviewer`, `researcher`, `shepherd`) and a description
with a file scope and numbered acceptance criteria. Dependency edges use `bd dep add` under bd
1.3.0; the fixture must use the installed version declared by the README.

### Session

```sh
cd /tmp/orc-e2e/<name>/repo
omp -p "orchestrate epic <id>: finish every task under it." \
  --session-dir /tmp/orc-e2e/<name>/session </dev/null > /tmp/orc-e2e/<name>/stdout.txt 2>&1 &
```

- `</dev/null` is required: with an open non-TTY stdin, `omp -p` waits for piped input forever.
- Per-session settings go in `--config <overlay.yml>` (for example `task:\n  maxConcurrency: 2`).
- To test an unreleased build, add `extensions:\n  - <worktree>/src/index.ts` to the overlay
  and pass `--plugin-dir <worktree>` so the skill and agents come from the same tree.
Never set `BEADS_DIR`, `BEADS_DB`, or `BD_DB` yourself. The beads plugin resolves the session store
and orchestrate inherits it. Never set `BEADS_DOLT_SERVER_MODE`, `BEADS_DOLT_SHARED_SERVER`, or
`BEADS_DOLT_SERVER_HOST`; orchestrate strips only `BEADS_DOLT_SHARED_SERVER` from native `bd` calls.
Workers use Worktrunk linked worktrees after `orc_claim`; native OMP isolation is not used.

### Reading a transcript

| What | Where |
| --- | --- |
| Root transcript | `<session-dir>/*.jsonl` |
| Child agents | `<session-dir>/<id>/<AgentName>.jsonl`; helpers nest one level deeper |
| Run header | `{"type":"custom_message","customType":"orc-run-header"}` |
| Dispatches | assistant `content[].type == "toolCall"`, `name == "task"`, `arguments.tasks[]` (`agent`, `name`) |
| Ledger calls | `toolResult` entries with `toolName == "write"`; `orc_status` text starts `orc_status <epic> (<status>, <shape>): N beads, N open, N ready` |
| Wave shape | one `task` call per `orc_status` whose `ready` lists several beads |
| Agent branches | `git branch --list 'omp/*'` in the fixture: `omp/integration/<epic-id>`, `omp/agent/<bead-id>` |
| Worktrees | `wt -C <fixture> list --format json`; `items[].worktree.main` marks the canonical checkout |
| Refill latency | the timestamps of one child's `orc_finish` and the next dispatch: a bead it unblocked must be dispatched before its slowest sibling returns |

### Cleanup

`wt -C /tmp/orc-e2e/<name>/repo remove -y --foreground <branch>` per leftover worktree, then
`rm -rf /tmp/orc-e2e/<name>`. The fixture's embedded database lives inside that directory, so
nothing outside it needs dropping and no shared process is ever stopped.

## Scenarios

Each row names its setup (the DAG where one applies), the prompt, and what the transcript must
show. "Observed" columns record the 2026-09-14 and 2026-09-15 runs on 0.4.2 to 0.4.11.

### Single tier

| Scenario | DAG | Prompt | Expect | Observed |
| --- | --- | --- | --- | --- |
| Independent wave | epic; 3 implementer tasks; 1 review bead depending on all three | `orchestrate epic E: finish every task under it, including the review, then close the epic.` | one `task` call with 3 implementers; 3 merges; 1 reviewer; epic closed | WORKS |
| Review fan-out | epic; 3 tasks; 3 review beads, one per task | same | one call ×3 implementers; 3 merges; one call ×3 reviewers under distinct actors | WORKS |
| Wide wave under a cap | epic; 10 tasks; 10 review beads; overlay `task.maxConcurrency: 4` | same | one call with 10 items; child starts staggered by 4; one call with 10 reviewers | WORKS |
| Bounce into the next wave | T1, T2, T3 (T3 depends on T1); R1 with a criterion T1 lacks; R2 | `...including reviews; act on every verdict.` | `[T1,T2]` → merge → `[R1,R2,T3]` → R1 `changes` → fix bead in the next `ready` → re-review → close | WORKS |
| Blocked task | task whose criteria need a file outside its scope that does not exist | `finish every task under it.` | implementer `orc_finish blocked`; bead `blocked` with a `blocked: ...` comment; epic finished `blocked` (bd refuses to close over a blocked child) | WORKS |
| Claim race | one task; prompt asks for two implementers on the same bead | explicit prompt | one `claimed: true`; the other `not claimed, held by <actor>` | WORKS |
| Rebind refusal | bound fixture | `Call orc_status with epic "<other>"` | `run already bound to <epic>` | WORKS |
| Truncation | epic with 520 tasks | `Call orc_status with epic BIG` | `500 beads ... (truncated)`; `ready` withheld | WORKS |
| Store contention | one task; six sibling `bd` writers driven against the fixture during a wave | `finish every task under it.` | no lost or duplicated claim; every failure text is one of the strings `worktrunk-bd-contention-retry` matches; a retry succeeds | NOT RUN (embedded cutover) |
| Security review | task that executes user input in a shell; review bead saying so | `...act on every verdict...` | reviewer dispatches `security-reviewer`; exploitable finding → `changes` → fix bead → re-review → close | INCOMPLETE: `security-reviewer` dispatched on every security-relevant diff and its CWE-78 verdict drove the first bounce (WORKS); the run was stopped at 67 min and 15 beads because the reviewer then judged each fix against defects the bead never named, and every worker brief told the implementer to skip tests. Both fixed in the agents (0.4.9); rerun pending |

### Store guards

| Scenario | Setup | Prompt | Expect | Observed |
| --- | --- | --- | --- | --- |
| Embedded store shared by worktrees | fixture plus six `wt`-created worktrees | `orchestrate epic <id>: finish every task under it.` | `bd where` in every worktree prints the fixture's canonical `.beads`; one claim is visible from all of them | NOT RUN (embedded cutover) |
| Worktrunk worker isolation | worker claims a task and creates its linked worktree | same | worker edits succeed under the returned Worktrunk path; canonical writes remain refused | NOT RUN (embedded cutover) |
| Canonical write refused | fixture; prompt asks a worker to edit a relative path | `finish every task under it.` | the mutation is refused, the reason names the canonical root, and the same write inside the worker's worktree succeeds (`worktrunk-worktree-required`) | NOT RUN (embedded cutover) |
| Missing store | `git clone` the fixture, `rm -rf .beads` | `orchestrate: report the store line of your run header and stop.` | `store: no .beads/metadata.json`; STOP; no `bd init` | WORKS |
| `bd init` gate (beads plugin) | empty dir | `Run exactly: bd init --skip-hooks ...` | the embedded init is allowed; a second `bd init` over an existing prefix is refused as a collision | WORKS |
| Bind then read | one task, one review bead | `finish everything under it, land every PR, and close the run epic.` | `orc_status` before `orc_bind` is refused and names the bind tool. `orc_bind` claims the epic and records the run on the epic bead. `orc_status` writes nothing (no `--claim` in its transcript). DAG review gate, 3/3 closed | WORKS (0.4.13): 5 min, one refusal then bind |
| Model-role preflight | fixture; `--config` overlay with `modelRoles.slow: nonexistent-provider/no-such-model` | `orchestrate epic <id>: finish everything under it and close it.` | STOP header naming `@slow (orc-implementer-max, orc-reviewer)` and `modelRoles.slow`; one sentence to the human; zero tool calls | WORKS (0.4.9) |

### Planner and roles

| Scenario | DAG | Prompt | Expect | Observed |
| --- | --- | --- | --- | --- |
| Planner from an empty epic | epic with only a decision bead | `...no task beads exist yet. Plan it: <units>, where <one> needs a research answer first, then finish every task including reviews.` | `orc-planner` first (spawns nothing); tasks with role metadata and per-task review beads; research bead; dependency on it | WORKS |
| Mixed-role wave | as above | as above | first wave carries researcher and implementers in one call; the dependent task waits; answer lands as a bead comment | WORKS |
| Implementer helpers | task spanning many files: "first dispatch `scout` to list call sites, then `operator` for the rename, quote both receipts" | `finish every task under it.` | implementer spawns `scout`, then `operator`; receipts in the `orc_finish` comment | WORKS (operator after malformed retries) |
| Reviewer helper | review bead: "confirm by dispatching `scout` to grep for `X`" | same | reviewer spawns `scout`; receipt quoted | WORKS |
| DAG review | three tasks and three review beads, no DAG-review bead | `finish everything under it, integrate into main, and close the run epic.` | `orc_status` withholds `ready` with the `bd create`. The lead runs it. One `orc-reviewer` runs before any implementer. On `changes` a planner bead follows, then the re-review, then the implementation wave | WORKS (0.4.11). The first review returned `changes`: a shared REGISTRY contract hid in one task. The planner added a decision bead and split the task. The re-review approved. Three implementers ran in one call |
| Verdict `fix` | review bead instructed to return `fix` on its first pass | same | the task reopens with `fix_from`, `fix_round`, `fix_findings`; the same agent re-runs it; the review returns to `ready` and approves | WORKS (0.4.11): `orc-implementer` re-ran the task, the review re-entered and approved |
| Verdict `change` / round cap | review bead instructed to return `change` twice, then `fix` | same | rounds 1 and 2 reopen the task for the same agent at the same tier with `fix_kind`, `fix_criteria`; the third holds it (`blocked`, `held=repeated`, `held_suggested=upgrade`) and `orc_status.decisions` lists it; nothing is dispatched until `orc_decide` | WORKS (V5 2026-09-16 on the linked 0.5.0 build, tiered round-3 fixture: round 1 returned 2 approve, 2 `fix`, 1 `change` with `fix_criteria=1`, 1 `escalate`; the same-tier re-runs closed and round 2 approved all three; epic closed 14/14, 21 tests) |
| `escalate` and `orc_decide` | review bead instructed to `escalate` with cause `contract` on a `max` task | same | the task is held with `held_suggested=split`; a non-lead's `orc_decide` is refused; the lead's `split` creates `Decompose: <title>` carrying `decided=split`; `stop` is refused before a split or upgrade and allowed on a part afterwards | WORKS IN PART (V5: `escalate (unbounded)` on `.9` held the task with the findings. The lead's `orc_decide accept` recorded its reason and filed follow-up `.14`, later implemented and reviewed. `split`, `upgrade`, `stop`, and the non-lead refusal have stateful-store tests only) |
| Historical: `changes` ladder (0.4.11-0.4.13) | review returned `changes` on `basic` / `max` | same | a fix bead one tier up / a `Decompose:` planner bead, automatically | WORKED on 0.4.11 and removed in 0.5.0: the A/B below showed the automatic ladder amplified reviewer variance (8 and 14 `changes` on one bead) |
| Implementer tiers | two tasks, `metadata.tier` `basic` and `deep`, one review bead depending on both | `finish everything under it, integrate into main, and close the run epic.` | `orc_status.wave` names `orc-implementer` and `orc-implementer-deep`; the child transcripts show those agents ran; reviewer over the merged diff | FAIL then WORKS on 0.4.9: the first run dispatched `orc-implementer` for the deep bead despite the wave (see defects); with the routing gate the deep child ran `orc-implementer-deep` |
| Shepherd (simulated bots) | PR bead with `pr`, `head_sha`, `bot_review_requests`; a `gh` shim first on `PATH` answering canned JSON per a `SCENARIO` file | `shepherd the PR bead, act on the outcome...` | actionable → policy `bounce` → fix bead with thread URLs → implementer → re-probe clean → closed; pending → request posted → `blocked` naming the provider | WORKS WITH DEVIATIONS (shim) |

### Three tier

| Scenario | DAG | Prompt | Expect | Observed |
| --- | --- | --- | --- | --- |
| Two child epics | run epic; decision; 2 child epics × 2 tasks; cross-epic review task under the run epic | `orchestrate epic R: it has two child epics and a cross-epic review; finish everything under it, land every PR, and close the run epic.` | one call ×2 `orc-lead`, each in its own worktree on `omp/integration/<epic-id>`; each binds its epic on the bead itself, with no file beside any checkout. Both epic PRs merge on GitHub. `ready` turns to the cross-epic review only after both epics close. Run closed. | WORKS on 0.4.8, before the worktree cutover |
| Sub-lead waves under a cap | child epics × 3 tasks × 3 review beads; overlay `task.maxConcurrency: 2` | same | each sub-lead: one 3-item implementer call → 3 merges → one 3-item review call | WORKS |
| Empty child epic | one child epic with no tasks | `...one is empty and needs planning...` | that sub-lead dispatches `orc-planner`, then waves | WORKS |
| Conflicting epics | both epics edit one file | same | conflict at the root; root resolves in its own tree | WORKS |
| Epic closed over open children | any | any | `orc_finish done` on the epic refused, ids listed | WORKS (unit); no refusal needed live once leads waited |

### Not exercised

- `orc-shepherd` against real review bots.
The run was stopped before a rerun against the current embedded-store cutover.

## Defects the matrix found

| Release | Defect | Fix |
| --- | --- | --- |
| 0.4.1 | `orc_finish blocked` always failed: `bd update` has no `--reason` | reason as a comment, then `--status blocked` |
| 0.4.1 | lead converted a store's backend unasked | header says STOP |
| 0.4.6 | lead still converted the store after reading the skill | a `tool_call` gate refused every `bd` and `.beads/` write in that session. Both the gate and the route it guarded were removed with the embedded cutover: there is nothing left to convert |
| 0.4.3 | lead closed an epic over two open review beads | `orc_finish done` on an epic refuses while a descendant is open |
| 0.4.4 | terminal check blind past 500 descendants | refuse on a truncated walk; `ready` withheld |
| 0.4.4 | open root decision entered the review wave | final wave holds `task` beads only |
| 0.4.7 | sub-lead yielded an empty result and its work was lost | `orc-lead` pushes its branch and always returns its receipt |
| 0.4.7, 0.4.8 | sub-leads edited the on-disk run pointer by hand | the run moved onto the epic bead, and that file was deleted |
| 0.4.9 | every worker brief told the implementer to skip tests (copied from OMP's `task` guidance about suites), so criteria went unverified and fix beads multiplied | header, skill, lead, implementer: the bead's own checks always run; only repository-wide suites and formatters are the lead's |
| 0.4.9 | reviewer judged each fix against defects the bead never named, producing an unbounded review chain | reviewer: a defect outside the criteria is a note, not a verdict, unless it is an exploitable security finding |
| 0.4.9 | lead read a wave naming `orc-implementer-deep` and dispatched `orc-implementer` | `tool_call` on `task` routes each item that names one wave bead to that entry's `agent` |
| 0.4.9 | `orc-reviewer` named the custom alias `@reviewer`; on a machine without `modelRoles.reviewer` OMP runs it on the caller's model without notice | every shipped agent names a built-in role; the preflight resolves each alias through `ctx.models.resolve` and stops the session when one has no callable model |
| 0.5.0 (V5) | the delivery gate, after its 2026-09-16 hardening, refuses every mutation in the canonical checkout (`merge`, `add`, `apply`, `reset`) unless the repository's own `AGENTS.md` carries the exact authorization line; the lead stopped twice and the human landed the branches | bead `omp-orchestrate-i3q`; resolved by the worktree cutover, which merges nothing in canonical: a lead merges in its own worktree and a feature lands as a PR on GitHub |
| 0.4.13 | the automatic escalation ladder (`changes` -> fix bead one tier up -> planner at `max`) turned reviewer variance into cost: in the A/B (`6hf`) one `deep` bead drew 8 `changes` in the tiered arm and 14 in the all-basic arm, three decompositions between them | 0.5.0: tiers are static; `fix`/`change` re-run the same tier for at most two rounds; `escalate` or a third round holds the task for the lead's recorded `orc_decide` |
| 0.4.11 | a session lost its provider credentials mid-run (`stopReason: error`, DNS failure in the credential process); the lead stopped after the merge with the reviews undispatched | environmental; a new `orchestrate epic <id>: resume` session rebound the run and finished it in 7 minutes |

