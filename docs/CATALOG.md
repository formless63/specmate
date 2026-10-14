# Reusable identity catalog

The catalog implements the identity distinctions in FND-001 / ACC-FND-001 alongside
existing design definitions, drafts and immutable revisions. A definition remains the
reusable engineering identity. Its revision captures exact design state.

A `ManufacturerVariant` associates a manufacturer and orderable part number with one
revision and records the author's basis for that association. Matching part numbers
never merge definitions and do not establish interchangeability or qualification.

A `Representation` links a revision to an exact immutable source bundle file. Symbols,
footprints, models, drawings and datasheets are supported roles. The source must belong
to the definition's workspace. Original file hash, media type and rights are retained;
registration does not execute, parse, render or redistribute source content. Results name
the exact revision number and definition and carry `rights_known`, which is false when the
file's recorded rights are an explicit unknown. A representation is never a variant or lot.

A `SourceIdentifier` references an external source (library id, URL, standard number) by
scheme and identifier for an exact revision, with a mandatory rights statement that may be
an explicit `unknown`. Nothing is fetched or stored. Registration is immutable and additive
(`catalog.register_source_identifier`, `item.create`).

A `PhysicalLot` identifies a physical batch with a label, revision and optional variant.
The variant must belong to that same revision. Labels are not identifiers: two batches
may have the same supplier label and still have separate UUIDs. A null variant means
unknown/unassigned. Registration creates no stock receipt, quantity, location,
reservation or consumption. The future authoritative inventory ledger refers to these
lot identities instead of duplicating them.

All three association records are immutable at the PostgreSQL boundary. New revisions
do not inherit or rewrite catalog associations. Catalog registration does not change
a revision's canonical snapshot or add the association to its frozen dependency closure.
Later catalog associations are separate records about an exact design revision.

## Operations and reads

`catalog.register_variant`, `catalog.register_representation` and `catalog.register_lot`
use the shared operation transport, validation, transaction and idempotency mechanism.
Registration is additive, so it requires the workspace's `item.create` permission
(contributors and above). Representation source access is checked before enforcing the
same-workspace restriction. A supplied lot
variant is separately resolved and authorized before checking revision equality.

These are append-only registrations with immutable targets, so no mutable expected-state
token is required. Concurrent duplicate variant or representation registrations serialize
on the revision and return a conflict. Replaying an identical keyed registration uses the
shared operation result; a mismatched payload is rejected by the shared command layer.

Authenticated reads are available at:

- `GET /api/v0/catalog/definitions/{definition_id}`: definition identity, drafts and revisions.
- `GET /api/v0/catalog/revisions/{revision_id}`: manufacturer variants, representations, source identifiers and lots.

- `GET /api/v0/catalog/definitions`: the workspace library of definitions, cursor-paged
  (`after`, `limit` up to 100, optional `kind`). With `project_id` the definitions that
  project references (floating or by exact revision) come first and carry `in_project`.

The identity reads support `offset` and `limit` (default 50, maximum 100). The revision
endpoint pages each association collection independently with the same offset. Read
queries enforce current workspace membership, and representations are restricted to the
definition's workspace.
Operation payload and result models live in `specmate.catalog.contracts`.

The identity panel supports creating a definition, explicitly freezing its current draft,
selecting a revision and registering associations. Source representations are chosen from the workspace's
registered source bundle revisions and their files, with each file's rights shown and unknown
rights flagged; source identifiers are entered with an explicit rights statement; source upload remains a
separate operation. Catalog and revision lists have page controls. The definition picker shows the
workspace library; at project scope the project's references come first. Creating a
definition never asks for a project: at project scope **Use in this project** (on by
default) adds a project reference after the definition exists.

## Verification boundary

Focused PostgreSQL tests cover separate identities, two consumers sharing one revision,
unchanged revision snapshots, immutable rows, same-revision lot associations, exact source
files, cross-workspace rejection, concurrent registrations, replay, invalid payloads and
API/jobs authorization. Component tests exercise the definition/freeze/lot flow and
permission errors. These are application and component evidence; source-tool rendering,
inventory accounting, browser deployment and physical qualification are separate checks.
