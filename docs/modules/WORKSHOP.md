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
and `kg`. Values outside the supported precision are rejected rather than rounded.

`inventory.create_location` and `inventory.open_stock` establish identities. Opening
quantity may be explicitly unknown; unknown stock cannot satisfy a reservation or an
incremental receipt. `inventory.establish_quantity` records an explicit assertion with
source, status and reason, preserving the unknown prior balance. `inventory.receive`
and `inventory.adjust` append changes with original units and a compensating reason.
An assertion marked observed or measured remains scoped evidence; it is not physical
qualification. Ledger entries and reservations cannot be rewritten or deleted.

`inventory.reserve` holds availability without consuming stock; `inventory.release`
appends a release that restores availability. Reservations cannot exceed known stock,
and adjustments/observations cannot reduce stock below active reservations. PostgreSQL
serializes account writes and backs dimension, scope, history and availability rules.
Mutations of existing stock require its current state token. Idempotency keys are scoped
to actor/project/operation, and replay checks current access and inventory authority.

Stock management needs `inventory.manage`; reservations/releases need `inventory.reserve`.
Owners hold both. Other roles require explicit grants; `inventory.manage` includes
reservation authority. Read access follows project membership. The Inventory workspace
uses the shared commands and scoped, paginated stock/history reads. Consumption, returns,
procurement and actual-unit evidence have separate capability acceptance obligations.

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
