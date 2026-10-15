# Mechanical and shared-scene workflows

## Geometry ownership

Use build123d/Open CASCADE for new programmatic recipes and FreeCAD for native source
workflows. Retain source ancestry and exact board/model inputs. B-rep/manufacturing,
clearance and illustration geometry have different purposes and quality. Display meshes
are derived and never the sole stable identity of a mounting feature.

## Proposals

Generate enclosures, bosses, openings, vents, hardware and cable guides from declared
parameters and geometry. Preserve unknown tolerances, process/material behavior and
connector envelopes. Show the facts used and the remaining physical checks. A valid solid
or collision-free approximate mesh does not prove fit/printability.

### Parametric proposal drafts

`mechanical_proposal.create`, `.update`, `.retain`, `.read`, `.read_retained`, `.list`,
`.board_choices` and `.board_inputs` (HTTP reads under `/api/v0/mechanical-proposals`)
produce reviewable drafts for an enclosure outline, mounting bosses with lid fastener
holes, wall connector openings, lid/floor vent slot grids and cable-guide post pairs.
A draft pins one accepted native board interpretation (`pcb.accept_extraction`) in its
own workspace and holds declared parameters under compare-and-set (`proposal-v<N>`).
The proposal is regenerated deterministically from the pinned report on every read,
after fresh workspace membership; nothing is stored that could drift from
its inputs. Creating a draft needs `item.create`; editing needs `design.edit` (contributors may edit drafts they
created). Reads need workspace read and use `/api/v0/mechanical-proposals/workspaces/{id}/...`.

Every numeric declaration is nullable and nothing is defaulted. An unknown wall,
clearance, boss or pilot diameter, standoff, lid hole, connector envelope, centerline
offset, vertical reference (back-side components have none), vent pitch or margin, or
cable diameter leaves exactly the dependent geometry null and lists the missing input in
`unresolved`; the proposal status is `incomplete`. A zero is only a deliberate
declaration. Native non-plated drills are `candidate-not-reviewed`: a hole becomes a boss
only through an explicit per-hole choice, and an undecided candidate stays unresolved.
Components and holes are referenced by native UUID, never by reference label; an unknown
identity is rejected rather than ignored. The component origin is not a connector
centerline, so the lateral offset is a required declaration.

Output is planar, in the native board frame (millimeters, x right, y down; west is minimum
x, north is minimum y), with the enclosure derived from the bounding rectangle of the
native outline and an explicit note when the outline is not a single axis-aligned
rectangle. Geometric checks (hole center inside outline, boss clear of cutouts, boss within
cavity, pilot smaller than boss, boss overlap, opening within wall span, opening
separation, guide span, guide clear of openings, vent slot survivors after boss keep-out)
report `pass`, `fail` or `not_evaluated`. They are arithmetic on declared inputs. Status
`declared_inputs_complete` is never a fit, clearance, printability, manufacturing or
thermal conclusion: the document carries `qualification` flags set to not evaluated and
the list of remaining physical checks. Vent open area is a plan-view geometric area, not
an airflow claim.

`mechanical_proposal.retain` records the exact current proposal, incomplete or not, as an
immutable content-addressed derived record (database triggers reject update/delete and
check the pinned draft, board hash, status and `physical:false`). Retaining identical
content again returns the existing record. Drafts and records create no design draft,
snapshot, placement or source and cannot change a frozen revision. Solid CAD, STEP/STL
output and native build123d or FreeCAD generation remain separate approved tool stages;
this planar generator is original code.

`mechanical_proposal.decide` appends an accept, reject or defer decision (mandatory reason)
to a retained proposal under `design.edit`, compare-and-set on `decision-v<N>`. Decisions are
append-only rows (database triggers reject update/delete, enforce sequence and workspace);
the retained bytes and any frozen item never change. Accepting either creates a design
definition of kind `enclosure_proposal` through `definition.create` logic (its content pins the
retained id and hash, `physical_qualification: false`) or links an existing design draft in the
same workspace without editing it; an accepted decision is final. Reject and defer can be
revisited. `read_retained` returns the decision history and current decision.

