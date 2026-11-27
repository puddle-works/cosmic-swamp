# Progress

Last updated: 2026-11-27.

## Done

- [x] Researched Swamp `20261127.024011.0`: source and design docs, bundled
      skills, apps, data, datastores and locking, workflows, serve, extensions.
- [x] Domain model with the book's rules: warehouse stock first, then earliest
      ETA; no split lines; idempotent allocation; `OutOfStock` naming the SKU.
- [x] Service layer and store port; in-memory and Swamp stores.
- [x] `@puddleworks/allocation` behavior: `add_batch`, `create_order_line`,
      `allocate`; `stock` definition.
- [x] Persistence across CLI processes and `swamp serve` restarts, checked.
- [x] Concurrency investigation, with and without the lock (ADR 0003).
- [x] Workflow `@puddleworks/place-order`, validated and run, success and failure.
- [x] Swamp App `@puddleworks/stock`: add batch, allocate, view stock and
      allocations, insufficient-stock error. Checked in a browser under
      `swamp serve --dashboard`.
- [x] Extension manifest with behavior, workflow and app.
- [x] README, ADRs 0001–0006, chapter mapping, platform gaps.
- [x] Puddle Works brand in the app itself (dashboard unchanged), light and
      dark, checked in a browser on loopback. (An earlier note said it was
      checked through the public portal; that check was invalid, because
      portal URLs skip sign-in from inside the orb. The app does not load
      through the portal at all: platform gap 12.)
- [x] Deallocate and `change_batch_quantity` (book ch. 9) as behavior
      methods and in the app (Release/Allocate per line, a quantity form,
      unallocated lines marked). Reallocation runs in the same method on the
      aggregate, with no bus (ADR 0006). Checked with the real CLI and
      datastore and in a browser under `swamp serve`.
- [x] Fixed the behavior's log lines, which printed blank: Swamp's logger
      takes named values as an object, not as extra arguments.
- [x] External orders in (book ch. 11): `POST /hooks/orders`, HMAC-signed,
      runs `place-order`; `scripts/send_order.sh` plays the sender. Checked
      under `swamp serve` with token sign-in and on the Box: a signed order is allocated, a bad
      signature gets 401, an out-of-stock order fails as a run.
- [x] External events out (book ch. 11): signed `Allocated`/`Deallocated`
      events to `STOCK_EVENTS_URL` from every command that changes an
      allocation, and a demo receiver (`receiver/`). Checked with the CLI and
      under `swamp serve` (token mode, a webhook order) against the receiver
      in the orb: right events for allocate, move, return to the same batch
      (none), release; a wrong secret and a receiver that is down are logged
      and the command still succeeds; a replayed event is stored once; a
      tampered body gets 401.
- [x] Deployed to the Amp Box `mellens/cosmic-swamp` as `stock`
      (https://stock--mellens.onamp.dev/), running `swamp serve` with token
      sign-in. Checked from outside: sign-in page without a token; with it,
      add batch and allocate work, and data and token survive a service
      restart. A daily thread schedule stops the Box at 18:00 London time.

## Test status

| Suite | Count | Command |
| --- | --- | --- |
| Domain | 19 | `deno test extensions/behaviors/allocation/domain_test.ts` |
| Service | 10 | `deno test extensions/behaviors/allocation/service_test.ts` |
| Event sender | 2 | `deno test extensions/behaviors/allocation/event_sender_test.ts` |
| Swamp store guard | 3 | `deno test extensions/behaviors/allocation/swamp_store_test.ts` |
| App logic | 5 | `bun test` in `extensions/apps/stock` |
| E2E race | 1 script | `scripts/concurrency_check.sh 10` |

## Outstanding

- Registry publication (`swamp extension push`). Not done; it is a public,
  external action that needs a decision.
- Per-SKU sharding (ADR 0004) if throughput matters.

## Swamp limitations discovered

See `docs/platform-gaps.md`. The ones that shaped the design:

- No compare-and-set write, so the version guard checks before the write and
  after it, and relies on rollback (ADR 0003).
- Lock per behavior instance, so all SKUs share one lock (ADR 0004).
- The local dashboard cannot run methods; writes from the app need `swamp serve`.
