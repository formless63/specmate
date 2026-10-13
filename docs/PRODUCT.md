# Product specification

Status: accepted product direction; not an implementation claim.

## Purpose and users

Specmate is a unified, self-hosted engineering workshop for designing, documenting,
building, and reviewing physical products. Electrical, mechanical, wiring, firmware,
and workshop activity take place in one coherent project environment.

A person can move from an idea or imported design to reusable engineering records,
a reviewed configuration, manufacturing documents, build artifacts, and evidence about
actual units. Human and agent work uses the same controlled operations. Target users
include individual makers, hardware developers, small teams, prototyping workshops,
and laboratories; organizational growth must not require a different engineering model.

This is not a SaaS-first product. Normal operation requires no hosted application
account, subscription, ERP, accounting package, model provider, or paid integration.
Optional connections must fail locally and visibly without disabling unrelated work.
The full scope below is committed product direction. Delivery can be incremental;
implementation order is not permission to discard capabilities.

## Central principles

Every discipline uses the same engineering identities. A connector on a PCB, on a cable,
and in stock refers to the same reusable item where it is genuinely the same item.
A family, orderable variant, supplier offer, footprint, symbol, model, and stock lot are
related records, not automatically one identity. Boards and assemblies remain reusable
outside the project in which they were created.

A definition has stable identity. A revision is an immutable recorded version with exact
dependencies. A draft permits incomplete work. An occurrence is one contextual use of
an exact revision, including allowed configuration and placement. An assembly composes
occurrences and typed relationships, and can itself be a reusable definition.

Projects hold requirements, alternatives, collaboration, decisions, and releases. Sources
preserve original/authored material. Artifacts identify imported/generated outputs and
their rights. A build attempt records exact execution inputs and outcomes. A release
freezes reviewed revisions, dependencies, artifacts, and acknowledged unresolved items.
Physical units and batches identify things actually obtained, made, or measured.

Two uses of a board are distinct occurrences even when their revision is the same.
Selection must follow the same contextual occurrence through diagrams, 3D, BOMs, and
test records. Firmware configuration may differ between occurrences without silently
changing the board's copper or manufacturing geometry.

Engineering state is database-first. Native files are controlled sources, interchange,
and generated outputs, not a parallel editable project catalog. Users do not need Git,
manual commits, repository mirrors, or hand-edited JSON. Supported source bundles can
still be reconstructed and edited through deliberate handoffs. Property ownership and
extraction/reconciliation must be explicit.

## Connected capabilities

### Reusable engineering library and catalogs

Maintain boards, connectors, pinouts, wire/cable stock, hardware, materials, symbols,
footprints, models, datasheets, firmware targets, and reusable assemblies. Records carry
identifiers, source references, applicable rights, reviewed associations, and explicit
unknowns. Imported/candidate matches are reviewable, never silent merges. Domain packs
may add records, rules, models, and recipe references. Updating a pack creates adoption
choices; it never rewrites pinned consumers. Authorized search and where-used traversal
cover projects, libraries, source records, and stock without leaking private names.

### Interfaces and compatibility

Separate physical connector bodies, logical pinouts, electrical contracts, orientation,
and placement. One body can support several pinouts. A device's external port may map
to an internal connector or terminal. Explain physical mating, pin correspondence,
voltage/current limits, protocol behavior, grounding, shielding, mechanical fit, and
missing prerequisites separately. A single green compatibility badge cannot conceal
unevaluated dimensions or unsatisfied conditions.

### Wire stock, cable and harness construction

A stock record can exist without connectors, a complete cable, or a device. Model
conductors, insulation, dielectric, shielding, drains, jackets, fillers, materials,
colors, dimensions, and hierarchical cross-sections. Support coaxial, paired, ribbon,
figure-eight and other declared profiles. A common section layout drives specifications,
callouts, legends, cross-sections, and appropriate 3D pieces.

Finished cables add endpoints, terminations, branches, splices, joints, breakouts,
bonds, preparation requirements, routes and test intent. Preserve useful existing
interactive and parametric wire renderers; a generic document exporter must not reduce
the supported construction model. Workshop-specific foil display, braid preparation,
drain landing, and shielding practices become explicit versioned profiles, not universal
inferred rules. Illustration choices never alter actual construction or electrical bonds.

### Electrical topology and tracing

Cable conductors, joints, copper nets, external ports, and declared component behavior
participate in one addressable connectivity system. A harness path can be traced into
a board terminal and corresponding copper net. Copper continuity, component passage,
and active/conditional behavior remain distinct. Resistors do not merge copper nets;
capacitors do not prove DC continuity; unknown switch states and active circuits do not
establish a valid connection merely because terminals exist. Explain traversed paths,
boundaries, mutually incompatible conditions, assumptions, and unknown portions.