The Parametric proposals tool (Design area) lists drafts, creates one from an accepted
board, edits blank-is-unknown declarations with per-hole mount decisions, saves under the
draft token (a stale save keeps the unsaved text and offers an explicit reload), shows the
saved proposal with a plan view, unresolved inputs, checks, facts and remaining physical
checks, retains or inspects immutable records, and records review decisions on them. Mutating controls follow the project's
edit permission, and an access change clears every retained board identity and proposal.

## Scene

One scene projection carries contextual occurrence and feature IDs, units/frames and
canonical placement. A separate display arrangement handles section/open/exploded views.
Repeated instances may share geometry without sharing selection or firmware assignments.
Maintain mappings across tree/board/cable/BOM/inspector views. Wire-local coordinates can
be adapted without rewriting retained geometry conventions; document the frame transform.

Project tools load their code on the first tab visit. Visited panels retain unsaved
draft state while hidden; project changes and sign-out discard that state. A tool that
cannot load displays a contained error and an explicit page reload action. The wire
viewer draws on control, resize or model changes without an animation loop, suppresses
draws in zero-width hidden tabs and hidden documents, and draws the retained model when
visible again. Closing it disposes scene resources and releases its WebGL context.
These lifecycle rules do not establish hardware performance or physical qualification.

### Exact frozen scene inspection

`shared_scene.list` and `shared_scene.read` are read-only operations shared by the
HTTP and authorized agent/job paths. The Shared scene tool deliberately selects a
frozen assembly snapshot, independently of editable drafts. The scoped router is
`/api/v0/shared-scenes`: `/workspace` lists the latest 50 frozen assembly revisions in
the actor's workspace collection (members read every item), and `/snapshots/{snapshot_id}` reads an exact
scene. Older snapshots remain addressable explicitly. Captured unfrozen draft
snapshots are rejected by this view; they are not presented as frozen design state.

An explicit `assembly.snapshot` capture can instead be inspected through the read-only
`shared_scene.preview_captured` operation or
`/api/v0/shared-scenes/captured-snapshots/{snapshot_id}/preview`. This uses the same
current actor, root origin, complete dependency/source authorization, geometry limits
and transform projection. Its separate `basis.kind = captured_draft` reports the
immutable snapshot's draft ID, captured draft version, snapshot ID and hash. The root
has no revision ID. Later editing or freezing cannot change that captured basis. The
preview neither saves nor freezes anything and establishes no fit, clearance,
manufacturing or physical qualification. A client must withdraw it when its working
buffer diverges from the captured state; frozen-only contextual reads keep their
existing exact-revision contract.

The projection reuses the assembly's canonical `Placement`, exact dependency
closure and contextual firmware assignments. Every nested occurrence retains its
root snapshot/path address, exact definition/revision/snapshot hash and independent
feature addresses. Stable native UUIDs identify PCB components/pads; declared local
IDs identify cable endpoints, stock elements, harness sections/segments and mechanical
models/targets. Labels and reference designators are display text. Shared geometry
resources do not merge contextual selection or repeated firmware assignments.
Typed relationships retain their containing assembly context and original references.

Canonical transforms are row-major 4×4 matrices acting on column vectors in
millimeters, right-handed Z-up. The root defines the scene origin. World-from-local
is parent-world-from-local multiplied by the declared parent-from-local transform;
quaternions retain the normalized XYZW assembly convention. Unknown local placement
or any unknown ancestor produces an unknown world transform, never an identity or
zero-position substitute. A feature without a complete declared frame/placement
retains unknown feature transforms even when its containing occurrence is placed.
Declared mechanical model units retain exact factors (meters 1000, inches 25.4,
millimeters 1); absent units remain unknown. A unit factor does not establish a
model's target correspondence or convert an unextracted model into accepted geometry.

