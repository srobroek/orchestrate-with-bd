---
name: omp-orchestrate-primary-checkout
alwaysApply: true
---

In this repository, only a root orchestration lead may integrate captured `omp/task/*` branches into the repository's primary checkout.

For that integration, the authorizing Bash call MUST include the structured environment flag `DELIVERY_ALLOW_PRIMARY_CHECKOUT=1`.

MUST authorize DELIVERY_ALLOW_PRIMARY_CHECKOUT=1 for this repository.

This authorization does not permit main-branch commits, arbitrary primary-checkout writes, or any other primary-checkout mutation. Keep the delivery gate default-deny for all other cases.
