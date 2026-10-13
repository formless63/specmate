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
`/api/v0/shared-scenes`: `/projects/{project_id}` lists readable choices among the
latest 50 frozen assembly revisions, and `/snapshots/{snapshot_id}` reads an exact
scene. Older snapshots remain addressable explicitly. Captured unfrozen draft
snapshots are rejected by this view; they are not presented as frozen design state.

The projection reuses the assembly's canonical `Placement`, exact dependency
closure and contextual firmware assignments. Every nested occurrence retains its
root snapshot/path address, exact definition/revision/snapshot hash and independent
feature addresses. Stable native UUIDs identify PCB components/pads; declared local
IDs identify cable endpoints, stock elements, harness sections/segments and mechanical
models/targets. Labels and reference designators are display text. Shared geometry
resources do not merge contextual selection or repeated firmware assignments.
Typed relationships retain their containing assembly context and original references.

Canonical transforms are row-major 4×4 matrices acting on column vectors in
millimetres, right-handed Z-up. The root defines the scene origin. World-from-local
is parent-world-from-local multiplied by the declared parent-from-local transform;
quaternions retain the normalized XYZW assembly convention. Unknown local placement
or any unknown ancestor produces an unknown world transform, never an identity or
zero-position substitute. A feature without a complete declared frame/placement
retains unknown feature transforms even when its containing occurrence is placed.
Declared mechanical model units retain exact factors (metres 1000, inches 25.4,
millimetres 1); absent units remain unknown. A unit factor does not establish a
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

## Canonical placement and mounting declarations

The Assemblies tool authors each directly owned occurrence's explicit canonical
translation and X/Y/Z/W quaternion in the containing assembly's right-handed,
Z-up millimetre frame. A known transform requires all three finite coordinates
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
