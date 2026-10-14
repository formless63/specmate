# Inventory, make/buy and physical evidence

## Native bounded ledger

Implement stock/lot/location records and append traceable receipt, adjustment, reservation,
consumption and return operations. Correct with compensating records where appropriate;
do not silently overwrite historical usage. Use dimensional quantities and transactional
availability checks. Requests have scoped idempotency keys.

Reservations reduce available quantity but are not consumption. Partial consumption can
release or retain the remainder explicitly. Returns identify the consumed origin where
applicable. Do not let two concurrent reservations spend the same availability.

### Ledger and reservation operations

`catalog.PhysicalLot` supplies the exact revision and optional manufacturer variant;
`inventory` supplies workspace locations and one stock account per lot/location. Stock,
locations and physical units live in the workspace: one ledger per workspace, never one per
project. A lot's
quantity dimension stays fixed across locations. Supported units are whole-item `ea`,
length `m`/`cm`/`mm`, and mass `kg`/`g`, with decimal canonical quantities in `ea`, `m`
and `kg`. Amounts accept exact decimal strings or exact integers; JSON floating-point numbers and
booleans are rejected. Original values support 24 digits with at most nine decimal places,
and converted canonical values must fit nine decimal places. Extreme exponents and values
outside the supported precision are rejected before normalization rather than rounded.

`inventory.create_location` and `inventory.open_stock` establish identities. Opening
quantity may be explicitly unknown; unknown stock cannot satisfy a reservation or an
incremental receipt. `inventory.establish_quantity` records an explicit assertion with
source, status and reason, preserving the unknown prior balance. `inventory.receive`
and `inventory.adjust` append changes with original units and a compensating reason.
An assertion marked observed or measured remains scoped evidence; it is not physical
qualification. Ledger entries and reservations cannot be rewritten or deleted.

`inventory.reserve` holds availability without consuming stock; `inventory.release`
appends a release that restores the reservation's remaining availability. Reservations cannot exceed known stock,
and adjustments/observations cannot reduce stock below active reservations. PostgreSQL
serializes account writes and backs dimension, scope, history and availability rules.
Mutations of existing stock require its current state token. Idempotency keys are scoped
to actor/workspace/operation, and replay checks current access and inventory authority.

Stock management needs `inventory.manage`, an explicit grant that workspace admins hold by
default. Reservations/releases need `inventory.reserve`, which is not grantable: editors
and admins hold it by role and `inventory.manage` implies it. Read access follows
workspace membership. `inventory.reserve` and `inventory.create_work_batch` accept an
optional `project_id` that files the reservation or work batch under a project of the same
workspace as navigation context only; it never limits stock, grants access or scopes the
ledger. `inventory.list` takes `workspace_id` and an optional `project_id` filter for
work batches (`GET /api/v0/inventory/workspaces/{id}`). The Inventory workspace
uses the shared commands and scoped, paginated stock/history reads. Procurement and
actual-unit evidence have separate capability acceptance obligations.

### Material usage and partial work

`inventory.create_work_batch` registers a planned job or batch with an immutable identity
and exact authorized design revision. The intended unit count may be unknown; a missing
count never becomes zero. Material lot revision and work target revision remain separate,
and their association does not assert BOM compatibility. Both belong to the same workspace.
Revision reads, commands, replay and conflict diagnostics recheck current access to the
stocked revision and work target's dependency closures.

`inventory.consume` appends a usage entry against an exact reservation and work batch. It
decreases physical stock and the reservation's remaining quantity together, preserving
other available stock. The caller explicitly retains or releases the unused reservation
remainder. Original reservation quantity is immutable; remaining quantity derives from
consumptions and the optional closing release.

`inventory.return_unused` appends a positive return against one exact consumption, limited
to its issued amount minus prior returns. It increases on-hand availability once, without
restoring a spent or released reservation or reversing a reported completion. Original
units, actor, request, assertion source/status and cause links remain in account and work
history. PostgreSQL guards these invariants, including competing raw inserts.

