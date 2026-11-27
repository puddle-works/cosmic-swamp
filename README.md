# Cosmic Swamp

The stock allocation service from *Architecture Patterns with Python*
([cosmicpython.com](https://www.cosmicpython.com)), rebuilt as Swamp-native
software: one behavior type, one workflow and one Swamp App, with Swamp's
datastore as the database and its per-behavior lock as the concurrency
control. No web framework, database or broker.

This is an independent implementation. No code from
[cosmicpython/code](https://github.com/cosmicpython/code) (CC BY-ND) is copied;
the book's domain rules and test scenarios are the functional specification.

## What it does

- Add a stock batch: SKU, quantity, optional arrival date.
- View available stock per batch and per SKU.
- Record an order line, then allocate it to the preferred batch: warehouse
  stock first, then the earliest shipment. A line is never split across batches.
- View allocations and remaining stock.
- Get `Insufficient stock for SKU …` when no batch can take the line.
- Release (deallocate) an order line, and allocate it again later.
- Change a batch's quantity, for example after damage or a short delivery.
  Lines the batch can no longer cover are released, newest first, and
  reallocated by the usual preference; a line no batch has room for is shown
  as unallocated.
- Take orders from another system: a signed `POST /hooks/orders` with
  `{"orderid", "sku", "qty"}` runs the same `place-order` workflow.
- Tell another system when a line is allocated, moves batch or is released:
  each change is POSTed, signed, to `STOCK_EVENTS_URL`. `receiver/` is a demo
  receiver that shows them.

State lives in the Swamp datastore (`.swamp/`), so it survives CLI runs,
`swamp serve` restarts and machine restarts.

## Layout

| Path | Role |
| --- | --- |
| `extensions/behaviors/allocation/domain.ts` | Domain model: `Batch`, `Product` aggregate, `OrderLine`, errors. Pure TypeScript. |
| `extensions/behaviors/allocation/service.ts` | Service layer: `addBatch`, `createOrderLine`, `allocate`, `deallocate`, `changeBatchQuantity`, and the `AllocationStore` port. |
| `extensions/behaviors/allocation/swamp_store.ts` | The store adapter on Swamp data, with the lost-update guard. |
| `extensions/behaviors/allocation/memory_store.ts` | In-memory store for service tests. |
| `extensions/behaviors/allocation/allocation.ts` | The `@puddleworks/allocation` behavior type: one method per command. |
| `models/@puddleworks/allocation/stock.yaml` | The `stock` behavior definition the CLI, workflow and app use. |
| `workflows/workflow-e2c62355-….yaml` | `@puddleworks/place-order`: record a line, then allocate it. |
| `extensions/apps/stock/` | The `@puddleworks/stock` Swamp App. |
| `webhook-routes/orders.yaml` | The `/hooks/orders` webhook: verified deliveries run `place-order`. |
| `scripts/send_order.sh` | Plays the external system: signs and posts one order to the webhook. |
| `extensions/behaviors/allocation/event_sender.ts` | Signs and posts allocation events to another system. |
| `receiver/` | Demo receiver for those events: checks signatures, drops repeats, lists them on a page. Its own Box deployment. |
| `scripts/concurrency_check.sh` | End-to-end races: allocate vs allocate, and change_batch_quantity vs allocate. Fails on a broken invariant. |
| `manifest.yaml` | Extension package: behavior, workflow and app. |
| `docs/` | ADRs, chapter mapping, platform gaps, progress. |

## Run it locally

Prerequisites: Swamp (`curl -fsSL https://swamp-club.com/install.sh | sh`;
built and tested with `20261127.024011.0`) and, for the app only, Bun.

```sh
# Commands, one process each; state persists between them
swamp behavior run stock add_batch --input ref=wh-1 --input sku=RETRO-CLOCK --input qty=20
swamp behavior run stock add_batch --input ref=ship-1 --input sku=RETRO-CLOCK --input qty=100 --input eta=2026-12-15
swamp behavior run stock create_order_line --input orderid=o-1 --input sku=RETRO-CLOCK --input qty=15
swamp behavior run stock allocate --input orderid=o-1 --input sku=RETRO-CLOCK
swamp behavior run stock deallocate --input orderid=o-1 --input sku=RETRO-CLOCK
swamp behavior run stock change_batch_quantity --input ref=wh-1 --input sku=RETRO-CLOCK --input qty=5

# Or both order steps as one workflow run
swamp workflow run @puddleworks/place-order --input orderid=o-2 --input sku=RETRO-CLOCK --input qty=10

# Read side: stock and allocations are plain data queries
swamp data query 'behavior("stock") && specName == "product"' --select attributes
swamp data query 'behavior("stock") && specName == "allocation"' --select attributes
```

### The app

```sh
cd extensions/apps/stock && bun install && swamp app build && cd -
swamp app approve @puddleworks/stock      # an operator decision: review what it asks for
swamp serve --dashboard                   # then open http://127.0.0.1:9090/apps/@puddleworks/stock
```

The app carries the Puddle Works brand itself (Inter, the website's navy
and teal palette in dark mode, a derived light mode, the puddle mark and
wordmark), in `extensions/apps/stock/src/index.css`. The Swamp dashboard
around it keeps Swamp's own look.

Behind a proxy or any non-loopback address, tell serve the public host, or the
dashboard's socket is refused (`untrusted origin`) and it never finishes
starting:

```sh
swamp serve --dashboard --trusted-hosts stock.example.com
```

Swamp apps cannot be opened through a proxy that signs people in with a cookie,
such as an Amp portal or a private Amp Box deployment: the app's sandboxed
frame fetches its files without cookies, so the proxy redirects them and the
app stays blank. Open it on loopback, or on a public route with serve's own
sign-in (see "Deployed on an Amp Box").

In an Amp orb, `.agents/setup` installs Swamp and approves the app, and
`.amp/services.yaml` runs `swamp serve` (`amp orb services ensure`).

The local `swamp dashboard` shows the app read-only, because it refuses method
runs. Writes need `swamp serve`.

## Deployed on an Amp Box

The app runs at https://stock--mellens.onamp.dev/apps/@puddleworks/stock on
the Box `mellens/cosmic-swamp`, deployment `stock`. `.amp/box.yaml` ships the
pinned swamp binary with the code, and `scripts/box-serve.sh` starts
`swamp serve --auth-mode token`: the URL is public, but nothing loads without
a serve token. The script mints one token named `owner` (90 days, renewed on
the first restart after it expires). To read it:

```sh
amp boxes exec mellens/cosmic-swamp --deployment stock --as-app 'SWAMP_HOME="$AMP_DEPLOYMENT_DATA_DIRECTORY/swamp-home" bin/swamp access token reveal owner --yes --repo-dir "$AMP_DEPLOYMENT_DATA_DIRECTORY/repo"'
```

The deployment needs `SWAMP_API_KEY` and `SWAMP_SIGNIN_TOKEN` as deployment
secrets (a swamp-club collective token and its sign-in token). Stock data,
tokens and the app's approval live in the deployment's data directory and
survive redeploys. Redeploy pushed code with `amp boxes deploy`.

## Orders from other systems (webhook)

`webhook-routes/orders.yaml` gives `swamp serve` a `POST /hooks/orders`
route. The body is `{"orderid": "...", "sku": "...", "qty": N}`, signed as
`X-Puddleworks-Signature: sha256=<HMAC-SHA256 of the raw body, hex>` with a
shared secret. A bad signature gets 401 and nothing runs. A verified delivery
gets 200 `{"status":"queued"}` straight away, and Swamp then runs
`@puddleworks/place-order` with the body's fields as its inputs (the
workflow's `trigger.inputs`). The sender does not hear the outcome: an order
that is out of stock, or a body missing a field, fails as a run, visible in
serve's log and the dashboard's run history.

The secret is created on first start, in the `default` vault, by
`.agents/setup` (orb) or `scripts/box-serve.sh` (Box). To send an order:

```sh
export ORDERS_WEBHOOK_SECRET="$(swamp vault read-secret default orders-webhook-secret --yes)"
scripts/send_order.sh http://127.0.0.1:9090 o-42 RED-CHAIR 2

# On the Box
# (amp boxes exec mixes log lines into its output, so keep only the secret)
export ORDERS_WEBHOOK_SECRET="$(amp boxes exec mellens/cosmic-swamp --deployment stock --as-app 'SWAMP_HOME="$AMP_DEPLOYMENT_DATA_DIRECTORY/swamp-home" bin/swamp vault read-secret default orders-webhook-secret --yes --repo-dir "$AMP_DEPLOYMENT_DATA_DIRECTORY/repo" 2>/dev/null' | grep -oE '[0-9a-f]{64}' | tail -1)"
scripts/send_order.sh https://stock--mellens.onamp.dev o-42 RED-CHAIR 2
```

The webhook needs no serve token: the signature is its credential, and its
runs act as Swamp's built-in `service:webhook` principal, which may run
workflows by default.

## Events to other systems

When `STOCK_EVENTS_URL` and `STOCK_EVENTS_SECRET` are set in serve's (or the
CLI's) environment, every command that changes an allocation POSTs one JSON
event per change after its writes:

```json
{"id": "<uuid>", "at": "<ISO time>", "type": "Allocated", "orderid": "o-1", "sku": "LAMP", "qty": 2, "batchref": "wh"}
```

- `Allocated`: a line was allocated, or moved to another batch by
  `change_batch_quantity`.
- `Deallocated`: a line was released, or a shrunk batch could not keep it and
  no other batch had room; `batchref` is the batch it left.
- A line that goes back into the batch it came from, and a repeat
  allocation, send nothing.

Each POST is signed as `X-Puddleworks-Signature: sha256=<hex HMAC-SHA256 of
the raw body>`, like incoming orders. Sending is best effort: the command's
writes stand if the receiver is down or refuses, and the failure is logged
(`Could not send …`), not retried. There is no outbox, so a receiver that
must not miss events should reconcile against the `allocation` data.

`receiver/` is the other side for the demo: a Node server with no
dependencies (`receiver/server.mjs`) that checks the signature with the same
`STOCK_EVENTS_SECRET`, ignores an `id` it has seen, stores events in its data
directory and lists them at `/`. Run it locally with
`STOCK_EVENTS_SECRET=… PORT=8787 node receiver/server.mjs`.

## Tests

```sh
~/.swamp/deno/deno test extensions/behaviors/allocation/   # domain, service, store guard, event sender (34)
(cd extensions/apps/stock && bun test && bunx tsc --noEmit)  # app view logic (5)
swamp workflow validate @puddleworks/place-order
./scripts/concurrency_check.sh 10                           # end to end races, against the real datastore
```

## Install the package elsewhere

```sh
swamp extension source add /path/to/cosmic-swamp   # local, no registry
swamp behavior create @puddleworks/allocation stock
```

Publishing to the registry is `swamp extension push manifest.yaml` and has not
been done.

## Third-party

`InterVariable.woff2` (Inter 4.1 by Rasmus Andersson) is under the SIL Open
Font License 1.1; the licence is beside it and ships in the package.

## Further reading

- [docs/adr/](docs/adr/): the architecture decisions.
- [docs/cosmic-python-mapping.md](docs/cosmic-python-mapping.md): each book chapter mapped to its Swamp equivalent.
- [docs/platform-gaps.md](docs/platform-gaps.md): missing capabilities and possible reusable extensions.
- [docs/progress.md](docs/progress.md): what is done, what is left, and what was learnt.