### Preparation and bench documentation

Represent segment quantities, route length, finished length, stock cuts, individual
conductor cuts, stripping, slack, waste, tolerances, shield treatment, termination steps,
and consumables. Identify formulas and inputs. Missing allowances remain unknown, not
zero. Generate cable specifications, schematics, cross-sections, cut/preparation lists,
BOMs, build sheets, termination instructions, continuity/isolation intent, labels, and
formboards. Full-scale output declares physical scale, page/tile dimensions, reference
revision, calibration marks, and instructions against print-to-fit scaling.

### PCB and electronics

Preserve original native schematics, boards, netlists, fabrication inputs, BOMs and
placements. Reviewed intake exposes components, pads, nets, outlines, mounting holes,
population options, candidate ports and model associations, lost semantics, and
schematic/PCB disagreements. Support native authoring and modification through precise
versioned adapters; run supported electrical/layout checks, optional routing, and
fabrication/assembly exports. A purchased board can be a black box with declared ports
and behavior; complete internal design is not mandatory. An imported board remains
independently reusable. Unsupported formats must not be reported as faithfully converted.

### Mechanical design and assembly

Manage enclosures, shells, parts, fasteners, mounts and assembly sources linked to exact
board/component revisions. Parametric proposals may derive outlines, bosses, mounting
holes, openings, vents, cable guides and fastener arrangements from available geometry
and requirements. Preserve uncertainty about connector envelopes, tolerances, materials
and manufacturing processes. Native mechanical editing remains a supported source
handoff, not an alternative project catalog. Assembly work combines board placement,
hardware, wiring and typed spatial/electrical relationships.

### Shared geometry and viewing

One occurrence-aware scene represents boards, cables, enclosures, hardware and systems.
It includes units, coordinate frames, transforms, source/model identities, and roles
such as manufacturing, clearance, and illustration. Support sectioning, open/closed
assembly views, exploded arrangements, orthographic drawings, and rendered images.
Display arrangements never overwrite canonical assembly placement. Maintain selection
across tree, schematic, board, cable view, 3D, inspector and BOM. Missing or approximate
models limit fit conclusions. Static scenes should not need continuous rendering.

### Configuration and solution exploration

Specify requirements and options, then evaluate combinations of parts, pinouts, boards,
firmware, materials and processes. Report valid, invalid, unknown and not-evaluated
results with rule/fact explanations. Represent development-needed as a linked action or
proposal, not a replacement for engineering truth status. An adapter board, alternative
cable or enclosure change can be proposed as new work. Substitutions, upgrades and pack
updates require deliberate review with impact across parents, geometry, firmware,
manufacturing, artifacts, builds and evidence.

### Sources and reproducible execution

Upload, edit and reconstruct versioned source bundles. Retain originals and separate
editable derivatives with ancestry. Human/agent edits use concurrency checks; stale
writes never silently win. Builds record exact sources, resolved configuration, recipe,
tool/library identities, execution environment, outputs and checks. Dependent stages can
include import, extraction, generation, validation, routing, conversion, rendering and
packaging. Cancellation, retry, restart, disconnected workers and incomplete outputs
are first-class. Reuse outputs only when relevant inputs and current permissions allow.
Distinguish recorded provenance, a successful rerun, semantic equivalence and demonstrated
byte-identical reproducibility. A process exit code alone establishes none of the latter.

### Documents and portable packages

Generate system diagrams, cable documents, PCB fabrication/assembly packs, mechanical
exports, spreadsheets, test packages and portable viewers from controlled records.
Target a whole system or a selected subassembly. A cable-only package includes boundary
interfaces, quantities, exact revisions, relevant sources, rights and unresolved items
needed to understand it without the parent project. Portable packages have manifests,
content hashes and permitted dependencies; closure review prevents private parents from
leaking into a supposedly public child package.

### Inventory, sourcing and make/buy

Maintain native workshop records for stock items/lots, locations, receipts, adjustments,
reservations, consumption and returns. Units include count, length and mass. Compare a
frozen BOM to live stock and dated supplier offers; show available, short, missing and
unknown. Supplier matches/substitutions are reviewed candidates. Distinguish assembly
contents, procurement, PCB fabrication/population, and manufacturing consumables. Buying
an assembled board must not also procure its internal components. Record plans, batches,
partial completion, actual consumption and returns. Pricing/currency and BOM costing
are optional and never prerequisites. Accounting, invoices and business-system ownership
belong to separately enabled integrations, not the workshop's required core.

