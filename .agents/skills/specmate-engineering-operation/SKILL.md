---
name: specmate-engineering-operation
description: Implement or change a controlled Specmate engineering operation (a semantic command such as create/update draft, freeze revision, register source, request build, reserve stock) in the shared Django operation layer. Use when adding a command, an API/MCP/job entry point that mutates engineering state, or changing authorization, concurrency, idempotency, or persistence of one.
---

# Engineering operation

Contracts: `docs/CONTRACTS.md` (command layer, errors), `docs/DOMAIN.md` (definitions,
drafts, revisions, occurrences, unknowns), `docs/SECURITY.md`, `contracts/examples/operation.json`.
Find the capability and acceptance IDs in `spec/` first.

## Shape

1. One operation function in the owning module's service layer; GUI, HTTP API, MCP tools,
   and trusted jobs call it. Views and workers never write engineering tables directly.
2. Inputs: server-derived actor and scope (never caller-supplied identity strings), request
   ID, optional idempotency key, expected state token for mutations, typed Pydantic payload.
3. Order inside the operation:
   validate payload → resolve scope → authorize (service layer, not only HTTP) →
   check expected state token → apply in one `transaction.atomic()` → write outbox/evidence
   rows in the same transaction → return a typed result.
4. Concurrency: compare-and-set on the token; a mismatch returns a conflict carrying safe
   current state, never a silent overwrite.
5. Idempotency (where the operation has external or duplicate-sensitive effects): key scoped
   to actor/project/operation with a request fingerprint; replay returns the stored result;
   same key with a different payload is an error.
6. Results/errors are typed and distinguish validation, permission denied, not found (without
   leaking existence across scope), conflict, unsupported, unavailable, and accepted-async.
   Long work returns an operation/build reference, not a fake synchronous success.

## Engineering invariants

- Frozen revisions and snapshots are immutable; edits create drafts or new revisions.
- Unknown is not zero/false/compatible. Store explicit unknown with provenance.
- Source authority stays with the designated owner; derived data carries provenance.
- Database constraints back essential invariants; don't rely on the operation alone.

## Tests (focused, real PostgreSQL)

Positive path; unauthorized actor and cross-project scope; stale token conflict; idempotent
replay and mismatched replay; invalid payload; rollback leaves no partial rows or outbox.
Add an entry-point test proving the API/adapter calls the same operation.
Then follow `specmate-scoped-verification`.