Supported display primitives retain their restricted meaning. Accepted PCB reports
provide planar outline/cutout drawings: native X/Y maps to illustration X/−Y, with
the drawing plane at display Z=0. That plane does not supply missing board thickness,
component depth, a local manufacturing datum or a 3D envelope. Source/report hashes,
rights, extractor/version and coverage remain visible. Population options and model
associations are inspected explicitly; no population option is chosen implicitly.
Stock/cable construction uses the retained TypeScript section and wire renderer:
wire-local +X is the illustration axis, and section X/Y becomes local Y/Z.
A declared finished cable length permits a straight stock illustration; absent length
permits only a section. Neither establishes an installed route. Shared harness
physical sections are represented once per section with their distinct segments;
their routes and placements remain unknown. Connector/interface drawing positions
retain their declaration without inventing a 3D body. Firmware, hardware and other
disciplines remain inspectable even when geometry is unavailable.

Mechanical source models remain inert. Their exact representation, represented
revision/snapshot, selected source hash/rights, target, purpose (manufacturing,
clearance or illustration), declared units/frame/accuracy and correspondence basis
remain separate from accepted geometry. The web application does not fetch model
URLs, import native scripts or parse arbitrary meshes/CAD. Native extraction requires
separately approved tool packs. An unsupported or missing model is reported and
retained, not dropped or replaced by a guessed box.

The canonical display draws only placed supported illustrations. The deliberate
inspection arrangement separates local illustrations with temporary display spacing,
including unplaced occurrences and section features. It changes no canonical
placement or engineering state. The occurrence/feature inspector includes records
with no drawable geometry and explains unknown placements, dimensions and quality.
The viewport loads only when opened, uses orthographic orbit/top/end views, draws
on demand, suppresses hidden-panel/document draws and disposes shared resources and
its WebGL context on close. Context loss requires closing and reopening the viewport.

Every projection and choice list rechecks current project, dependency, source ancestry,
represented-model, catalog-origin and typed fact/source authority before disclosing
labels, hashes or geometry. Scene access refresh and browser focus/reveal hide prior
scene state while checking authority. A failed check clears it; stale asynchronous
success cannot reopen denied or changed context. Geometry sharing is local to the
authorized projection, without a persistent cross-project disclosure cache. A drawn
mesh or outline does not establish fit, clearance, manufacturing approval or physical
qualification.

### Transient view arrangements

The lazy shared and connected scene viewports offer exploded root branches, chosen
open/closed display rotations, uncapped section clipping and orthographic isometric,
top, front and end views. These are illustration controls with no engineering write
path. The underlying frozen occurrence and feature addresses, geometry dimensions,
source pins, canonical matrices and engineering measurements remain identical.

Explosion uses explicitly chosen display spacing along a world display axis. Every
nested descendant shares its exact root branch offset. A canonical occurrence with
unknown placement stays omitted and unknown; spacing never assigns it a placement.
Local inspection can still show its separate illustration, without establishing a
canonical world frame. Opening applies to a deliberately selected whole occurrence
branch, composing a chosen local axis, angle and pivot through its known canonical
world frame. It is disabled in local inspection or for unknown frames. The default
pivot is the explicitly displayed local origin, not an inferred physical hinge.
Opening records no motion envelope, measured closed condition or manufacturing claim.

Section clipping retains the chosen positive or negative half-space of the displayed
world-axis plane. Rendering and pointer picking use the same plane, so clipped-away
geometry cannot be selected through invisible fragments. Cuts have no generated caps,
native cross-section geometry or inferred thickness. A fully clipped occurrence or
feature remains selected and inspectable through its exact contextual address.

Restore canonical display resets explosion, opening, section controls and camera,
selects the canonical base arrangement and rebuilds from untouched frozen matrices.
Closing the opened branch also derives its closed display directly from the canonical
inputs, without accumulating inverse-transform roundoff. Neither action selects a
different use or feature. Replacing the snapshot/hash disposes old geometry and resets
transient controls; existing host project/principal/access boundaries discard the
viewport when authority changes. Changes draw on demand, hidden views stay paused,
and close/context-loss cleanup retains the existing resource lifecycle.

### Connected contextual inspection

The contextual inspection workspace connects tree, native board plane, cable/harness,
scene, inspector, schematic context and BOM context around one currently authorized
frozen root. Its transient selection is either an exact occurrence address
`{snapshot_id, path, feature_id?}` or an independent reusable revision ID. A revision
selection carries no containing placement or firmware assignment. Equal display
references, native feature IDs and shared geometry never merge repeated occurrences.

