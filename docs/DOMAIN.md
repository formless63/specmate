# Domain model and invariants

This document sets semantic rules. Concrete table/class names may evolve before v1.0.0;
the rules do not silently change with implementation convenience.

## Identity, drafts and revisions

A definition is a reusable engineering identity with a kind and metadata. A definition
can have several revisions. An editable draft/change set is not a revision: incomplete
work may be saved with errors/unknowns and a concurrency token. A build snapshots the
draft into immutable exact inputs even when no release-ready revision exists.

Freezing validates the applicable rules and records exact dependencies. Unknown facts
need not prevent all freezing; the revision carries limitations and is not automatically
manufacturing-qualified. Release gates distinguish required blockers from acknowledged
unresolved checks. Correcting a frozen fact creates new design state or an attached
later observation; it never rewrites the old record.

A source file hash, manufacturer part number, catalog identifier and database definition
ID are different identifiers. Matching candidates must carry evidence and review. Two
similar connector bodies need not be interchangeable or one identity. A symbol/model is
a representation linked to a definition, not the stocked physical item itself.

## Occurrences and composition

An assembly revision contains stable local occurrence IDs, each pinned to a definition
revision and allowed assignments. A contextual occurrence address consists of the root
configuration/snapshot and an ordered path of local occurrence IDs. Reference designators
such as J1 are display references, not globally unique identities.

Example: two occurrences `left-module` and `right-module` use the same module revision.
Both modules contain local occurrence `control-board`, which contains terminal feature
`J1.pin2`. The paths differ even when all underlying revision IDs are identical. Selection,
BOM scope, firmware assignment and physical evidence use that contextual distinction.
An upgrade may preserve a local occurrence ID when it is the same use, but changed
feature mappings require reviewed correspondence; do not guess from label equality.

Composition must be acyclic for a resolved assembly. References, annotations and impact
links may form other graphs; reject cycles only where the relationship semantics require
it. Relationships are typed: containment, electrical connection, physical mating,
mounting, source derivation, documentation and procurement are not one generic edge.

## Options and resolved configuration

Keep option definitions, selected choices and the complete resolved configuration distinct.
A result captures its rules, facts and decision explanations. Component populations,
firmware assignments and permitted process/material choices resolve deterministically.
An occurrence cannot override a pin assignment, copper net or manufacturing geometry
that belongs to its pinned revision without a new owning revision/configuration.

Missing choices remain explicit. Engineering result is valid/invalid/unknown/not-evaluated
with reasons and applicability. Development proposals are separate linked objects; a
solver may return invalid-with-proposal or unknown-with-information-request.

## Facts, units and uncertainty

An assertion identifies subject/feature, property, value if known, unit where applicable,
conditions, source/evidence, status and applicability. Explicitly distinguish known,
unknown, conflicting, not-applicable and not-evaluated facts. Do not place guessed values
in known fields. Reviewed is not measured; a user preference is not a rating.

Use dimension-aware units, canonical representations for calculation, and original units
for traceability/display. Counts, lengths and mass are not interchangeable inventory
quantities. Financial values use explicit currency and suitable precision but are optional.
Tolerances, upper/lower bounds and nominal values are different facts. Capture conditions
such as temperature or process where they affect applicability.

Separate an illustrative nominal dimension from a manufacturing dimension. The UI may
use declared fallback display geometry, but the fact must remain unknown and fit checks
must not use the fallback as measured evidence. Preserve conflicting sources for review.

## Sources, revisions and artifacts

The database is authoritative for controlled identity, version, relationships and workflow.
Each native property has explicit source ownership. Original imports are immutable blobs
in a versioned bundle. Editable derivatives have separate ancestry. Extraction is tied
to source revision and extractor version, with loss/unsupported-semantics reports.

An artifact includes source/build identity, content hash, media type, byte count, rights,
applicable configuration and limitations. Identical bytes may have different access and
provenance records. Paths are portable package-relative names, never primary identities.
A file present in storage is not proof of successful build or authorization to distribute.

