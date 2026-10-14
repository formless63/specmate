# Extensions, catalogs and integrations

## Content first, execution explicit

Catalogs, preparation profiles, rules and document templates are versioned content packs.
Executable recipes/adapters are separate approved execution capabilities. A template
language that can run code is not declarative merely because its file is text.

An installable manifest identifies publisher (a plain informational string), package/version,
content hashes, compatible contract versions, dependencies, capabilities, declared needs,
license/rights and migration/rollback behavior. There is no signature or publisher-trust
model: admins own what they enable.

Catalog packs (`catalog_packs`) implement this manifest. Packs and adapters share one
format: `kind` (`catalog` or `adapter`, always shown), `contract_version` plus
`compatible_contract_versions`, exact-version `dependencies`, pinned entry hashes, and
`requested_authority`, a plain list of declared needs `{kind, scope, reason}` with kinds
`execution`, `network_egress` and `in_process_code`. An adapter must reference its exact inert
recipe and declare execution. Declared needs are visible information and grant nothing.
Registering a version is an import (`item.create`). Only `workspace.admin` may enable
(`catalog_pack.install`, including update and rollback) or disable a pack or adapter, in one
decision with no separate acceptance step. Running a recipe still needs the separate
approved recipe registry.

## History

Installing a new pack version does not change design pins. Users review adoption and
impact. Disable stops new use while preserving references and required old artifacts.
Rollback is an install of an earlier version and cannot claim to reverse physical inventory
changes or external side effects.

## Execution

Use approved out-of-process adapters and toolpacks with narrow inputs/outputs, no direct DB
writes, denied-by-default egress, resource budgets and stage receipts. In-process extensions
are fully trusted application code and must not be presented as sandboxed plugins.
Private organizational content remains private through search, dependency resolution and
exports. Publisher metadata is not proof of asset distribution rights.

## External systems

ERP, invoicing, suppliers and workshop/device systems are optional. Define which system
owns each synchronized field, mapping, idempotency key and uncertain-write reconciliation.
Never introduce a second authoritative stock/part ledger by accident. No money/currency,
cloud account or external connection is needed for ordinary engineering records.

The `integrations` module is the optional reference implementation. A workspace admin
declares an integration (`integration.create`/`integration.update`) with a closed field
vocabulary and one owner per field: `supplier_offer` and `stock_observation` are externally
owned and import-only; `needs` is owned here and export-only. Engineering facts and the
stock ledger cannot be declared externally owned. The reference adapter reads and writes
CSV/JSON text (optional column renames); it holds no credentials and makes no network
calls. `integration.import` records dated observations attributed to the integration, file
SHA-256 and importing actor, with per-row rejection reasons; unknown cells stay unknown.
Observations never write `SupplierOffer`, `StockEntry` or design state, so no second
ledger exists, and re-importing identical content is recorded once. `integration.export_needs`
is an explicit `inventory.manage` action that retains the exact exported bytes. With no
integration configured nothing changes for engineering work.

Automatic purchasing, fabrication orders, flashing and printer control are outside the
baseline. Future integrations require distinct grants, operator awareness, compatible
hardware/safety conditions and actual outcome evidence. A compile/package handoff is not
an executed device operation.

Licensing boundaries are documented in `LICENSING.md`; technical packaging is not a
blanket proprietary-plugin exemption.