Board components and pads use the exact accepted native feature IDs owned by the
selected occurrence. Marker size is only a selection aid. Native schematic geometry
and board-to-schematic correspondence remain visibly unavailable; reference and pin
labels establish no identity. Cable views expose exact typed relationship context
without inferring installed routes, terminal correspondence or physical continuity.
The existing scene viewport highlights a containing occurrence when a selected feature
has no drawable 3D geometry, while retaining the exact feature selection.

The host supplies the signed-in principal and selected project. Project, principal or
root changes remount the scope and discard selections and retained data. Fresh reads
check the root definition against the selected project's authorized definitions and
the existing scene authority closure. Explicit refresh, focus and document reveal hide
all connected content while rechecking. A denial clears every connected view and
selection intent; older responses cannot reopen it. Project choice refresh also hides retained connected data while its current authority
check is pending; selection intent returns only after a fresh exact root read succeeds.
Adapter reads use monotonic scope, read and optional selection tickets, never labels or
a persistent disclosure cache. Duplicate feature addresses within one occurrence fail
coherence checks rather than selecting an ambiguous first match.

A frozen BOM plan is optional and independently selected. Context mapping requires
the same root assembly revision, snapshot and hash, with exact per-use addresses and
revision pins. The response must also match the explicitly requested frozen BOM plan
and purpose. Supplemental rows are checked against the plan's exact need identity,
owning path and orderable revision; a need identifier alone establishes no mapping.
Grouped rows expand into separately selectable uses and retain their
individual quantities, boundaries and unresolved reasons. Supplemental needs select
their owning context and do not imply another physical occurrence. Filters, grouping,
view changes and local scene arrangements preserve selection without rewriting
canonical placement or engineering state. Deliberate occurrence picks select the whole
use; selecting a feature is a separate exact action. Standalone discipline tools remain
independent from this connected occurrence context.

## Canonical placement and mounting declarations

The Assemblies tool authors each directly owned occurrence's explicit canonical
translation and X/Y/Z/W quaternion in the containing assembly's right-handed,
Z-up millimeter frame. A known transform requires all three finite coordinates
and a unit quaternion. Empty coordinates remain missing, and a known origin or
identity rotation is a deliberate input. The user can explicitly normalize a
finite nonzero quaternion. Selecting unknown stores no translation or rotation.
Moving a containing module preserves its frozen children's own local transforms;
independently repeated modules keep distinct occurrence paths and placements.

`assembly.placement_inputs` supplies bounded, freshly authorized nested occurrence
choices with exact design revision and child snapshot hashes. The owning draft,
catalog-pack origin, retained base snapshot and complete child/source/model closure
are checked before paths, names or canonical declarations are returned. Its local
placements are in each containing assembly's frame, not composed world transforms.
This read performs no mutation and accepts no idempotency key.

Mounting declarations choose exact mounted and support occurrence paths, optionally
including unverified stable feature identifiers. A whole occurrence and a feature
address are distinct. Names and references assist selection without establishing
identity. A typed mounting link records assembly intent; feature existence and
correspondence remain unevaluated by this authoring workflow. It creates no mating
solver result, geometry, inferred coordinates, fastener dimensions or fit approval.
Boards, mechanical source declarations, hardware and internal cables can participate
through their existing frozen revisions and typed relationships.

Saving and freezing use the shared `assembly.update` and `assembly.freeze`
operations, immutable canonical snapshots and exact dependencies. Authoring retains
its original draft token through an authorized refresh. A later server edit requires
deliberate loading of the latest draft; it cannot silently replace an unsaved edit's
compare-and-set token. An identical save retried after a lost response retains its
exact payload, state token and idempotency key. Capture and freeze use saved content
with the displayed editor's original token; a successful save, successful freeze or
explicit latest-draft adoption advances that token. Capture retries also preserve
their exact state and idempotency key after response loss.
Current source/model denial hides private results, labels, choices and controls.
Own staged fields and their original token remain inert until an explicit refresh
freshly authorizes the selected scope and the original retained revision pins.
Changing projects or leaving the editor clears this retained input. Frozen inspection
rechecks authority and shows quaternion, contextual
mounting endpoints and explicit feature/fit limits. Read-only users inspect these
declarations without mutation controls. Display arrangements remain separate from
the saved canonical placement and mounting relationships.

