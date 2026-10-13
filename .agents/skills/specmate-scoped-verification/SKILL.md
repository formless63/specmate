---
name: specmate-scoped-verification
description: Choose the smallest sufficient verification for a Specmate source change and report it honestly. Use when finishing a coherent change, before a commit series, after a failed check, or when deciding whether expensive real-tool, integration, or end-to-end checks are due. Not a substitute for release qualification.
---

# Scoped verification

Policy: `docs/TESTING.md`. Acceptance obligations: `spec/acceptance.json`.
Runnable commands: the "Commands" section of `AGENTS.md` and `docs/DEVELOPMENT.md`.
Use only commands that exist; do not invent test targets.

## Select

1. List changed behavior, not changed files. Map it to capability/acceptance IDs.
2. Focused level by default: lint/type checks for changed code plus the tests that exercise
   the changed behavior and its direct consumers.
3. Broaden when the change touches shared meaning:
   - identities, occurrence addresses, revision/snapshot semantics → every consumer view/export;
   - permissions, scope, actor derivation → positive and negative authorization tests across
     each entry point (API, MCP, jobs);
   - serialization, schemas, contract examples → schema/example compatibility and clients;
   - transactions, concurrency, idempotency, outbox → conflict, replay, rollback tests
     against real PostgreSQL;
   - runner/execution, cancellation, receipts → real process/tool checks at the checkpoint.
4. Do not broaden for unrelated modules (a renderer tweak does not need firmware tests).

## Run efficiently

- Reuse a passing result only while its code, inputs, tool versions, and environment are
  unchanged. After a failure, rerun the failed/affected check first, then widen.
- Batch expensive native-tool, browser, and recovery checks at an integration checkpoint
  rather than per edit. Do not rebuild unchanged images or recreate healthy test services.

## Report

State each check as run/passed, run/failed, or not run. Name the evidence level (unit,
contract, real-tool, journey, installation, recovery, physical). A mocked tool proves
the adapter's handling, not tool compatibility. A missing tool is blocked/not-verified,
never a pass. Record each deferred check with reason, owner, and checkpoint in the assigned
tracker. Never weaken expected values to make a check pass; propose a contract change instead.
