# Landing

The protocol every agent in a run follows, stated once. Every other file in this plugin cites
this one instead of restating it.

Two facts hold it together. Every agent works in its own Worktrunk-created linked worktree of
this repository, and the canonical checkout's working tree is never mutated by anyone. Work
travels to the default branch through GitHub pull requests, so nothing is landed by a local
merge into canonical: after a merge, canonical is refreshed with
`git -C <canonical> fetch origin`, which touches no working-tree file.

The OMP-wide half of that contract is not this plugin's: `rule://worktrunk-worktree-required`
requires the worktree and refuses a mutation aimed at canonical,
`rule://worktrunk-isolation-disabled` keeps native OMP isolation off, and
`rule://worktrunk-bd-contention-retry` says what to do when a `bd` call loses the single-writer
race. This file says what a run does with the worktrees those rules require.

## Branches

| Agent | Branch | Based on |
|---|---|---|
| root lead | `omp/run/<run-id>` | the default branch |
| feature epic lead | `omp/epic/<epic-id>` | `omp/run/<run-id>` |
| working agent (implementer, researcher, shepherd) | `omp/agent/<bead-id>` | its lead's branch |
| reviewer | `omp/agent/<review-bead-id>` | the reviewed PR's head branch |

An agent branch carries the **bead id**, never the agent name: the worktree belongs to the bead,
so it survives a fix round and a retry, which re-dispatch the same bead for another round at the
same tier. A tier escalation is a different bead, and step 7 says what that means for its branch.

Every branch begins `omp/`, and that prefix is what one CI filter matches on `head_ref`, so a
single exclusion covers every agent branch whatever it targets. `orc_bind` adds that exclusion when
this repository lacks it, in the worktree the call was made from or the one it is given, and names
the files it changed; commit them as the run's first change. It never writes the canonical checkout:
bound from canonical with no worktree it names those files as pending, and the lead calls
`orc_bind { epic, worktree: "<integration worktree>" }` once that tree exists.

## PR titles

- an agent's PR: `Agent <bead-id>: <bead title> → epic <epic-id>`
- a feature epic's PR to the default branch: `Feature epic <epic-id>: <epic title>`

The branch prefix carries the machine-readable part; the title carries the relationship a human
reads in a PR list.

## Sequence

0. The root lead decomposes the run into **one epic per feature**, with dependency edges between
   the features, and dispatches one `orc-lead` per ready feature. It does not hold one
   monolithic epic: each feature lands as a coherent, reviewable PR, and a conflict is scoped to
   one feature at a time.
1. A lead calls `orc_bind { epic }`, then creates its worktree
   (`wt switch -y --create --no-cd --base <parent-branch> --format json <its-branch>`), then
   `git push -u origin <its-branch>` **before dispatching**: a child cannot open a PR against a
   branch that is absent from the remote.
2. Each dispatch brief states two literals: the child's bead id and the base branch.
3. The child calls `orc_claim` **first**. When the claim returns a worktree the bead already
   carries, it works there — that tree holds the previous attempt. Otherwise it creates the
   worktree on `omp/agent/<bead-id>` and passes its path and branch back through `orc_claim`.
4. Before committing: `git -C <worktree> fetch origin <lead-branch>`, then
   `wt -C <worktree> step rebase origin/<lead-branch>`.
5. The child commits, pushes, opens its PR with base `<lead-branch>`, and reports the PR number
   and head SHA in its `orc_finish` comment.
6. `orc-reviewer` claims its review bead and creates a disposable worktree **at the PR head** —
   `git -C <canonical> fetch origin <pr-head-branch>` then
   `wt switch -y --create --no-cd --base origin/<pr-head-branch> --format json omp/agent/<review-bead-id>`,
   because a claim's worktree must sit on that bead's own `omp/agent/` branch. It runs every
   acceptance criterion's own check there, reviews `pr://<N>/diff`, and may comment on the PR and on
   the bead. It never pushes and never merges, and `orc_finish` removes that worktree each round.
7. A `fix` or `change` verdict and a lead's `retry` continue the **same bead**, so the successor's
   `orc_claim` returns the existing worktree, it force-pushes with `--force-with-lease`, and the
   same PR is re-reviewed at a new head. The prior attempt is the successor's starting point.
   A tier escalation is not that: `orc_decide upgrade` closes the held task as superseded and
   creates `Fix: <title>` one tier up, a new bead with no worktree of its own, whose wave item
   carries `escalatedFrom`. Its worker claims `omp/agent/<fix-bead-id>` and opens its own PR, so
   the brief bases that worktree on `omp/agent/<escalated-from>` to keep the prior attempt as the
   starting point. The superseded bead is closed with its tree still standing: the sweep tries it
   at the next session start and, its branch being unmerged, reports it for the lead rather than
   deleting it. `split` supersedes the same way, into a planner bead.
8. On `approve` the lead merges the child's PR; the child's `orc_finish` closed the bead and
   removed its worktree.
9. **On every delivered child result the lead calls `orc_status` and dispatches everything in
   `newly_ready` at once.** It never waits for a wave to drain: a bead the first finisher
   unblocked is dispatched before the slowest sibling returns. `wave` is a batching hint for the
   first dispatch, never a barrier.
10. At feature completion the feature epic lead opens its PR from `omp/epic/<epic-id>` to the
    default branch and merges it **on GitHub**, then reports completion so the features that
    depend on it become ready. Canonical is refreshed with `git -C <canonical> fetch origin`
    only.
11. After each feature merges, the root lead refreshes `omp/run/<run-id>` from
    `origin/<default-branch>` in its own worktree and pushes it. Without this, a feature epic
    created later bases on a run branch that predates every merged feature and its agents rebase
    onto stale code.
12. At run close, `bd dolt push` runs from the canonical checkout and its **exit status is
    checked** and reported. That is the run's durability step; no hook performs it.

## Topology

One worktree for the root lead, one per feature epic lead, one per in-flight agent bead, and a
disposable one per review round. Concurrent features never share a branch or a worktree. Leftover
worktrees are reclaimed by the session-start sweep, which is scoped to `omp/`-prefixed branches
and never touches an unrelated one.

## Failure handling

- A rebase conflict at step 4 belongs to the claimant, in its own worktree.
- A merge conflict at step 8 or 10 belongs to the lead, in the lead's worktree. It is never
  resolved by re-dispatching the bead.
- A missing base branch is a lead error: report and stop. Never retarget the default branch.
- A worktree that `orc_finish` could not remove comes back as an orphan on the bead with `wt`'s
  own stderr. The lead remediates it by hand; nothing automated passes `-f` or `-D`.
