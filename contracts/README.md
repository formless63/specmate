# v0 boundary examples

Examples specify intended semantics; they are not deployed endpoints or executable leases.
All are labeled synthetic. The stage image digest is intentionally invalid for execution.
The source-bundle example hashes `tests/fixtures/source-original.txt` as logical `source.txt`.

The first contracts implementation must define Pydantic models and generated JSON Schema,
validate these examples, and add negative schema/authorization cases. Avoid parallel hand-
maintained Python/TypeScript/schema definitions. DOMAIN and CONTRACTS set the invariants.

Do not treat a claimed actor inside a payload as authority. The operation example omits
server-authenticated context deliberately. Scene transforms and occurrence addresses remain
separate from view arrangements. Sample names must never be mistaken for discoverable APIs.

## Implemented

Authoritative models: `backend/src/specmate/contracts.py` (operation envelope, source-bundle
manifest). Generated schemas: `schema/`, rewritten by `manage.py export_contract_schemas`;
backend tests validate the retained examples and fail when generated schemas are stale.
Scene and stage contracts are not yet promoted.
