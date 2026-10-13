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

## Acceptance emphasis

Use occurrence/transform fixtures and an independently dimensioned synthetic board/enclosure.
Check unit conversion, repeated nested selection, canonical placement preservation,
missing-model limits, orthographic output and on-demand rendering. Remote high-memory/GPU
jobs use the same manifests/authority, not a different engineering catalog.
