# ADR 0005: The read side is data queries over denormalised resources

Status: accepted (2026-11-27)

## Context

The book's CQRS chapter adds a separate read model (an `allocations_view`
table) kept up to date by event handlers. It exists because rebuilding views
from the ORM is slow and couples reads to the domain model.

## Decision

- The command side writes, in the same run and under the same rollback:
  - the `product` resource, with derived `availableQuantity` per batch and per SKU;
  - an `allocation` resource per allocated line (the book's `allocations_view`).
- Reads never run domain code or a method. The CLI uses `swamp data query`,
  and the app uses `data.query` with `useDataChanges` to refetch on writes.
- No "view stock" method. A read-kind method would write output records on
  every view and add nothing a query does not already give.

## Consequences

- The app needs only `data:read` plus three named methods.
- Views are consistent with the commands that wrote them, because both are
  written in one method run with rollback. No eventual consistency.
- A query sees each resource's latest version. History is available with
  `version >= 0`, which gives an audit trail of every allocation without extra work.
