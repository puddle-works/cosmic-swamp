# ADR 0003: Product is the aggregate; all stock lives on one behavior instance

Status: accepted (2026-11-27)

## Context

Allocation must never over-allocate a SKU. The book makes `Product` (all
batches of a SKU) the consistency boundary and guards it with a version number
and Postgres's repeatable-read isolation.

Swamp has no transactions across resources. What it does have:

- Each write to a resource name creates a new, immutable version. Version
  numbers are claimed atomically (`mkdir`), so two writers can never get the
  same number (`design/primitives/data.md`, Invariants).
- A mutating method run holds a per-behavior-instance lock for its whole run;
  runs on one instance serialise (`design/enablers/datastores.md`, Lock
  Lifecycle). Read- and list-kind methods take no lock.
- `rollbackOnFailure: true` makes a method's writes all-or-nothing: none
  become latest unless the method succeeds.

## Decision

1. One resource per Product (`product-<sku>`) holding every batch and its
   allocations, so allocation is a single-record write.
2. All products, order lines and allocations live on one behavior instance,
   `stock`. Its lock serialises every command.
3. The store does not rely on the lock alone. A product read at version N must
   be written as version N+1. The store checks the latest version before
   writing and the version its write was given after, and throws
   `ConcurrentUpdate` on any mismatch. The method sets `rollbackOnFailure`,
   so a refused command leaves no trace.
4. The command methods declare `kind: create` / `kind: update`, so Swamp
   treats them as mutating and takes the lock.

## Evidence

`scripts/concurrency_check.sh 10` races 10 `allocate` processes for 3-unit
lines against a 10-unit batch:

- With the lock (the shipped code): 3 succeed, 7 fail with `OutOfStock`, 1 unit
  left, 3 allocation records.
- With the lock bypassed (temporarily declaring `allocate` as `kind: read`):
  processes do interleave. The guard refused 6 commands with `ConcurrentUpdate`
  (for example "read at version 2, found version 4"), 1 with `OutOfStock`, and
  the end state was still exactly 3 allocations and 1 unit left.

## Consequences

- Correctness does not depend on the lock alone. If a future datastore or
  remote execution weakens the lock, the guard still refuses lost updates.
- Throughput is one command at a time for the whole store, about 1.5 s per
  CLI command in this orb. Fine for this slice. ADR 0004 records the cost and
  the way out.
- The guard covers the product, the only record whose updates can race. Order
  lines and allocation views are written after it under the same lock and
  rollback.
