# Wiring, interfaces and preparation

## Ownership

Stock construction, preparation profile, finished topology and display arrangement are
separate records. Preserve element IDs for conductors, layers, screens and drains. A
reviewed bond belongs to electrical topology, not a geometric gathering operation.
One body can carry different logical pinouts; viewing side/orientation is explicit.

## Reuse boundary

Adapt capable prior section layouts, SVG callouts, layered tube geometry, pigtail handling,
React Flow projection and lazy viewers. The code may remain TypeScript. Review embedded
company/process assumptions before publication. A generic exporter must not force a
simpler stock schema. Reuse useful existing document generators before adopting a new one.

## Implementation slice

Create/read/edit stock through commands; preserve unknown dimensions/ratings. Derive a
section layout that documents and geometry consume. Add finish/topology/terminations and
preparation. Expose independent trace query semantics for copper, resistive passage,
conditional paths and unsupported active behavior. Compose output from resolved inputs.

Do not add stock quantities by counting visible mesh pieces. Hidden inner layers are a
render optimization, not missing material. Profile selection identifies stripping/braid/
drain rules and sources. Route length is not interchangeable with finished or cut length.

## Acceptance emphasis

Use the synthetic section, preparation and topology fixtures. Preserve earlier visual
baselines only after checking their interpretation. Validate standalone stock and cable
packages, repeated contextual use, mirrored pin views, shared screen bonds, branches and
unknown allowance propagation. A stock-only user must not configure a device or PCB.

## Standalone stock contract

Stock construction is version 1 typed state in a `wire_stock` definition's draft,
with exact frozen state in the shared revision/snapshot records. Dedicated
`wire_stock.create`, `wire_stock.update`, and `wire_stock.freeze` commands use the
same authorization, idempotency and optimistic state tokens as other operations.
Project stock queries do not require connectors, devices, PCB sources or topology.

Stable local element IDs form hierarchical paths. Groups declare concentric,
ring, linear or figure-eight arrangements. Explicit pitches and offsets locate
conductors, drains, and nested groups. Round material elements declare both inner
and outer diameters; a web declares width and height. Null values remain unknown.
Material/color/source tables retain elements whose geometry is unavailable.

`packages/section-layout` keeps one section projection for dimensions, color
tables, numbered drawing callouts, SVG export and straight stock geometry. The
axonometric preview compresses axial length for display; its exported pieces
retain the selected length. Display color fallbacks do not become material facts,
and section placement creates no electrical bonds. Complete geometry is not
clearance, manufacturing or physical qualification.

Original synthetic coax, pair, ribbon and figure-eight fixtures exercise these
contracts. The coax's four layers and 3 mm overall diameter remain independently
anchored to `tests/fixtures/stock-section.json`. Geometry reuse retains TypeScript
and attribution; no upstream catalog, private design or font is bundled.

## Layered preparation preview

The stock panel can open a lazy interactive 3D view using `packages/wire-geometry`.
Its explicitly named local display profile controls per-element cuts at ends A and B,
hidden elements and occluded interior suppression. Screen and drain leads have distinct
identities and explicit illustrative diameter, axial/radial reach and direction. They
never imply an electrical bond, conserved braid area, finished lead length or physical
preparation qualification. Unknown dimensions and invalid/overlapping cuts are reported;
no missing geometry is filled with guessed engineering values.

Profile edits do not alter saved stock, source facts, section/SVG export or the straight
preview. Local preview state is not a persistent versioned workshop practice record.
A full construction table remains available even for explicitly hidden elements. The
3D renderer preserves annular caps/bore walls, has bounded per-piece tessellation,
renders on events, and disposes resources on close. A failed WebGL context leaves the
section and dimensions available.

## Versioned workshop practices

The Workshop profiles workspace creates, edits and freezes a separate
`workshop_profile` definition through `workshop_profile.create`, `.update` and
`.freeze`. Each profile selects an exact stock revision and valid stable element
paths; freezing retains that construction pin without changing the stock. Foil
visibility, illustration lay length, per-end cut suggestions and lead depiction
carry independent unknown, documented, inferred or preference bases. A practice
value never becomes a measured dimension, rating, electrical bond or qualification.

Documented practices cite a source. Registered source references retain their exact
bundle revision, path, digest and rights, checked against the preserved file. Free
text citations remain unverified. Reads, conflicts and retries recheck current
access to both construction and original profile evidence. Later draft edits do
not rewrite earlier profile revisions or their source declarations.
