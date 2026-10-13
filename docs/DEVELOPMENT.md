# Development policy

## Toolchain

| Tool | Pin | Where |
| --- | --- | --- |
| Python | 3.13 (`backend/.python-version`), managed by uv; the host Python is not replaced | `backend/pyproject.toml`, `backend/uv.lock` |
| uv | 0.13.x | `uv sync --frozen` in CI and images |
| Bun | 1.4.3 exactly (`packageManager` in `package.json`) | one root `bun.lock` for `frontend/` and `packages/*`; `bun install --frozen-lockfile` |
| Node | 24.21.0 LTS (`.node-version`) | runtime for tools that need Node (Vite, Vitest, TypeScript); Bun runs scripts, not every tool |
| Images | `deploy/images.json` digests, amd64 and arm64 | resolved pins; qualified only by a running stack |

Both lock resolvers refuse releases younger than seven days (`exclude-newer` in
`backend/pyproject.toml`, `minimumReleaseAge` in `bunfig.toml`). Upgrades are deliberate
lock changes, never automatic. Do not add npm, pnpm or Yarn lockfiles. The production
frontend is a static Vite build; there is no JavaScript application server.

Backend tests use `tests.settings` (development profile). Tests that touch the database
need a real PostgreSQL configured with `SPECMATE_DB_HOST/PORT/NAME/USER/PASSWORD`.

## Pre-1.0 means no supported production users

Until v1.0.0 is deliberately released, historical development databases, Temporal histories,
internal APIs and derived caches have no promised upgrade compatibility. Prefer clean
recreation and coordinated baseline consolidation to speculative support for every
experimental build. This does not make original source bytes, private data or user
credentials disposable, and it does not excuse breaking current invariants.

Keep Django migration tooling for reproducible creation of the current schema. At
coordinated integration points, regenerate/squash application-owned migrations and reset
explicitly disposable environments if that is simpler. Do not edit upstream dependency
migrations or Temporal schemas by hand. Update all current consumers together. Normal
feature work need not trigger a full reset. No `makemigrations` at app startup.

A reset must verify an installation marker, installation ID, configured database identity,
allowed volumes/paths and pre-1.0 environment policy. DEBUG, a localhost hostname or a
version number alone is insufficient. Refuse unknown targets. A reset command must not
use broad container/volume prune or recursive deletion outside its dedicated state root.
Do not implement a destructive reset script before these identities exist and are tested.

Stop native execution and reconcile work before resetting. Private tracker state, reference
checkouts, business fixtures, source originals outside the disposable boundary and other
services' volumes are never reset by the application development command.

## Scope and ownership

The product specification is complete intended scope, not a small MVP hypothesis. Work can
proceed in parallel after relevant contracts are accepted. One integration owner coordinates
shared operations, schemas, migration ordering, security boundaries and version locks.
Use issue dependencies for genuine blockers, not a single serial queue for every discipline.

Keep worktrees/branches isolated for simultaneous code changes. Do not overwrite another
worker's uncommitted changes. Read-only predecessor checkouts are inputs, not branches to
modify. Record reuse disposition and retain justified regression cases.

## Efficiency

Consult the relevant document slice, not the entire history on every task. Avoid redundant
work logs and dashboards. Do not generate exhaustive low-level plans far ahead of concrete
interfaces. Progress status belongs in the selected tracker; public specs contain stable
requirements and reviewed decisions. See TESTING for targeted verification and reuse of
still-applicable results.

Reversible draft implementation within an assigned module can proceed without approval
for every edit. Scope/stack changes, public publication, source-license decisions,
privilege changes, unknown-target deletion, or external side effects need explicit review.
Document a blocker narrowly and continue independent authorized work.

## Source and build hygiene

Keep public examples synthetic and generalized. Never read a private file into a public
fixture because it is convenient. Keep source headers/notices required for approved reuse.
All public code builds from a clean public checkout; no paths above the repository and
no private registries/accounts are prerequisites. Build container context is this repository,
not its parent workspace. Keep lockfiles per application/frontend/tool-pack environment.

Use pinned, verified releases and image digests for reproducible tool packs; do not silently
follow latest. The bootstrap chooses baseline series, not a fabricated tested dependency
matrix. The first implementation task resolves, locks, builds and records actual versions.

## v1.0.0 transition

Before the first supported release, freeze the initial supported schema/package baseline,
validate clean installation/current backup-restore, specify future upgrade obligations,
and disable reset authority by default for real installations. Full-scope qualification
is a release decision. Do not advertise a partially implemented demo as the complete product.

Reference: [Django migrations](https://docs.djangoproject.com/en/5.2/topics/migrations/).
