# ADR 0004: One behavior instance now; one per SKU when throughput demands it

Status: accepted (2026-11-27)

## Context

The book's aggregate boundary is the SKU, so allocations for different SKUs
need not wait for each other. With one `stock` instance they do.

## Decision

Keep one instance for the first slice. The app, workflow and CLI name one
behavior, and one instance gives a single place to query.

## Way out

Each instance has its own lock, so a definition per SKU (`stock-<sku>`,
created by direct type execution) would let SKUs allocate in parallel. That
needs:

- the app's `methods:` capability to name each behavior, or a wildcard, which
  `app.yaml` does not support today (see `docs/platform-gaps.md`);
- read-side queries over `modelType == "@puddleworks/allocation"` instead of
  one behavior name.

Revisit when the concurrency script shows lock waits as the bottleneck.