`inventory.record_work_completion` appends a count assertion for partial progress; reported
counts cannot exceed a known planned count. Material usage alone does not complete work.
These planned records do not themselves identify serialized actual units or establish
physical qualification. `physical_units.register` asserts an actual obtained or assembled
subject with a workspace-unique serial, exact design revision, optional same-revision
physical lot and manufacturer variant, source, and assertion status. An actual lot is a
batch identity, while stock quantities remain in the ledger. A unit's initial identity
is immutable; a later design change does not rewrite its as-built revision.

`physical_units.link_work` records a separate immutable relationship between one actual
unit and one planned work job/batch in the same workspace and at the exact revision. It changes
the work state token but does not alter the planned or reported completion count. The
unit count and reported completion count are displayed independently: an unreported
linked unit does not silently become a reported completion, and a reported completion
does not invent a serial. A unit may have only one work link in the current model.

`inventory.consume` may optionally name a unit already linked to its exact work target.
When omitted, usage stays expressly at batch level and is never allocated to individual
units by dividing totals. `inventory.return_unused` inherits the original consumption's
unit attribution; the caller cannot reassign it. Unit detail shows only directly
attributed material entries, with current stock and work access rechecked. None of
these assertions establishes physical qualification or release. A release domain and
later rework/evidence histories remain separate implementation work.

Work, unit and usage writes require scoped idempotency keys. Consumption and returns check both
account and work state tokens; completion reports check the work token. Retrying the same
request cannot duplicate usage, returned quantity or completion counts. Work identities,
completion assertions and cause-linked ledger entries remain immutable. The Inventory
workspace can select an existing exact target revision, register work, report partial
progress, consume allocations and return issued material with traceable assertion sources.
Physical units have their own workspace; the material usage form offers exact linked-unit
attribution or explicit batch-level usage.

## Make and buy

A resolved frozen BOM has purpose: assembly contents, procurement, fabrication/population
or consumables. Bought populated assemblies stop procurement recursion unless an explicit
make decision changes it. Show dated stock/supplier comparisons and unknown availability.
Prices, currency and supplier offers are optional. No ERP/accounting installation is required.

### Sourcing and optional costs

`sourcing.record_offer` (needs `item.create`) appends an immutable workspace
`SupplierOffer`: the exact offered revision, supplier and optional reference, the offer
source, a review basis, an `offered_on` date (never in the future), an optional
`valid_until`, optional stated availability and lead time, and an optional price. Price
amount, currency and the unit it is quoted per are independently optional; an absent value
stays unknown and is never zero. The acting user is recorded as the reviewer. Offers are
never edited or deleted; a newer offer for the same revision and need may name the one it
`supersedes` (once). A substitute offer names the revision it would replace and an explicit
basis; it is displayed beside the need but never satisfies it and never enters totals.
Nothing fetches live prices or stock from outside the workspace.

`sourcing.report` (`GET /api/v0/sourcing/revisions/{id}`) takes an exact frozen `bom_plan`
or `material_plan` revision, an optional `as_of` date and an optional `max_age_days`
freshness policy. It is read-only. Procurement demand is grouped by exact revision and
combined with the current stock ledger for lots pinned to that same revision: available is
physical minus active reservations, with the latest assertion date shown. No recorded
account, an unknown balance or a dimension mismatch leaves availability unknown (a lower
bound when only some balances are unknown) and the shortfall unknown with an `at_most`
bound; a BOM row whose waste allowance is undeclared keeps gross demand unknown and offers
only a net `at_least` bound. Offer freshness is `expired` after `valid_until`, `stale`
beyond `max_age_days`, `current` when a policy or expiry holds, and `unknown` when neither
exists. Estimated cost is the current shortfall times a priced offer, reported only for
known shortfall, price, currency and a unit of the same dimension, with a reason otherwise.
Totals are per currency from the cheapest current-or-unknown-freshness, not-unavailable
exact offer of each purchase row, with counts of unpriced rows; currencies are never
mixed. Missing prices, currencies or offers never block the underlying build sheet.

## Actual units

Plans and batches record intended work. Actual units/batch membership, consumption, firmware
assignments, procedures, instruments and measurements record what happened. Evidence for
one unit does not qualify every unit. A later design change changes applicability, not the
historical observation. Packaging retains relevant boundary interfaces and test intent.

