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
