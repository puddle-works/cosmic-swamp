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
      dark, checked in a browser through the public portal.

## Test status

| Suite | Count | Command |
| --- | --- | --- |
| Domain | 15 | `deno test extensions/behaviors/allocation/domain_test.ts` |
| Service | 8 | `deno test extensions/behaviors/allocation/service_test.ts` |
| Swamp store guard | 3 | `deno test extensions/behaviors/allocation/swamp_store_test.ts` |
| App logic | 4 | `bun test` in `extensions/apps/stock` |
| E2E race | 1 script | `scripts/concurrency_check.sh 10` |

## Outstanding

- Deallocate and `change_batch_quantity` (book ch. 9), done in one method on the aggregate.
- Registry publication (`swamp extension push`). Not done; it is a public,
  external action that needs a decision.
- Grants for viewers under `swamp serve --auth-mode oauth|token`; only the
  default local mode was exercised.
- Per-SKU sharding (ADR 0004) if throughput matters.
- External events in and out (book ch. 11).

## Swamp limitations discovered

See `docs/platform-gaps.md`. The ones that shaped the design:

- No compare-and-set write, so the version guard checks before the write and
  after it, and relies on rollback (ADR 0003).
- Lock per behavior instance, so all SKUs share one lock (ADR 0004).
- The local dashboard cannot run methods; writes from the app need `swamp serve`.