## Acceptance emphasis

Use occurrence/transform fixtures and an independently dimensioned synthetic board/enclosure.
Check unit conversion, repeated nested selection, canonical placement preservation,
missing-model limits, orthographic output and on-demand rendering. Remote high-memory/GPU
jobs use the same manifests/authority, not a different engineering catalog.

## Reusable native source declarations

`mechanical_source.create`, `mechanical_source.update`, `mechanical_source.freeze`
and `mechanical_source.read` manage reusable enclosure, part and hardware declarations
through the shared operation envelope. The Mechanical sources tool pins existing Source
bundle revisions, selected package-relative file hashes and rights. Original and derivative
bundles keep their existing immutable bytes, manifests and ancestry; editing a declaration
does not edit its native files. Use the Sources edit handoff and reviewed submission to
create a derivative, then deliberately update the declaration to its exact new revision.

Each target pins a frozen design revision and snapshot hash. Typed PCB population targets additionally pin
the accepted interpretation hash, native source revision and manifest. A board population
option and a native component UUID are explicit choices; reference labels never establish
identity. An ordinary part/hardware target may pin its own reusable catalog revision.
A board revision without an accepted interpretation may still be pinned with explicit
unknown geometry; its declaration cannot supply native component or clearance evidence.
References may cross currently accessible projects without transferring ownership or granting
new access. The owning project requires design edit/freeze authority while all referenced
source/model/target closures require current read authority, including retained ancestors.

Model declarations pin a catalog model representation, its exact represented revision and
snapshot, selected source file, and an explicit local target. Their manufacturing, clearance
or illustration purpose, units, frame, accuracy and correspondence basis remain declarations.
An association does not establish verified feature correspondence, compatibility or fit.
Missing units, frames, accuracy, population choices or geometry remain unknown. Invalid
native component/option selections block freezing; unresolved geometry may be frozen with
limitations. Capture records exact target and represented-model dependencies and preserves
all source pins in immutable canonical state.

Declared FreeCAD, build123d, CadQuery, STEP, B-rep, mesh and other formats are stored as
inert preserved files. This source-management path does not parse CAD, import scripts,
resolve host model paths, fetch remote models or execute tools. Unsupported content stays
visible with unknown semantics. Extracted PCB outlines and their adapter/version/coverage
can be inspected as retained inputs; absent outlines provide no clearance evidence. Native
geometry validation, clearance, fit, manufacturability and physical qualification remain
unevaluated. Native extraction/proposals need separately approved versioned tool stages.

The read router offers bounded record/target lists and exact draft/revision/target views
under `/api/v0/mechanical-sources`. It rechecks full current authority before returning
labels, hashes, cursors or provenance. The browser preserves the original draft token on
stale-save errors, hides retained and unsaved declarations after access denial, and requires
an explicit refresh with current closure checks before showing them again. An identical
save retried after a lost response uses the same reviewed idempotency key.

### Material, process and geometry uncertainty

A mechanical source can retain structured `uncertainty` collections for materials,
processes, tolerances and connector envelopes. An absent collection is unassessed,
not an assertion that no assumption is needed. Each row has a stable local ID,
`unknown`, `declared` or justified `not_applicable` status, and an explicit basis.
Material/process rows scope either the mechanical item itself or one exact pinned
local target; they do not inherit supplier facts or apply automatically to other targets.
Material specification and behavior, process method, parameters and behavior remain
separate declarations. Missing behavior supplies no shrinkage, deformation or capability.

Tolerance rows identify their dimension/feature, item/target and optional exact local
model. Bounds are finite lower/upper deviations in millimeters, with lower no greater
than upper. Explicit zero bounds are valid declarations; unknowns retain null bounds.
Connector rows identify a deliberately selected target and body, mated, installation
or cable-route usage. Declared min/max XYZ bounds in millimeters need an explicit
frame and basis; they are not a computed solid or verified target correspondence.
Unknown or not-applicable rows carry no guessed numeric geometry. A target with no
connector scope remains unassessed: no reference label infers connector identity,
and one declared usage does not cover another usage or operating configuration.

