# ADR 0001: Swamp is the application platform

Status: accepted (2026-11-27)

## Context

The book's application is Flask + SQLAlchemy + Postgres, with Redis for
messaging. The goal here is to show that Swamp can host conventional business
software without rebuilding infrastructure it already has.

Researched against Swamp `20261127.024011.0` and its design docs
(`design/primitives/*.md`, `design/surfaces/apps.md`,
`design/enablers/datastores.md`).

## Decision

| Need | Swamp capability used | Instead of |
| --- | --- | --- |
| Commands (entry points) | Behavior methods on `@puddleworks/allocation` | Flask routes |
| Input validation | Zod `arguments` schemas, checked by Swamp before the method runs | Request parsing |
| Persistence | Versioned, immutable resources in the datastore | Postgres tables + ORM |
| Read side | `swamp data query` / `data.query` over the catalog | SQL views |
| Multi-step use case | Workflow `@puddleworks/place-order` | Service orchestration code |
| UI | Swamp App (`extensions/apps/stock`) behind the dashboard sign-in | A web front end |
| AuthN / AuthZ | `swamp serve` auth modes, grants, app capabilities pinned to three methods of one behavior type | Session handling |
| Audit / history | Method outputs, workflow run records, `initiatedBy` tags | Audit tables |
| Distribution | Extension manifest with behavior, workflow and app | Docker image |

No external web framework, database, broker, agent or LLM call is used.

## Consequences

- Every write is recorded and versioned for free; any past state is readable.
- Domain code stays plain TypeScript, so it runs under `deno test` with no
  Swamp present (ADR 0002).
- The application inherits Swamp's limits: a datastore designed for automation
  data, not OLTP throughput (see `docs/platform-gaps.md`).
