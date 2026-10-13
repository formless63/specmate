# Specmate: instructions for coding contributors

This file governs work on the application source. It is **not** the authority policy
for an agent operating a deployed instance; those guides live in `agent-guides/`.

## Read only the context needed for the task

1. Read `README.md`, `docs/ARCHITECTURE.md`, and `docs/DEVELOPMENT.md` at session start.
2. For engineering work read `docs/DOMAIN.md` and the relevant module document.
3. For boundaries read `docs/CONTRACTS.md`, `docs/SECURITY.md`, and `docs/TESTING.md`.
4. Find the task's capability and acceptance IDs in `spec/`. Consult `docs/PRODUCT.md`
   when scope is uncertain; do not reread all documentation before every edit.

A separately supplied operator policy may govern private tracking and publication.
This repository does not require private files or a specific issue tracker to build.
Do not initialize Beads, publish transcripts, or add personal operator instructions here.

## Nonnegotiable engineering rules

- The complete product scope is retained. An incremental delivery does not become a
  replacement product definition. Propose scope/architecture changes explicitly.
- Definitions, drafts, revisions, contextual occurrences, and physical units are distinct.
  Frozen design state is immutable; proposed catalog updates never rewrite consumers.
- Unknowns are not zero, false, compatible, measured, or approved. Missing geometry is
  not clearance evidence. Render/build/check success is not physical qualification.
- GUI, APIs, MCP, and trusted jobs use the same command/authorization layer. Browser
  validation assists; it does not authorize. Tool containers cannot write the database.
- Preserve sources and rights. Read applicable reuse guidance before replacing existing
  functionality. Keep useful TypeScript renderers; Python-first is not forced translation.
- All code, examples, commits, and artifacts here must be generalized and public-safe.
  Never copy private cables, names, paths, domains, customer records, or session text.
  Required upstream attribution is not permission to import private business data.

## Working practice

Work in coherent task-sized changes. Record changed requirements/contracts and remaining
verification in the assigned tracker. Do not maintain duplicate status spreadsheets,
Markdown task boards, or fabricated pass claims. Shared contracts, migrations, security,
and acceptance expectation changes need coordinated review.

Run the smallest checks justified by the changed behavior and its dependencies.
Do not run long suites on every turn, save, or commit. Batch real-tool/E2E tests at the
relevant integration checkpoint. Defer explicitly with an owner and checkpoint; never
turn unavailable native tools into a passing mock result. See `docs/TESTING.md`.

Before v1.0.0, coordinate disposable DB/workflow resets instead of engineering backward
compatibility for experimental builds. Never infer reset permission from DEBUG or a
version number. Never delete original sources or private reference material.

## Commands available in this bootstrap

- `python3 scripts/check_guidance.py` — specification/link/fixture integrity.
- `python3 scripts/check_public_tree.py` — heuristic public-tree safety checks.
- `python3 scripts/check_public_tree.py --staged` — inspect staged Git content.

Application skeleton (toolchain in `docs/DEVELOPMENT.md`; `make help` lists targets):

- `make backend-sync backend-lint backend-test` — uv environment, Ruff, pytest (Django).
- `make frontend-install frontend-typecheck frontend-test frontend-build` — Bun frozen
  install, TypeScript, Vitest, Vite static build.

There is no runnable Compose stack yet. Add real commands when implemented. The skeleton
tests cover only what exists; they do not test Temporal, CAD tools, or engineering features.

## Completion report

State the outcome, scope IDs, predecessor/reuse disposition where applicable, checks
actually run, limitations, and the next blocked/ready item. A task may be implementation
complete while its capability remains unaccepted. Do not push, publish, buy, flash,
operate a printer, or enable external execution without the appropriate authorization.