## Interfaces and topology

A connector body is distinct from pinout/electrical contract and from installed orientation.
A port can map to internal terminal features. Support polarity, mating-side views and
permitted contact correspondence without reusing ambiguous drawing coordinates as identity.

Copper continuity edges connect conductors, joints and copper nets only. Passive/active
component passages retain their type and conditions. A structural graph reachability
routine may discover candidate paths, but electrical interpretation decides what those
paths mean for the requested query (DC continuity, signal path, resistance, etc.).
Do not combine incompatible switch states from separate candidate paths into one proof.

Ground/shield bonds are explicit electrical relationships; geometry gathering several
screens into one pigtail is not itself evidence of a bond. Displaying or hiding foil
never creates/removes electrical material.

## Cable lengths and preparation

A construction hierarchy identifies conductors, groups, layers and shield/drain elements.
A preparation profile identifies per-end stripping and termination practice. Instance
preparation may differ from stock construction without creating fictitious stock ratings.

Store route, finished, stock-cut and conductor-cut lengths separately. A derived length
lists included allowances, direction/meaning and formula. An unknown allowance propagates
unknown to affected output. Explicit zero is allowed only as a known input. Do not infer
that every stock/conductor shares one universal length formula; profiles define the rule.

## Geometry

Geometry has units, frame identity, role, source/model revision, accuracy and feature map.
Canonical transforms define physical assembly placement. View transforms define exploded,
open, illustrated or sectioned arrangements separately. Selection keys reference
engineering features and occurrences, not mutable row order or mesh triangle indices.

Derived display meshes can be reused by shape key while occurrences retain distinct
identity. Right-handed transforms and unit conversions are explicit at adapter boundaries.
A fixture's numerical display coordinates are not proof of real component tolerances.

## Workshop and physical records

One stock ledger records receipts, adjustments, reservations, consumption and returns.
Reservations are claims on availability, not consumption. Competing reservations use
transactional checks. Replayed requests cannot double-consume stock. Physical lot/unit
identity is distinct from definition/revision. Record as-planned and as-built separately.

BOM views declare scope and procurement boundaries. Purchased populated assemblies stop
procurement expansion unless an explicit make decision changes that boundary. Assembly
contents still remain inspectable. Consumables and waste are distinguished from retained
unit composition. Partial builds record actual use and returns, not just planned totals.

## Evidence and release

Evidence has subject unit/batch or design scope, exact applicable configuration, procedure,
instrument/observation context, origin and time. Design calculations/checks attach to design
inputs; physical tests attach to actual subjects. No implicit qualification propagation
from one unit to all instances or from one population to another.

An applicability rule can mark an observation superseded or inapplicable to new state
without deleting history. A release freezes closure: revisions, configurations, sources,
artifacts, reviewed rights and acknowledged unresolved items. Later security/engineering
warnings may be linked to a historical release, but never rewritten into its original
approval record.

## Privacy and access

Scopes are server-authorized. Every traversal, search, job, artifact fetch, export and
where-used response filters access, including counts, suggestions and error messages.
Permissions are checked at submission, execution, result acceptance and disclosure.
Private reference presence must not leak through cache hits, hashes, autocomplete or
unfiltered dependency counts. A release is frozen design state, not irrevocable public
permission; current access and rights still govern disclosure.

The Discovery workspace searches currently accessible projects, reusable definitions,
source bundle names/paths, manufacturer associations, physical lots and stock accounts.
`catalog.search` and `catalog.where_used` are live reads without idempotency keys;
HTTP query adapters use the same scoped queries. Search labels do not establish reviewed
matching, interchangeability or catalog adoption.

Where-used reports exact captured snapshot pins for a selected revision. These pins
describe retained dependency closure, not occurrence counts, electrical connections or
compatibility. Current authorization covers each parent's complete closure before it
appears. Pagination advances from visible records and discloses no inaccessible parent
names, identifiers or aggregate counts. Updating a definition does not change these pins.
