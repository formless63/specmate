# backend

The authoritative Django application and shared Python engineering modules. Implement commands, permissions, schema, sources, revisions and evidence here. The jobs process imports the same controlled operations. Do not put native CAD dependencies in the web environment.

## Current modules (`src/specmate/`)

| Module | Role |
| --- | --- |
| `operations` | Operation registry, server-derived `Context`, typed errors, idempotency, the single `execute()` path |
| `access` | Installation ownership (one-time setup token), private projects, roles/grants, `authorize()` |
| `design` | Definitions, editable drafts (optimistic `draft-vN` state), immutable snapshots and revisions |
| `sources` | Exact blob registration (content-addressed filesystem store), original/derivative bundles |
| `contracts` | Pydantic boundary contracts; JSON Schema generated into `../contracts/schema` |
| `queries` | Scoped reads; out-of-scope records look exactly like missing ones |
| `api` | Django Ninja transport (session auth); `jobs/adapter.py` is the trusted-jobs transport |

Snapshot, revision and bundle-revision rows are immutable at the database level (triggers).
Interactive login (django-allauth), MCP transport and Temporal dispatch are not built yet.
