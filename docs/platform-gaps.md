# Missing platform capabilities and possible reusable extensions

Found while building the first slice on Swamp `20261127.024011.0`. Each entry
says what was needed, what was done instead, and what would help.

## Gaps

1. **No conditional (compare-and-set) write.** `writeResource` cannot say
   "only if latest is still N". The store checks before writing and checks the
   version it was given after, then relies on `rollbackOnFailure` to undo.
   That is correct but indirect. An `expectedVersion` option on
   `writeResource` would make the guard one line and work the same everywhere.

2. **No transaction across behavior instances.** Rollback and the lock cover
   one method run on one instance. A use case touching two aggregates (for
   example a transfer between SKUs) would need a saga workflow with
   compensating steps.

3. **Lock granularity is the behavior instance, not the aggregate.** All SKUs
   serialise on `stock` (ADR 0004). Per-SKU instances would fix that, but app
   capabilities name behaviors one by one (gap 4).

4. **App `methods:` capability needs fixed behavior names.** An app cannot be
   granted "these methods on any behavior of type X". That blocks sharding by
   SKU without re-approving the app for each new SKU.

5. **Read-kind methods run unlocked, and the kind is the author's word.**
   Mislabelling a mutating method as `read` (or omitting `kind` for a name like
   `sync`) silently changes its concurrency. This slice declares `kind`
   explicitly and keeps the version guard as a backstop.

6. **No outbound event stream for integration.** `data.subscribe` serves app
   clients. There is no way to publish "allocated" to another system other than
   calling it from a method.

7. **The local dashboard refuses method runs.** App write paths can only be
   tried under `swamp serve` or a mock host.

8. **Method results are data handles, not return values.** A caller (app or
   workflow) reads the batch reference from the written `allocation` resource,
   not from the method's reply. Fine here, but a typed method result would
   simplify request/response commands.

9. **Throughput.** Each CLI command is a process start plus a lock, about
   1.5 s here (10 racing allocations took about 15 s). Under `swamp serve`,
   commands avoid process start, but the per-instance lock still serialises
   them.

10. **An app's look is set by the dashboard's tokens.** The SDK writes the
    dashboard's colours onto the app's `<html>` as `--swamp-*`, so an app
    that keeps its own brand must define its own palette and remap shadcn's
    variables to it. Theme font files also do not reach an app's sandboxed
    frame, so the app bundles Inter.

11. **Serve refuses a browser behind a proxy unless told its host.** Through
    a reverse proxy (an Amp portal here) the dashboard's WebSocket is refused
    with `untrusted origin` and the page sits at "starting" with no error
    shown to the user. `--trusted-hosts <public host>` fixes it; the error
    is only in serve's log.

12. **Swamp apps do not work behind a cookie-authenticated proxy.** An app
    runs in a sandboxed frame with an opaque origin, so its scripts, styles,
    fonts and `/app-platform/` modules are fetched without cookies (Swamp's
    design: `design/surfaces/apps.md`, "Serving"). Behind Amp's portal
    sign-in, or an Amp Box deployment made `--private`, each of those
    requests is redirected to the sign-in page, and the frame stays blank
    while the dashboard around it works. What works: loopback, or a public
    route with serve's own sign-in (`--auth-mode token` or `oauth`), where
    the frame's files are authorised by their signed launch token instead.
    The Box deployment uses token mode for this reason.

13. **Every swamp process needs a swamp-club credential, servers included.**
    `swamp serve` on the Box will not start without `SWAMP_API_KEY` (and
    `SWAMP_SIGNIN_TOKEN` for daemons), even with a local datastore and no
    registry use. Both are deployment secrets; the sign-in token is shown
    only once when the collective token is created.

14. **Serve keeps runtime data inside the repo, and needs TLS off loopback.**
    `.swamp/` must be writable, so on a read-only release (the Box)
    `scripts/box-serve.sh` copies the code into the data directory and runs
    serve there. Token mode also refuses a non-loopback bind without
    `--cert-file`/`--key-file`, so serve binds to 127.0.0.1 behind the Box's
    router, which terminates TLS.

## Reusable extension candidates

- **`@puddleworks/aggregate-store`**: a small library behaviors import to load
  and save a JSON aggregate by name, with the read+1 version guard and a typed
  `ConcurrentUpdate` error. `swamp_store.ts` is the seed. It ships as a helper
  module, not a behavior type.
- **Retry-on-conflict workflow pattern**: a workflow step `allowFailure` plus
  guard that reruns a command when it failed with `ConcurrentUpdate`. Useful
  once commands no longer share one lock.
- **App kit for "commands + read models"**: form → method run → `useDataChanges`
  refetch, as in `extensions/apps/stock/src/App.tsx`.
