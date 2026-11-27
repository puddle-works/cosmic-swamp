# ADR 0002: The domain and service layer know nothing about Swamp

Status: accepted (2026-11-27)

## Context

Business rules must be testable on their own. A Swamp method body receives a
`MethodContext`, which is a platform object.

## Decision

Dependencies point inwards:

```
allocation.ts (behavior: Swamp boundary, zod)
   └── service.ts (use cases, AllocationStore port)
          └── domain.ts (Batch, Product, OrderLine; no imports)
swamp_store.ts implements AllocationStore on MethodContext
memory_store.ts implements AllocationStore in memory, for tests
```

- `domain.ts` imports nothing. Its stored form is plain JSON (`ProductState`).
- `service.ts` depends only on the domain and an `AllocationStore` interface
  with five methods. That interface is the book's repository and its "abstract
  dependency" at once.
- The behavior builds a `SwampStore` from the context and calls the service.
  The store, built per run, is the only dependency injection: no container.

## Consequences

- 15 domain tests and 8 service tests run in milliseconds, without Swamp.
- The in-memory store keeps versions the same way the Swamp store does, so the
  lost-update rule is tested at the service layer too.
- The only Swamp-specific logic is `swamp_store.ts` (record names, version
  check). It is covered by its own tests against a fake context and by the end
  to end race script.
