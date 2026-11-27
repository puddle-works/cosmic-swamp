# ADR 0006: No in-process message bus, events or commands framework in the first slice

Status: accepted (2026-11-27)

## Context

Chapters 8 to 11 add domain events, a message bus, command objects and
external events (Redis pub/sub). Their purposes are: decouple side effects
(emails), let one command trigger others (reallocate after a batch quantity
change), and integrate with other systems.

## Decision

Build none of it yet. The slice has no side effects, no cascading commands and
no external consumers.

- **Commands**: each behavior method is a typed, validated command. Swamp
  already records every run with its inputs, status and initiator.
- **Handlers**: the method bodies. Dispatch is Swamp's (CLI, `--server`, app,
  workflow step).
- **Multi-step use cases**: a workflow (`place-order`), which adds dependency
  ordering, run history and resume without a bus.

## When this changes

- `change_batch_quantity` (chapter 9) needs "deallocate, then reallocate".
  The first choice is to do it inside one method on the aggregate, which keeps
  it atomic under the lock. A workflow with steps is the alternative when the
  steps must be visible or resumable.
- External events in (chapter 11): `swamp serve --webhook` triggers a
  workflow, or `wait_for_signal` steps take JSON messages.
- External events out: a behavior method that calls the outside system, run as
  a later workflow step. Swamp has no outbound event stream for this
  (`data.subscribe` is for app clients); see `docs/platform-gaps.md`.
