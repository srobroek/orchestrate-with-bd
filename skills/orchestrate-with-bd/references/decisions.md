# Decision beads: cross-boundary policy and duplicate resolution

The carrier table and bead-local `NOTE` defaults are authoritative in `rule://beads-carriers`.
This reference covers only the durable cross-boundary decision record: creating a `decision` bead,
how each edge type renders, and resolving decisions that compete for one `decision_key`.

## Cross-boundary decision beads

Create a first-class decision under the epic before the choice affects a second bead, agent,
package, shared contract, ordering rule, or later work:

```text
type: decision
decision_key: <stable run-unique policy key>
decision_owner: <one accountable actor>
description: <choice and affected scope>
design: <rationale, known evidence, unknowns, bounds, and alternatives>
acceptance: <objective verification or acceptance evidence>
decision_disposition: <proposed|accepted|rejected|superseded|duplicate|conflict>
status: <open|in_progress|closed>
```

Use `relates-to` for affected work and `validates` for work that supplies or checks
acceptance evidence:

```text
bd dep add <affected-bead> <decision-bead> --type relates-to
bd dep add <validator-bead> <decision-bead> --type validates
```

Both edge types are non-blocking. Never use `blocks` for accepted policy or to attach an
already-running or closed affected bead. Ordering work still uses a separate task dependency.
An accepted, rejected, duplicate, or superseded decision is closed with a
disposition-specific reason; closed means resolved, not erased.

## How an edge type renders

`bd show` has a heading for four types only:

| Type | Near end | Far end | Gates `bd ready` |
|---|---|---|---|
| `blocks` | `DEPENDS ON` | `BLOCKS` | yes |
| `parent-child` | `PARENT` | `CHILDREN` | no |
| `discovered-from` | `DISCOVERED FROM` | `DISCOVERED` | no |
| `relates-to` | `RELATED` | `RELATED` | no |

`caused-by`, `validates`, `supersedes`, `duplicates`, `tracks`, and `until` store correctly
and print their type in `bd dep tree`, but `bd show` renders each as `DEPENDS ON` near-side
and `BLOCKS` far-side. A reader of `bd show` therefore sees ordering that does not exist.
Where the precise type carries policy meaning, as `validates` and `supersedes` do for
decision beads above, keep it and rely on `bd dep tree`. Anywhere a reader is the audience,
prefer a rendering type and put the distinction in `notes`.

`blocks` is the only type that gates `bd ready`. Every other type documents a relationship
rather than enforcing one, `until` included.

`--type` is NOT validated. Every string is accepted and stored verbatim, including a typo,
which creates a real edge: `bd dep tree` traverses it and `bd show` renders it under
`DEPENDS ON`. A typo reads as a dependency that does not exist. Copy the type rather than
typing it.

`replies-to` threads wisp messages and dies with them, so it cannot carry a durable finding.
`related` stores as a distinct string from `relates-to` with no documented meaning; leave it
alone.

## Duplicates

Two beads that are the same work get `bd duplicate <id> --of <canonical>`, never a hand-built
edge. The command closes the duplicate and leaves the canonical open, which is the outcome a
reader needs; a `relates-to` edge would leave both open and still competing for a claim.

```text
bd duplicate <duplicate-id> --of <canonical-id>
bd update <canonical-id> --append-notes "DUPLICATE <duplicate-id>: <what matched>"
```

The stored edge type is `duplicates`, and `bd show` renders it as `DEPENDS ON` on the
duplicate and `BLOCKS` on the canonical, so the closed status carries the meaning rather than
the heading. Note on the canonical, because that is the bead that survives. Search first:
`bd search` or `bd duplicates` surfaces candidates, and closing the wrong side loses the bead
a reader will look for.

## Edge reasoning lives in `notes`

An edge carries no annotation. `bd dep add` has no note field, and `note`, `reason`, and
`metadata` keys in the `--file` JSONL are accepted and then dropped, so an annotated bulk
write reports success while storing nothing. Each edge's reasoning therefore goes in the
ORIGINATING bead's `notes`, naming the other bead by id:

```text
bd dep relate <finding> <root-cause>
bd update <finding> --append-notes "ROOT CAUSE <root-cause-id>: <evidence>"
```

`--append-notes` preserves earlier lines, so multiple edges accumulate. `bd show` renders
`notes` directly above the edge list, which puts the reasoning next to the relationship it
explains. One line per edge, on the originating side only: the edge already renders from both
ends.

## Competing decisions

Before creation, after restart, and before action, list every decision under the epic with
`bd list --type decision --parent <epic> --all --json`. Decisions compete only when their
nonempty `decision_key` values match.

Resolve each competing key deterministically:

1. Read every candidate and its `supersedes` edges. Reject an edge that crosses a
   `decision_key`, targets a missing bead, or creates a cycle.
2. When accepted candidates contain a valid explicit `supersedes` chain, canonical is the
   newest accepted unsuperseded head by `created_at`, then bead id. Every older candidate in
   that key becomes `superseded`.
3. When no explicit supersession exists, canonical is the earliest candidate by `created_at`,
   then bead id. Every other candidate becomes `duplicate`.
4. Read canonical again. Its `decision_disposition` must be `accepted`. Never update canonical
   while marking noncanonical beads.

Persist every noncanonical disposition as a resumable transaction. Read before each command
and skip a step whose exact result already exists:

```text
# Mark the noncanonical bead first.
bd update <noncanonical> \
  --set-metadata decision_disposition=<duplicate|superseded> \
  --set-metadata canonical_decision=<canonical>

# Duplicate: loser points to canonical without blocking it.
bd dep add <loser> <canonical> --type relates-to
bd close <loser> --reason "duplicate of <canonical>"

# Superseded: canonical explicitly supersedes the older decision.
bd dep add <canonical> <older> --type supersedes
bd close <older> --reason "superseded by <canonical>"
```

After every write, read both beads back. A noncanonical bead is resolved only when its
metadata, required edge, closed status, and close reason all match, and canonical still has
`decision_disposition=accepted`. If metadata, edge, or close writes stop partway, record the
failure and leave the observed partial state. Restart repeats the same keyed reads, completes
only the missing steps, and produces the same result without changing canonical.

## Repairing a stale close reason

`bd close` does not replace the close reason of an already-closed bead. When a loser is closed
with any reason other than the canonical duplicate or superseded reason, repair it only after
the loser's metadata and required edge have passed read-back:

```text
bd label add <loser> decision-repair
bd label add <loser> non-work
bd reopen <loser> --reason "repair stale decision close reason"
bd close <loser> --reason "<duplicate of|superseded by> <canonical>"
```

- Add both labels before reopening. Generic ready and claim selectors exclude `non-work`.
- Read back both labels and confirm canonical is still accepted. Run reopen and close
  consecutively.
- A restart between those commands recognizes `decision-repair` plus `non-work`, verifies the
  durable loser metadata and edge, skips reopen, and closes the loser with the canonical
  reason.
- Success requires a final read of both beads showing `status=closed`, the canonical close
  reason, the expected loser disposition and `canonical_decision`, and unchanged canonical
  metadata.

An invalid explicit chain remains `decision_disposition=conflict`; no candidate is applied
until the owner repairs the chain from evidence or enters `waiting_human`. Never infer
resolution from a message or an artifact.