## Acceptance emphasis

Use inventory and evidence fixtures. Test competing reservations, replayed writes, mixed
count/length units, partial work/returns, bought-board boundaries, absent prices and isolated
unit evidence. External system adapters need one declared authority per field/ledger, with
uncertain-write reconciliation and no implicit purchase/flash/printer action.

### Purpose-specific frozen BOM plans

A `bom_plan` definition stores typed `content.bom` planning policy separately from the
assembly's construction. `bom.create`, `bom.update`, `bom.snapshot`, `bom.freeze` and
`bom.read` use shared design operations, current authorization and concurrency tokens.
Capture pins an exact root assembly revision and the complete referenced revision closure,
including supplemental needs. Frozen plans never follow later assembly or policy edits.

Every decision has an exact contextual path, expected revision and declaration basis.
The empty path identifies the root and requires its own explicit make/buy decision.
Missing decisions remain unknown. Procurement stops at a bought boundary and lists that
item once; an explicit make choice expands its retained children. Repeated subassemblies
keep separate paths even when their revisions match. Assembly contents remain inspectable
independently of procurement decisions. A terminal make without declared inputs remains
unresolved. Disjoint occurrence scopes cannot bypass bought or undecided ancestors.

Supplemental needs name an exact item revision, a context, a purpose (PCB fabrication,
PCB population or consumables), a quantity and a basis. They are planning declarations,
not extra construction edges. A retained direct child cannot also be declared as a
supplemental need in the same context. Needs below bought or undecided boundaries are
excluded with a reason. Consumables appear separately from retained composition and the
procurement projection; fabrication/population needs also contribute procurement demand.
This demand is not an order, supplier choice or validated native PCB population.

Each structural occurrence represents one whole item per planned root. Structural counts
remain independent of material extent: an `occurrence_demands` declaration identifies an
exact contextual path and expected revision, a reviewed basis, and net material quantity
for that occurrence in **one root assembly**. Repeated occurrences have separate declarations;
none are pooled or divided by geometry. Without a declaration, the structural demand remains
one whole item. Assembly contents keep structural counts and show declared net demand
separately; procurement uses the declared demand at an included buy boundary. A declaration
below a bought ancestor cannot bypass it. Supplemental needs use the same dimensional
quantities per root assembly at their declared context and remain separate from retained
construction. No stock compatibility is asserted by choosing a matching unit.

Net demand is positive when known, with explicit unknown status otherwise. Supported units
are whole-item `ea`, length `m`/`cm`/`mm`, and mass `kg`/`g`. Decimal strings or exact integers
are accepted; floats, booleans, nonfinite values, fractional items and values outside the
ledger's exact range/precision are rejected. Input declarations retain original units and
exact values. Derived totals use canonical `ea`, `m` or `kg`, exact bounded arithmetic and
the planned root count; overflow or unrepresentable precision fails rather than rounds.
Unknown root counts or net quantities propagate independently.

A declaration may include `waste`, an **additive quantity per one root assembly**, with its
own basis, known/unknown status and units of the same dimension as net demand. It is not an
implicit percentage, geometry-derived preparation rule or actual scrapped material record.
Waste may be zero only by explicit declaration and basis. Frozen rows distinguish structural
counts, net demand, waste allowance and gross `required_quantity` (net plus allowance).
An absent allowance is `not_evaluated`: net demand stays known if established, while gross
required demand remains unknown. Unknown waste does not become zero. Each total scales
independently by root count; original declarations, bases and historical totals remain
immutable. Source closure is reauthorized before contextual, dimension and derived quantity
diagnostics, including declarations suppressed by a procurement boundary.

The browser can create/edit/freeze exact decimal declarations and reopen purpose-specific
revision views with contextual rows, unresolved branches and boundary explanations. Sourcing,
prices, native PCB extraction and physical qualification remain unevaluated. These planning
allowances cover part of consumable/waste separation; preparation-derived cut/slack rules,
actual waste reconciliation and build-sheet export have their own scope. Planning never
creates material usage, completion or an actual unit.