The shared read operation and its HTTP view return an `uncertainty_assessment` with
exact purpose-specific model/source hashes and rights, declared scopes and structured
missing prerequisites. It identifies missing model units/frame/accuracy, missing
model tolerance scope, unassessed connector scope and unsuitable manufacturing format.
Purpose-transfer limits are informational: a clearance or illustration model is not
inherently unsuitable for its own declared purpose and need not supply manufacturing geometry.
Illustration geometry supplies no manufacturing/clearance evidence; a mesh or a recipe
labeled manufacturing is not validated B-rep. Even a complete set of listed declarations
has only `declared_inputs_only` readiness with explicit scope coverage. Native validation,
feature/frame correspondence, interactions of tolerances, operating envelopes and physical
checks remain unevaluated. A closed, dimensionally correct illustration mesh cannot
establish fit, clearance or manufacturability.

Authoring uses the existing shared create/update operations, original draft CAS and
idempotency guards. Both named and generic capture preserve incomplete/unknown declarations
in immutable canonical state and never qualify them. Reads recheck the full current
source/model/target closure before returning assumptions or diagnostics. The Mechanical
sources editor and read-only frozen view expose the same declarations and missing
prerequisites; editing later assumptions leaves retained snapshots unchanged.

## Retained scene inspection drawings

An exact frozen assembly can produce an immutable internal inspection SVG and JSON
manifest through `shared_scene.create_drawing`. A workspace member may deliberately
create this derived inspection record; it edits no definition, placement, source,
inventory, physical unit or release state. The drawing belongs to the root snapshot's
workspace and takes no project. The request requires an idempotency key scoped by
actor and workspace; the request fingerprint pins the exact snapshot, renderer
version and options.
Historic receipts are reauthorized before replay or conflict disclosure. Current
root, nested input, source ancestry, model and target authority is checked before
labels, rendering, retained metadata and each byte download. The whole closure stays
inside the root's workspace; a non-member receives the same not-found response for
the root, the drawing and every download.

Renderer `scene-line-svg-v1` projects accepted planar PCB outlines and declared
positive stock lengths as explicitly labeled stock axes. It provides top, front,
end and isometric orthographic illustrations, chosen branch opening/explosion and
uncapped line clipping. Each instance retains an exact occurrence or feature
address. Unknown canonical world placement remains unknown and undrawn. Features
with unknown independent frames never inherit a guessed occurrence frame. Native
mechanical models, complete wire/coax sections, installed routes, board thickness
and component envelopes remain unavailable in these outputs. Existing interactive
stock/Three.js renderers are retained separately. No native parsing or execution,
PNG output, fit, clearance, manufacturing approval or physical qualification is
claimed.

Canonical matrices, revision/snapshot hashes, contextual firmware and source/model
pins, declared roles, rights and unresolved prerequisites remain in the manifest.
SVG line coordinates round to six decimals; the fitted screen viewport has no
calibrated print scale. Renderer v1 rejects nonfinite or absolute display coordinates
above 1e9 mm, more than 20000 processed segments, or more than 8 MiB per SVG/manifest.
These are illustration bounds, not constraints on the engineering model. The
manifest declares the orthographic projection basis; true isometric views use
(1,-1,1), independently of the interactive viewport camera preset. A drawing is
not a byte-identical viewport screenshot. Restore
rebuilds the default display request from unchanged canonical inputs.

Stored SVG and manifest bytes share one database transaction with the operation
receipt. Database guards prevent later mutation and reject mismatched snapshot,
workspace, options and output hashes. The retained package contains `drawing.svg`
and `manifest.json` with deterministic archive metadata. Restricted or unknown
source rights stay explicit: internal inspection grants no blanket redistribution,
publication consent or release authority. Labels are escaped in generated-only
SVG tags, with no scripts, embedded external assets or imported SVG content.
The panel keeps preview bytes transient, clears them on account/project/focus or
visibility or host-tab activation changes, and freshly authorizes and checks hashes for every preview
and download. It offers explicit same-key retry after a lost generation response.
