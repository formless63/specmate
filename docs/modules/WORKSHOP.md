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
`inventory` supplies project locations and one stock account per lot/location. A lot's
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
to actor/project/operation, and replay checks current access and inventory authority.

Stock management needs `inventory.manage`; reservations/releases need `inventory.reserve`.
Owners hold both. Other roles require explicit grants; `inventory.manage` includes
reservation authority. Read access follows project membership. The Inventory workspace
uses the shared commands and scoped, paginated stock/history reads. Procurement and
actual-unit evidence have separate capability acceptance obligations.

### Material usage and partial work

`inventory.create_work_batch` registers a planned job or batch with an immutable identity
and exact authorized design revision. The intended unit count may be unknown; a missing
count never becomes zero. Material lot revision and work target revision remain separate,
and their association does not assert BOM compatibility. Both belong to the same project.
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
subject with a project-unique serial, exact design revision, optional same-revision
physical lot and manufacturer variant, source, and assertion status. An actual lot is a
batch identity, while stock quantities remain in the ledger. A unit's initial identity
is immutable; a later design change does not rewrite its as-built revision.

`physical_units.link_work` records a separate immutable relationship between one actual
unit and one planned work job/batch at the same project and exact revision. It changes
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