### Firmware and commissioning

Tie firmware sources, dependencies, configuration and compiled artifacts to exact board,
population and pin assignments. Validate targets and compile supported toolchains.
Expose hardware changes affecting firmware assumptions and firmware changes affecting
commissioning evidence. Two board occurrences may have different assignments. Compilation,
a flashing handoff, authorized flashing, observed operation and measured commissioning
remain separate events. Device operation is not implied by compile success.

### Evidence, verification and release

Keep requirements, source observations, derived calculations, generated checks, reviewed
associations, decisions, measurements and physical sign-off distinct. Results refer to
actual units/batches, exact applicable configurations, procedures, instruments and test
conditions. One cable's continuity result does not qualify every cable of its revision.
A later change may make evidence inapplicable without rewriting the observation. New
warnings can challenge an old release while its historical basis stays retrievable.
Releases preserve reviewed dependencies, artifacts, rights and unresolved physical checks.

### Collaboration and knowledge

Support personal projects and optional team workspaces through the same operations.
Notes, photos, PDFs, files, decisions and attachments can link to multiple engineering
objects without duplicate underlying records. Search, notifications, comparisons, review
and impact analysis obey authorization across traversal and derived outputs. Sharing is
deliberate; privacy is the default. Rich-text collaboration does not bypass controlled
engineering mutations or turn arbitrary merges into valid revisions.

### Extensions and domain content

Support independently maintained catalogs, rules, document formats, tool recipes and
approved integrations through versioned boundaries. Declarative content and executable
extensions have distinct trust/permission requirements. Installation/update exposes
publisher, integrity, compatibility, dependencies, requested authority and privilege
changes. Disable, rollback and quarantine preserve referenced history. Private content
remains private. An extension interface is not an automatic license exception.

### Installation and operations

A novice can install, establish ownership, sign in without external services, and see
which capabilities are installed or available. Prebuilt containers and simple configuration
provide the appliance-like experience. Native tool execution is separately enabled.
Run heavy tools only for jobs; no required inference, ERP, extra search cluster, Redis,
or idle CAD processes. Existing service startup handles initialization and approved
migrations; do not add dedicated init/migration services by default. Diagnostics distinguish
unavailable tools, failed jobs, stale evidence, storage faults and permission failures.
Backup/restore preserves records plus all referenced bytes. Organization-scale workers,
shared storage and operational qualification use the same core model.

## Agent assistance

External agents discover supported operations through standard tooling including MCP.
They may read authorized requirements/preferences, search libraries, propose designs,
edit structured drafts and source bundles, request import/evaluation/build/export, inspect
results and prepare review packages. Preferences for familiar parts, suppliers or methods
are defaults, not evidence of ratings or dimensions.

Support scoped runs with allowed actions, budgets, deadlines, checkpoints, cancellation
and resumption. Permit bounded reversible draft work without approval for every field.
Separate draft authoring, source execution, inventory mutation, release, publication,
purchasing, flashing and printer operation. No text instruction can expand server-granted
authority. Unknown facts stay unknown and request evidence where needed.

## End-to-end journeys

1. Describe stock; obtain a reusable record, construction/color table, cross-section and
   appropriate preview without needing any other discipline.
2. Design a cable; review bodies/pinouts/topology, freeze a revision, and produce coordinated
   preparation, documents, tests, labels and visualization.
3. Import or author a board; retain originals, review extraction/associations and obtain
   checked supported native/fabrication outputs; reuse the board independently.
4. Assemble a device; place boards, enclosure, hardware and harnesses; synchronize views,
   trace interfaces and identify changes while preserving previous releases.
5. Make or buy; review the right BOM, reserve material, obtain a bench/supplier package,
   record units/batches, actual usage and observations distinctly from intent.
6. Reuse and upgrade; review electrical, geometric, firmware, manufacturing and evidence
   impact before adopting a replacement. Existing uses retain pinned revisions.

## Deliberate boundaries and later scope

No automatic purchase, fabrication order, flashing or printer control is part of the
baseline. Such integrations require separate authority. No promise covers arbitrary
format conversion or qualified products from arbitrary natural-language requests.

FDM and resin preparation are later committed extensions: process/material profiles,
orientation, supports, slicing provenance, manufacturing variants, print batches,
consumption, post-processing and measured results. They reuse the same identities and
evidence. Print preparation is not printer operation or physical qualification.

The public software is a generalized release. No personal names, host paths, proprietary
business cables or private project catalogs are needed in source, examples, documentation
or development histories. Useful prior engineering code must be reviewed for both rights
and embedded private assumptions before distribution.
