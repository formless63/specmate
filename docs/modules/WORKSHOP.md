# Inventory, make/buy and physical evidence

## Native bounded ledger

Implement stock/lot/location records and append traceable receipt, adjustment, reservation,
consumption and return operations. Correct with compensating records where appropriate;
do not silently overwrite historical usage. Use dimensional quantities and transactional
availability checks. Requests have scoped idempotency keys.

Reservations reduce available quantity but are not consumption. Partial consumption can
release or retain the remainder explicitly. Returns identify the consumed origin where
applicable. Do not let two concurrent reservations spend the same availability.

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
