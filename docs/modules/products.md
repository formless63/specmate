# Product families and lineup

A `product_family` definition groups authored variants around exact frozen cable,
harness or assembly revisions. It uses the shared `definition.create`, `draft.update`
and `draft.freeze` operations, including workspace authority, expected-state tokens,
idempotency and immutable snapshot dependencies. There is no second ownership or
storage system and family numbers are not auto-assigned.

`content.product_family` has `schema_version: "1"`, an optional authored `number`,
option axes with stable `local_id`, label and declared values, and variants. A variant
has its own `local_id`, optional label, exact `design_revision_id`, optional number,
nullable positive decimal `declared_length_mm`, descriptive option selections and an
optional note. IDs are unique within their family or option axis. Selections must name
a declared axis and value. Blank length is unknown; there is no fallback to design
length. Length and options never edit, configure, resize or qualify the pinned design.

Families shows working drafts and exact frozen family records. Save explicitly persists
the local buffer with compare-and-set; Freeze captures only a saved draft. Family and
design revisions are independent. Neither is release approval.

`products.lineup` is a read-only operation with `workspace_id`, optional `project_id`,
`limit` and signed `after`. It selects the latest frozen family at the first page's
anchor before current dependent-authority filtering. A denied latest family never
falls back to an older family. Drafts are excluded. Pages scan at most 50 families and
return at most 100 variants; the signed one-day cursor binds actor, workspace, project,
query and anchor. Each read freshly checks full family/design/source closure authority.
Project context marks references; it does not change workspace access. Results retain
exact family and design identities and hashes. No hidden totals are reported.

`products.versions` lists bounded individually authorized frozen and working choices.
A denied current draft does not hide a readable older family. Version IDs remain
available under Advanced. Lineup retains option IDs alongside declared display labels.

The Releases tab retains the separate reviewed release operations and their existing
rights, unresolved-item and evidence semantics. A family is not a sales order, stock
reservation, price record or distribution permission.
