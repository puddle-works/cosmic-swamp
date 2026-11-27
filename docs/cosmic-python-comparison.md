# Cosmic Python vs Cosmic Swamp

Cosmic Swamp keeps the book's domain rules and the patterns that shape the
domain: aggregate, repository port, service layer, domain events, CQRS. The
infrastructure patterns (Unit of Work, message bus, bootstrap and DI, the HTTP
API) are provided by the Swamp platform instead of hand-built. The biggest
behavioural difference is event delivery. The book handles events in
process, inside the request, at most once. Cosmic Swamp saves events as data
and delivers them from a scheduled run, at least once, within about a minute.
There are also about a dozen rule-level differences, listed below, where
Cosmic Swamp is stricter or atomic where the book is not.

**Sources compared**

- **Book code:** [cosmicpython/code](https://github.com/cosmicpython/code)
  `master` at `14c8479` (2025-06-10), which is the state at the end of
  chapter 13, plus the chapter 7 branch for the concurrency test. It was read
  for comparison only; none of it is reproduced here, because it is CC BY-ND.
  Names such as `MessageBus` and `allocations_view` are cited only to point at
  the source.
- **Book patterns:** the chapter-by-chapter intent, as summarised in
  [cosmic-python-mapping.md](cosmic-python-mapping.md).
- **Cosmic Swamp:** this repository at `db1348c`, the code published as
  `@puddleworks/cosmic-swamp@2026.11.28.2` and `2026.11.28.3`.

## The shape of each system

|  | Book (`master`) | Cosmic Swamp |
| --- | --- | --- |
| Runtime | Flask, SQLAlchemy, Postgres, Redis, SMTP (MailHog), 5 containers in `docker-compose.yml` | Swamp only: 2 behaviors, 2 workflows, a webhook route, the scheduler, a Swamp app. The demo receiver is a Node server with no dependencies |
| Source size | 736 lines of Python in `src/allocation/` | 1,229 lines of TypeScript in `extensions/behaviors/` (heavily commented), 324 in the app's `App.tsx`, 131 in `receiver/server.mjs` |
| Tests | 31: 20 unit, 8 integration, 3 end to end. Integration and e2e need Postgres, Redis and MailHog | 40 deno tests, 6 app tests, and `scripts/concurrency_check.sh` (2 races against the real CLI and datastore). No containers |
| Entry points | `POST /add_batch`, `POST /allocate`, `GET /allocations/<orderid>`; a Redis consumer for `change_batch_quantity` | Behavior methods, reachable from the CLI, `swamp serve` and the app; a signed webhook at `POST /hooks/orders` |
| Language idioms | Mutable objects mapped by an ORM; `OrderLine` is a frozen dataclass; batches are compared by `eta` through `__gt__` | Classes with private fields and `toState`/`fromState` to JSON; a comparator function `allocationOrder` |

## Pattern by pattern

| Ch. | Pattern | Book source | Cosmic Swamp | Difference |
| --- | --- | --- | --- | --- |
| 1 | Domain model | `model.py`: `Batch`, `OrderLine`, `Product` | `domain.ts`: the same three, pure TypeScript | Same rules for preferring batches. Cosmic Swamp adds more domain errors (see [Rule-level differences](#rule-level-differences-you-would-notice)) |
| 2 | Repository | `AbstractRepository` with `seen`; SQLAlchemy repo and ORM mappers over 5 tables | `AllocationStore` port; `SwampStore` and `InMemoryStore`. One JSON resource per product | No ORM or mapper: the aggregate serialises itself. No `get_by_batchref`, so `change_batch_quantity` needs the SKU |
| 3 | Abstractions | Fakes injected into handlers | The store is injected into service functions | Same idea |
| 4 | Service layer | `handlers.py`, one function per command, each opening a UoW | `service.ts`, one function per use case; the behavior method is the thin entry point | Same idea. Cosmic Swamp's entry point also validates arguments with zod |
| 5 | Test pyramid | Unit tests with a fake UoW, integration tests on Postgres, e2e over HTTP and Redis | Domain and service tests with an in-memory store, entry-point tests with a fake context, e2e through the real CLI and datastore | Cosmic Swamp's e2e needs no containers. It has no e2e test over the webhook in the suite; that was tested by hand and on the Box |
| 6 | Unit of Work | `AbstractUnitOfWork` as a context manager; rolls back unless you call `commit()` | **Native:** one method run with `rollbackOnFailure: true` | Cosmic Swamp has no UoW class. The run is the transaction, and the platform enforces it |
| 7 | Aggregate and concurrency | `Product.version_number` with Postgres `REPEATABLE READ`; a two-thread test expects one failure | The resource version is the version number. The store refuses a save that would not land at read+1, and the per-behavior lock serialises writers | The book bumps `version_number` only in `allocate`; Cosmic Swamp bumps it on every save. The book allows concurrency per product row; Cosmic Swamp serialises every SKU on one lock ([ADR 0004](adr/0004-one-instance-now-shard-by-sku-later.md)) |
| 8 | Domain events and message bus | `events.py`; `MessageBus` with an in-memory queue; handlers run in process after each command | Events collected on `Product`, saved as `event-<uuid>` data in the same run; the `notifier` behavior delivers them from a scheduled workflow ([ADR 0007](adr/0007-swamp-is-the-message-bus.md)) | See [Events are delivered differently](#events-are-delivered-differently) |
| 9 | Everything is a handler | `change_batch_quantity` raises `Deallocated`; a `reallocate` handler sends a new `Allocate` command in a new UoW | `Product.changeBatchQuantity` releases and reallocates in one method run, with one save | Cosmic Swamp's version is atomic. The book's can leave a line deallocated if the process dies between handlers |
| 10 | Commands vs events | `commands.py` dataclasses; `COMMAND_HANDLERS` and `EVENT_HANDLERS` maps | **Native:** the behavior's method table is the command registry, and its zod schemas are the command classes | Same split, but no handler registry code |
| 11 | External events | In: Redis channel `change_batch_quantity`. Out: `Allocated` published to Redis `line_allocated` | In: signed webhook `POST /hooks/orders` runs `place-order`. Out: all three event types as signed HTTP POSTs to `STOCK_EVENTS_URL` | Different inbound event (orders, not batch-quantity changes). HMAC replaces a trusted Redis channel. See below for delivery |
| 12 | CQRS | `allocations_view` table, written by event handlers, read with raw SQL in `views.py` | `allocation` resources and a denormalised `product`, written in the same run as the change; read with `data.query` ([ADR 0005](adr/0005-read-side-is-data-queries.md)) | Cosmic Swamp's read model is updated atomically with the write, not eventually. A released line keeps a record with `batchref: null` instead of the row being deleted |
| 13 | Bootstrap and DI | `bootstrap.py` builds the bus and injects `uow`, `notifications` and `publish` by inspecting handler signatures | **Native:** Swamp builds the method context. The store is constructed from it at the call site | No container or composition root to maintain |

## Events are delivered differently

One allocation, end to end:

- **Book:** `POST /allocate` (Flask, replies 202) → `allocate` handler (UoW
  commit) → **events collected** → message bus, in the same process → event
  handlers (Redis publish, read model, email).
- **Cosmic Swamp:** `POST /hooks/orders` (replies `200 queued`) →
  `place-order` workflow → `allocate` method run (saves the change and the
  event) → **event saved as data** → `dispatch-events`, every minute →
  `notifier.dispatch` (signed POST, retried until accepted).

|  | Book | Cosmic Swamp |
| --- | --- | --- |
| When handlers run | Straight after the command, in the same process, before the HTTP reply | On the next scheduled `dispatch-events` run, up to about a minute later |
| Guarantee | At most once. `MessageBus.handle_event` logs a handler's exception and moves on, so the event is lost | At least once. Undelivered events stay pending and are retried every minute. The receiver drops repeats by event id |
| Ordering | Queue order within one request | Oldest first across all runs; delivery stops at the first failure, so later events wait for earlier ones |
| Events raised | `Allocated`, `Deallocated`, `OutOfStock` (with `sku` only) | The same three, each with `orderid`, `sku` and `qty`. `OutOfStock` also carries `available`, the most any one batch had free |
| What happens on `OutOfStock` | An email to `stock@made.com` | Delivered to the receiver like any event. The app reads it from the run's data to show why an order was not allocated |
| What is published out | `Allocated` only, to Redis | All three types, signed with HMAC-SHA256 |
| Internal reactions | `Deallocated` triggers `reallocate`; `Allocated` and `Deallocated` update the read model | None. Reallocation and the read model happen inside the command (chapters 9 and 12 above) |

## Rule-level differences you would notice

These are differences in behaviour, not just structure. In each case Cosmic
Swamp's rule is in `domain.ts` or `service.ts`.

| Situation | Book | Cosmic Swamp |
| --- | --- | --- |
| Order lines | Created inline from the `Allocate` command; never stored on their own | Recorded first with `create_order_line`, which is idempotent for the same quantity and refuses a different one (`ConflictingOrderLine`). `allocate` then takes only `orderid` and `sku` |
| Allocating the same line twice | Raises another `Allocated`, and can put the line in a second batch if the first is full | Returns the batch that already holds it and raises nothing |
| Unknown SKU | `InvalidSku` from `allocate`, mapped to HTTP 400 | `UnknownSku` from `create_order_line` or `allocate`; the run fails with that message. Through the webhook, the sender still gets `200 queued` ([platform gap 15](platform-gaps.md)) |
| Duplicate batch reference | Accepted silently | Refused (`DuplicateBatch`) |
| Unknown batch in a quantity change | No product is found by that batch reference, and the handler fails with an unhandled error | Refused (`UnknownBatch`) |
| Deallocating | No command in the final code; only `Batch.deallocate_one` inside a quantity change | A `deallocate` command. Releasing a line that is not allocated changes nothing |
| Which lines leave a batch whose quantity drops | `set.pop()`, so an arbitrary line | The most recently allocated first; they are then reallocated oldest first |
| A released line that no batch can take | `reallocate` raises `OutOfStock` and the line is gone from the read model | Recorded as unallocated (`batchref: null`) and a `Deallocated` event is raised; the quantity change still succeeds |
| Quantity values | Any integer | Positive integers for batches and lines; zero is allowed for a quantity change |
| Identifiers and dates | Free strings; `eta` parsed with `fromisoformat` | Letters, digits, `-` and `_` (1–64 characters); `eta` must be a real calendar date |
| Placing an order | One `Allocate` command, one transaction | The `place-order` workflow runs two method runs (`create_order_line`, then `allocate`). They are not one transaction, but the first is idempotent, so a retry is safe |

## What Cosmic Swamp adds

- **A UI.** The `stock` Swamp app, in the Puddle Works theme, has forms for
  every command and live read models. The book has no UI.
- **Signed integration both ways.** HMAC on the inbound webhook and on
  outbound events, with a receiver that verifies signatures and drops repeats.
- **A durable outbox.** Events survive a crash or a receiver outage, which the
  book's bus does not handle.
- **Deployment.** The same repository runs on an Amp Box with `swamp serve`,
  the scheduler and token sign-in.

## What Cosmic Swamp gives up

- **Latency of events:** up to about a minute, against immediate in the book.
  A Swamp trigger "on data change" would remove this
  ([platform gap 16](platform-gaps.md)).
- **Throughput:** about 1.5 s per command, and every SKU shares one lock. The
  book serialises only per product row.
- **Synchronous answers over HTTP:** the webhook replies `200 queued` with no
  outcome or run id, so the book's `202` or `400` from `/allocate` has no
  equivalent there. The app and CLI do get the outcome.
- **Free-form handlers:** adding a new reaction to an event means a new
  behavior method and workflow, not one more function in a dictionary.

## Out of scope

- The book's appendices: CSV, Django, project structure, validation and the
  alternative isolation-level branch.
- Earlier per-chapter branches of the book's code, except where noted.
- Swamp platform gaps, which are in [platform-gaps.md](platform-gaps.md).

## Known inconsistency

The `allocate` step of `@puddleworks/place-order`
([`workflows/workflow-e2c62355-8f16-41af-8330-9022eb3f9495.yaml`](../workflows/workflow-e2c62355-8f16-41af-8330-9022eb3f9495.yaml))
is still described as "fails the run when stock is insufficient". Since
chapter 8, `allocate` raises `OutOfStock` and succeeds instead. Only the
description is wrong; the behaviour is right.
