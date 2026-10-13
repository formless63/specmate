# Preparation material accounting

A `material_plan` is a versioned build-sheet record for one exact cable or harness
revision. Its installed extents, selected cut basis, extra waste, consumables and
batch observations remain separate. The plan never changes design declarations,
stock facts, reservations, consumption, returns or preparation instructions.

## Planned quantities

Each piece names one physical harness section, or null for the cable's one piece.
Segments through a shared section are inspectable and do not multiply stock pieces.
Omitted physical sections are unresolved. Installed length is an independent exact
millimetre declaration with its own basis and optional registered evidence; route,
finished length and rendering cannot supply it.

Select the saved stock-cut declaration or a reviewed whole-piece preparation
suggestion explicitly. Exact preparation and stock revisions/hashes are retained.
The build sheet shows slack, end allowances and trim from the original formula;
these are already in the cut and are never added again to procurement. Conductive
feature cuts and per-layer strip dimensions are not additional stock purchases.
Cut minus installed is unclassified surplus, not a claim that it was discarded.

For an explicit make decision, per-piece procurement is selected cut plus separately
declared extra waste beyond that cut. The subject quantity multiplies this once.
For example, 1000 mm installed, a selected 1035 mm cut containing 35 mm of reviewed
allowances, and 5 mm extra process waste require 2080 mm for two subjects. Neither
installed length nor the allowances are added a second time. Missing extra waste
leaves procurement unknown even when cut and installed amounts are known.

Consumables reuse the purpose-BOM exact quantity and additive-waste contracts. Each
separate process requirement names an exact item revision, amount, unit and basis.
Net demand and extra waste remain separately visible; gross procurement adds them
once and scales by the subject quantity. No geometry-derived quantities, percentages,
purchasing packs or implicit rounding are introduced. The same retained stock
revision cannot also be declared as a consumable. Distinct needs remain independent.

A buy decision purchases the subject and excludes its stock and consumable process
requirements from procurement while retaining their inspection. An unknown decision
leaves procurement unresolved. This sheet is a purpose-specific projection for its
exact subject; it must not be appended to overlapping assembly BOM rows. Assembly
occurrence policy remains owned by the purpose BOM. No automatic BOM merge exists.

## Existing preparation and actual observations

An optional exact per-end preparation application reuses the reviewed cable endpoint
mapping and original instructions, tolerances, review state and source provenance.
Its dimensions do not change material quantities. Harness physical-end mappings remain
unresolved until explicitly modeled; logical segment endpoints are not substituted.
Workshop illustration profiles supply no accounting rules.

A reconciliation records entire-batch retained and discarded amounts with a basis and
optional evidence. These observations are never multiplied by the planned quantity.
Optional existing Inventory consumption event IDs must name the exact stock or
consumable revision and exact work subject revision. An event may appear once in the
sheet. Existing authorized returns reduce net issued material. Units must describe
one matching material dimension; conversion uses the Inventory exact unit factors.

The build sheet reports issued, returned, net issued, retained, discarded and
unallocated amounts. A zero residual is balanced; positive residual remains
unallocated; negative residual is visibly overallocated. Unknown recorded amounts
remain unknown independently, and selecting no consumption events leaves issue
unknown. Recording observations performs no stock transaction. Frozen observations
are immutable, while reconciliation is explicitly a current view of authorized ledger
returns, which may be recorded later. Independent sheets are observations and do not
establish exclusive global attribution of Inventory events.

## Controlled operations and disclosure

`material_plan.create`, `.update`, `.freeze`, `.read` and `.authority` use the shared
operation layer used by HTTP, jobs and agent adapters. Draft updates require the
original optimistic token. Freeze captures the saved draft and its exact dependencies;
unsaved edits stay separate. Replays authorize retained and supplied closures before
payload-mismatch or engineering diagnostics. All direct reads refresh the actor's
active-account state. Registered evidence retains exact bundle revision, file path,
hash and rights; derived and archive-original ancestry remains current authority.
Unverified citations remain explicitly unverified.

The material workspace supports structured editing, explicit draft loading, immutable
history, exact build-sheet inspection and existing-ledger reconciliation. Denied reads
or mutations hide retained evidence; access recovery retains unsaved inputs and their
original token. Calculations and balanced observations establish no measurement,
manufacturing approval, electrical continuity or physical qualification. Standalone
print/export packaging and integrated browser/agent journeys need separate verification.
