# Tier A/B evidence

Historical measurement from 2026-09-16, bead `omp-orchestrate-6hf`.

Six runs of one fixture on 0.4.13 used 6 tasks (3 `basic`, 2 `deep`, 1 `max`), one review bead each, and a pre-approved DAG review. Arm A kept planner tiers; arm B marked every task `basic`. Cost is the sum of `usage.cost.total` over child transcripts.

| Run | Wall | Total | Implementers | Reviewers | Verdicts | Note |
|---|---|---|---|---|---|---|
| B1 all-basic | 24 min | $8.07 | $5.87 | $2.07 | 9 approve, 2 changes | clean |
| A1 tiered | 55 min | $22.95 | $17.09 | $5.51 | 12 approve, 2 changes | lead stalled 11 min at the delivery gate; resumed once |
| B2 all-basic | 44 min | $9.31 | $6.55 | $2.39 | 11 approve, 2 fix | stalled 23 min; resumed once |
| A2 tiered | 61 min | $16.87 | $14.73 | $2.04 | 12 approve, 2 changes | clean |
| B3 all-basic | 107 min | $37.60 | $24.35 | $11.82 | 12 approve, 14 changes | one `deep` bead bounced basic -> deep -> max -> planner twice |
| A3 tiered | 56 min | $19.72 | $13.59 | $5.19 | 12 approve, 8 changes | the same bead bounced deep -> max -> planner once; final merge landed by hand |

Median cost was $9.31 for arm B and $19.72 for arm A. Totals were approximately equal over three rounds, while arm B had higher variance. The `max` tier accounted for 48%, 79%, and 61% of tiered runs. The same `deep` bead drew 8 changes in A3 and 2 in A2 on identical text. The result informed static tiers and lead decisions in 0.5.0.
