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
the exact revision number and definition and carry a required `rights_status` (cleared, restricted or unknown; unknown is an explicit choice)
alongside the free-text rights note. A representation is never a variant or lot.

A `SourceIdentifier` references an external source (library id, URL, standard number) by
scheme and identifier for an exact revision, with a mandatory rights status and note; the status may be
an explicit `unknown`. `catalog.search` finds them by identifier text (kind `source_identifier`). Nothing is fetched or stored. Registration is immutable and additive
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

## Part descriptions and catalog kits

A `part` can opt into `content.part` with explicit `schema_version: "1"`.
`category`, `value` and `package` are authored text, with null meaning unknown.
They do not create electrical facts, terminals or a compatibility assessment.
`fits` records exact design revision pins and a required basis for each **Declared
fit**. Physical fit remains not evaluated. Existing arbitrary part content stays
valid and is neither converted on read nor rewritten in older frozen snapshots.

A `kit` uses `content.kit` with `schema_version: "1"` and
`semantics: "catalog_grouping"`. Each bounded line has a unique local ID, an exact
same-workspace revision, an optional note, and either an existing exact inventory
quantity or null. Null leaves both amount and unit unknown. Known quantities must
be positive; counts are whole items. Nested kits are rejected. A grouping creates
no physical occurrence, assembly relation, procurement demand or stock movement,
and it does not expand a BOM implicitly. Manufacturer variants, SKU/source
identifiers, representations and lots continue to use the existing catalog layers.

Both kinds use `definition.create`, `draft.update` and `draft.freeze`. Updates
retain the shared expected-state and idempotency rules. Generic writes, replay and
reads reauthorize exact typed dependencies and their current source closure.
Freezing derives dependency pins from the typed payload; a caller cannot replace
that closure with a different dependency list.

`GET /api/v0/catalog/definitions/{definition_id}/record` and
`catalog.read_record` load one state. An explicit revision number is exact and never
falls forward to the newest revision. `working` selects the working draft when it is unambiguous; a supplied `draft_id`
retains a deliberate working selection. Multiple drafts require an explicit choice.
Without either, the latest frozen revision is selected, or the only draft when
nothing is frozen. `include_content=false` returns the typed state metadata without
its payload when the caller only needs a label or selected identity.
Only the selected state's closure is authorized, so a different unavailable draft
cannot block inspection of an otherwise readable historical revision.

`GET /api/v0/catalog/revisions/{revision_id}/kits` and the read-only
`catalog.kits_for_revision` operation list exact declared memberships in each kit's
latest frozen revision at the page anchor. A later kit revision that removes a line
removes that membership from a new listing; historical exact kit records stay readable.
Each page scans at most fifty candidate revisions and
returns at most fifty readable rows. Every candidate's snapshot/source closure is
checked before its name or lines are disclosed. Signed cursors bind the selected
root, current actor, workspace, listing cutoff and scan offset; they carry no denied candidate identity or
creation time. No hidden totals are returned.

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

## Compact Library browsing

`GET /api/v0/workspace/library-table` adds a definition-only compact projection to
the existing workspace library read. Name, manufacturer part number, kind and
project-reference filters run before cursor pagination. A project is a filter,
not an ownership or permission boundary.

Each row identifies its selected state: the latest frozen revision, otherwise the
newest saved draft and its version. All manufacturer associations and typed fields
use that state. Internal numbering is unassigned; no number is generated or inherited.
Null fields are unknown. Connector reverse-association counts are not evaluated by
this projection. Stock core counts exclude drains; jacket OD is a declared root
jacket dimension, not a computed packing envelope.

The typed Library lists keep the existing editors below the list. Comparison captures
two saved projections of the same kind, with exact revision or draft/version labels;
unsaved editor changes are excluded. A property difference is not a compatibility
assessment. Import opens the existing source registration, KiCad intake and catalog
pack tools. Kits remain browse-only until structured kit authoring is available.

At most twenty manufacturer associations per row are returned; an explicit truncation
flag marks additional associations. Search still covers all associations on the selected
revision before pagination.

The optional `catalog_class` table filter selects `parts`, `hardware` or `kits`
before pagination. Hardware includes explicit typed part categories such as shell,
fastener or tool, existing hardware definitions, and mechanical source records
whose declared role is hardware or enclosure. Classification uses the same exact
saved state as the row, never a later draft over a frozen revision. Part value and
package, kit line count and mechanical role/target count are compact declarations;
a line count is not a physical quantity. Protected catalog content and manufacturer
associations are withdrawn when its current snapshot/source closure cannot be read.
