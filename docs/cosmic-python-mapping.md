# Cosmic Python, chapter by chapter, in Swamp

Status key: **built** (in this repo), **native** (Swamp already provides it,
so nothing is built), **not needed yet**, **planned**.

| # | Chapter | Book's mechanism | Here | Status |
| --- | --- | --- | --- | --- |
| 1 | Domain modelling | `Batch`, `OrderLine`, `allocate()` in pure Python | `domain.ts`: same rules in pure TypeScript, plus `Product` | built |
| 2 | Repository | `AbstractRepository`, SQLAlchemy repo, fake repo | `AllocationStore` port; `SwampStore` and `InMemoryStore`. No ORM: the aggregate is stored as one JSON resource | built |
| 3 | Abstractions and coupling | Inject the I/O to test the logic | Same idea: the service takes a store; tests pass an in-memory one | built |
| 4 | Service layer | `services.allocate()` orchestrating repo + domain | `service.ts`, one function per use case; the behavior method is the thin entry point (the book's Flask route) | built |
| 5 | Testing at different layers | Domain unit tests, service tests with fakes, E2E through the API | Domain (19) and service (10) tests under `deno test`; store guard (3); event sender (2); app logic (5) under `bun test`; E2E through the real CLI and datastore (`concurrency_check.sh`), the workflow, and the app in a browser | built |
| 6 | Unit of Work | Context manager wrapping a DB transaction, commit/rollback | **Native**: one method run is the unit of work. `rollbackOnFailure: true` makes its writes all-or-nothing, and the per-behavior lock isolates it. No UoW class | native |
| 7 | Aggregates | `Product` as consistency boundary, optimistic `version_number` | `Product` aggregate stored as one resource. Swamp's resource version **is** the version number; the store refuses writes that would not land at read+1 (ADR 0003) | built |
| 8 | Domain events + message bus | Aggregate raises `OutOfStock`, bus sends email | Not needed yet: no side effects. Errors surface as the run's failure and in run history | not needed yet |
| 9 | Going to town on the bus | Everything is a handler; `change_batch_quantity` deallocates, then raises events to reallocate | `deallocate` and `change_batch_quantity` methods. No bus: `Product.changeBatchQuantity` releases lines and reallocates them in the same method run, so it is one atomic save under the lock (ADR 0006). Lines no batch can take are recorded as unallocated instead of failing the change | built |
| 10 | Commands and events | Explicit command classes, different error handling | **Native**: each method is a named command with a zod schema; Swamp validates, records and reports it | native |
| 11 | External events | Redis pub/sub in and out | In: a `swamp serve` webhook route (`webhook-routes/orders.yaml`) whose verified deliveries run `place-order`, the body mapped to inputs by the workflow's `trigger.inputs`; HMAC replaces the book's trusted Redis channel. Out: the behavior posts signed `Allocated`/`Deallocated` events to `STOCK_EVENTS_URL` after each command (`event_sender.ts`), collected by the store like the book's UoW collects events; Swamp has no outbound stream (gap 6), and there is no outbox (gap 16). `receiver/` is the demo consumer | built |
| 12 | CQRS | Separate read model updated by handlers | `allocation` and denormalised `product` resources written by the command; reads are `data.query` (ADR 0005) | built |
| 13 | Dependency injection / bootstrap | `bootstrap.py` composing UoW, bus, notifications | **Native** for the platform's parts (Swamp builds the context and injects data, logger, vault). The one app dependency, the store, is built from the context in the method. No container | native |

## Patterns Swamp made unnecessary, and why

- **Unit of Work** (ch. 6). Its job is atomic commit and rollback around one use
  case. A Swamp method run with `rollbackOnFailure` already is that boundary,
  enforced by the platform rather than by a context manager the developer must
  remember to use.
- **ORM and mapping** (ch. 2). Resources are JSON with a zod schema, so the
  aggregate serialises to itself. `toState`/`fromState` replace the mapper.
- **API layer** (ch. 4 E2E). Methods are already reachable from the CLI, from
  `swamp serve` (WebSocket and HTTP actions) and from apps, with auth and grants.
- **Command classes and handler registry** (ch. 10). The behavior type's method
  table is the registry, and its zod schemas are the command classes.
- **Bootstrap** (ch. 13). Swamp composes the runtime. The only remaining choice,
  real or fake store, is made at the call site.

## Patterns kept even though Swamp could hide them

- **Optimistic concurrency check** (ch. 7). The lock alone prevents lost
  updates today, but the book's warning stands: do not assume persistence
  gives transactional guarantees. The guard is cheap and was shown to catch real
  lost updates when the lock was bypassed.
- **Repository port** (ch. 2–3). Without it the service would take a
  `MethodContext`, and the service tests would need Swamp's test harness.
