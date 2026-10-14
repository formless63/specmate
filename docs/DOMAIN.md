# Domain model and invariants

This document sets semantic rules. Concrete table/class names may evolve before v1.0.0;
the rules do not silently change with implementation convenience.

## Workspace, collections and projects

Status: accepted target model. Until the workspace-collections migration lands, the
implementation still records a project on many records; that is not the target meaning.

A **workspace** is the sharing and privacy boundary. An installation currently has exactly
one workspace; records carry their workspace identity so that more can exist later
without changing the engineering model. Every member of a workspace can read everything
in it. Someone who is not a member cannot learn that its records exist.

The workspace owns its **global collections**. Nothing in a collection lives in a project:

| Collection | Contents |
| --- | --- |
| Definitions | Every definition kind with its drafts, snapshots and revisions: parts, connector bodies, pinouts, wire stock, cables, harnesses, boards and populations, firmware, interfaces and assessments, assemblies, option sets and configurations, workshop and preparation profiles, BOM, material and test plans, mechanical sources, passive models, PCB source reviews. |
| Catalog associations | Manufacturer variants, representations, physical lots, reviewed match candidates/decisions, passive-model reviews, upgrade proposals and their reviews/applications, firmware adoptions. |
| Catalog packs | Installed packs, versions, entries and adoption decisions. Adoption creates workspace definitions. |
| Sources | Blobs, original and derivative bundles, revisions, files, archive expansions, edit submissions and property-authority lineages. Identical bytes are registered once per workspace. |
| Derived records | Builds, stages and accepted outputs; PCB intake and interpretations; resolved configurations; mechanical proposals; scene drawings; bench document sets. |
| Workshop | Stock locations, accounts, the stock ledger, reservations, work batches and completions, physical units. |
| Facts and knowledge | Fact subjects and assertions about items and units; notes, decisions and attachments about library items. |

A **project** is a composition and decision context. It holds only its own things: its name
and purpose, its requirements, alternatives, decisions, notes, reviews, releases, and an
explicit set of **references** to collection items it uses. A reference names a definition,
an exact revision, a source bundle, a physical unit or another collection record, with
the role it plays in the project. Adding or removing a reference never creates, copies,
moves, edits or deletes the referenced item. Several projects can reference the same item;
a project can reference an item that was created outside any project.

Creating something while working in a project adds it to the workspace collection, and
the project may then reference it. Removing a project's reference, or archiving the project,
leaves the item and every other use in place. A record's optional project context (for
example the project a note, reservation, work batch or review was made for) helps
navigation and filtering. It is never an authorization boundary and never an owner.

Exact pins stay where they are: in frozen snapshots, captured configurations, build inputs
and releases. A project reference to a definition is a working-set entry, not a pin;
a release made in a project freezes the exact revisions, configurations, sources and
artifacts it depends on. Where-used reports both captured pins and project references,
and states which kind each use is.

Every dependency, pin, link and reference stays inside one workspace. Bringing material
from elsewhere is an explicit import (a catalog pack, a source upload or a portable
package), recorded with its origin and rights; it never becomes a live cross-workspace
reference. All other invariants in this document apply unchanged to workspace records.

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

Views lead with identity a person can read: definition or source name, kind and revision
number (`Name · kind · r2`). Exact revision IDs, snapshot IDs and hashes stay available as
expandable evidence with a copy control, never as the primary label. `catalog.revision_labels`
resolves names for exact design and source revision IDs the caller already holds, under the
same read authority as reading the revision itself, including its complete pinned closure.
A missing revision and one outside the actor's workspace return the same entry with no
name, kind or number, and the view says "Not readable by you".

Discovery compares explicitly selected old and later revisions of one definition through
`catalog.revision_impact`. It reports changed design content and dependency pins and
lists workspace parent snapshots retaining the old exact pin, together with projects
that reference either revision. Results are paginated. Comparison does not establish compatibility, feature correspondence or
release applicability. Adoption requires a new owning draft, explicit revised selections
and review; no frozen consumer is rewritten. [Revision upgrade proposals](REVISION-UPGRADES.md)
retain exact assembly snapshots and selected direct occurrences, separate review history,
explicit declared-contact correspondence and deliberate adoption into an owning draft.
Nested adoption, other owning kinds and further feature adapters remain separate work.

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

An `option_set` revision declares options for parts, population options, firmware,
material/process choices and requirements; each choice pins an exact frozen revision or
declares a value, and population/firmware options address one occurrence path of an exact
target assembly revision. A `configuration` draft pins one option-set revision and records
selections. `configuration.capture` stores an immutable resolved snapshot recording each
decision's source (selected, default or none) and every unresolved option;
`configuration.build_input` refuses an incomplete resolution. Later defaults, option-set
revisions or chosen-definition revisions never change a captured resolution, and no frozen
consumer is rewritten. Compatibility between choices remains `not_evaluated` there.

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

Scopes are server-authorized. The workspace is the privacy boundary: membership and the
member's workspace role decide what an actor may read and do, and project references
never widen or narrow that. Every traversal, search, job, artifact fetch, export and
where-used response is limited to the actor's workspace, including counts, suggestions
and error messages. A record outside it is indistinguishable from a missing one.
Permissions are checked at submission, execution, result acceptance and disclosure.
Workspace presence must not leak through cache hits, hashes, autocomplete or dependency
counts. A release is frozen design state, not irrevocable public permission; current
access and rights still govern disclosure, export and publication.

The Discovery view searches projects, reusable definitions, source bundle
names/paths, manufacturer associations, physical lots and stock accounts in the actor's
workspace. `catalog.search` and `catalog.where_used` are live reads without idempotency
keys; HTTP query adapters use the same scoped queries. Search labels do not establish
reviewed matching, interchangeability or catalog adoption.

Where-used reports exact captured snapshot pins for a selected revision and, separately,
the projects that reference it. Pins describe retained dependency closure, not occurrence
counts, electrical connections or compatibility; a project reference is a declared use,
not a pin. Pagination advances from stable record order. Updating a definition does not
change these pins.
