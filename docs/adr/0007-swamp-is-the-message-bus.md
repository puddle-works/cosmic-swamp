# ADR 0007: Swamp is the message bus: events as data, a notifier behavior, a scheduled workflow

Status: accepted (2026-11-27). Refines ADR 0006.

## Context

Chapter 8 of the book has the `Product` aggregate raise domain events
(`OutOfStock`), and an in-process message bus hand them to handlers, such as
one that emails someone. Until now this repo threw `OutOfStock` as an error,
and a first version of events out (chapter 11) posted events from inside the
allocation method, best effort, with no retry.

Swamp has no message bus that extensions can use. It emits internal domain
events (`ModelUpdated`, `WorkflowRunCompleted`), but nothing handles them and
extensions cannot subscribe. What it does have:

- `context.runModel`: a method calls another behavior's method, synchronously.
- Workflows, including schedule and webhook triggers.
- `data.subscribe`: serve's change feed, on v3 datastores only (this repo's
  datastore is the older format).

Two designs were weighed:

- **An in-process bus, as in the book.** Closest to the text, but the handlers
  run hidden inside one method run: Swamp records nothing about them, and a
  failed handler cannot be retried.
- **Swamp as the bus.** Events are data, handlers are behavior methods, and
  Swamp's scheduler does the dispatching.

## Decision

Swamp is the bus.

1. **The domain raises events.** `Product` collects `Allocated`,
   `Deallocated` and `OutOfStock` in `product.events`. Running out of stock is
   no longer an exception: `allocate` raises `OutOfStock`, leaves the line
   unallocated and returns null, as the book does in chapter 8.
2. **Events are data (the outbox).** The service layer saves each event as an
   `event-<uuid>` resource of the allocation behavior, in the same method run
   as the change it reports. `rollbackOnFailure` makes the change and its
   events all-or-nothing. Events are queryable with `swamp data query` and
   expire after 30 days.
3. **The handler is a behavior method.** `@puddleworks/notifier` has one
   method, `dispatch`. It reads every `event` record of every
   `@puddleworks/allocation` behavior, skips the ones it has a
   `delivery-<event id>` record for, posts the rest oldest first to
   `STOCK_EVENTS_URL` (HMAC-signed with `STOCK_EVENTS_SECRET`) and records a
   delivery for each one accepted. It stops at the first failure.
4. **Swamp dispatches.** The workflow `@puddleworks/dispatch-events` runs
   `dispatch` every minute (`trigger.schedule: "* * * * *"`) on serve's
   scheduler. Each dispatch is a recorded workflow run.

## Consequences

- Delivery is at least once and retried: an event that could not be
  delivered stays pending until a later run succeeds. A crash between a send
  and its delivery record resends that event, so receivers drop repeats by
  the event's `id`, which is fixed when the event is saved.
- Events arrive up to about a minute after the change, not instantly.
- An out-of-stock allocation now succeeds as a run. The app reads the
  `OutOfStock` event from the run's data to show the reason, and the
  `place-order` workflow no longer fails for lack of stock (a webhook sender
  still does not learn the outcome; gap 15).
- The domain stays Swamp-free and is tested with plain `deno test`; the
  pending-event selection (`notifier/outbox.ts`) is too.
- `dispatch` reads all events and all deliveries on each run. Both expire
  after 30 days, which keeps that bounded for a demo; a busy system would
  mark events delivered on the event itself or follow `data.subscribe` on a
  v3 datastore instead of polling.
