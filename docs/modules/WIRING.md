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

## Frozen profile viewing

The frozen-stock viewer selects a definition and exact historical stock revision,
loads its canonical construction, and lists only frozen workshop profile revisions
pinned to that stock revision. Applying a profile is read-only and never substitutes
the current editable stock draft. Clearing the profile returns to a local illustration
of the same frozen construction. Profile suggestion sources remain inspectable.

The adapter retains nullable per-element cut values and omits unresolved lead geometry.
Explicit hidden groups hide their descendant material elements; global foil hiding uses
only declared foil construction and never changes dimensions or electrical topology.
Explicit hidden paths take precedence over global foil display. Unknown occlusion leaves
all interiors available with a notice. A group cutback applies to every descendant
material element. Overlapping group and element cutbacks retain the farther removal
from each tip; any applicable unknown cut leaves that material geometry unresolved.
Group lead suggestions do not identify a single conductive feature and create no lead
or electrical bond. Prepend cuts and illustration lay remain explicitly unsupported.

## Two-end cable assignments

A `cable` definition composes one exact `wire_stock` revision and two stable local
endpoint IDs. Each endpoint pins an exact connector body and logical pinout revision;
the body must be the exact revision selected by that pinout. Declared terminations
identify the endpoint, full stock element path, contact ID and declaration basis.
Conductors, shields and drains retain separate identities at both ends. A contact and
a stock feature may each be assigned once per endpoint. Keying features, insulation
and groups cannot be assigned as conductors. Shared screen appearance or pigtail
geometry never creates a bond. Branches, joints and multi-end topology remain separate
work under CAB-002; this two-end editor does not narrow that requirement.

`cable.create`, `.update`, `.snapshot`, `.freeze` and `.read` share the operation layer.
Generic design commands apply the same validation, exact dependency capture and current
owning-reference authorization, including deep source evidence. Reads, retries and
stale edits recheck that authority. Later catalog edits cannot rewrite frozen pins.
Review requires a declared basis but permits explicit unknown or unassigned terminals.
Ratings, roles and geometry remain those of the selected revisions; review does not
establish continuity, compatibility, preparation or physical qualification.

`CablePanel(projectId)` provides definition/revision selection, terminal assignment,
concurrency-aware editing and frozen inspection. The inspection aligns each stable
stock feature across both endpoints and shows pinned body/pinout roles and unknown
ratings. HTTP reads are under `/api/v0/cables`; mutation and agent adapters use the
same named operations. Existing stock section and geometry projections are unchanged.

## Branched harnesses and explicit relationships

The separate `harness` kind preserves the two-end `cable` contract. A physical
section identifies one original retained stock piece pinned to an exact stock
revision. Segments name spans or conductive feature subsets of those sections;
several segments referencing one section do not create additional stock pieces.
The quantity projection expands every explicit physical section once per requested
harness and reports segment counts separately. Planned stock cuts require a basis;
missing cuts or an unknown requested quantity propagate unknown totals. Route,
finished and conductor-cut lengths are not inferred, including from a longest leg.

Stable endpoint IDs pin exact body/pinout pairs. A joint declares a termination,
splice or shield bond with exact segment-end/element-path or endpoint-contact
members and a basis. A terminal belongs to at most one joint or breakout fate.
Shield bonds accept shield, drain and shell features only; keying contacts cannot
carry connections. Group placement, matching labels, shared sections, pigtails and
screen appearance create no electrical relationships.

A breakout identifies its trunk and leg ends. Every recorded fate identifies an
uncut trunk-to-leg correspondence, an existing joint, or an explicitly unconnected
terminal with a basis. Uncut correspondence requires the same section and conductive
feature and is one-to-one at each participating end. A joint fate references its
existing joint membership without adding another connection. Omitted fates remain
unknown. Creating a true conductor branch requires an explicit splice or bond;
repeating an uncut mapping cannot manufacture a branch.

`harness.create`, `.update`, `.snapshot`, `.freeze`, `.read` and
`.declared_relationships` share current authorization, concurrency and idempotency
policies with other engineering operations. The declaration inspection returns only
explicit relationships touching the selected terminal. It adds no longitudinal
copper edges and is not a full electrical trace. Continuity, compatibility and
physical qualification remain `not_evaluated`; electrical interpretation belongs to
the topology capability. Reads and captures check the full owning source closure,
and frozen revisions retain exact historical sections, endpoints and declarations.

Planned cut amounts use exact decimal strings (or exact integer inputs) and the
inventory quantity bounds for millimetres; floating-point inputs are rejected.
Positive length and representability checks follow complete source authorization.
Section totals and quantity multiplication use the bounded exact decimal context;
overflow or precision loss raises a validation error instead of rounding. The
original declared decimal amount and cut basis remain in the frozen harness.

`HarnessPanel(projectId)` edits exact sections, spans, endpoints, joints and breakout
fates through structured controls. Decimal cut text reaches the operation unchanged.
Frozen inspection separates material counts from spans and displays explicit terminal
relationships and unknown fates. Denied refreshes hide cached identity, draft and
source-derived records and disable dependent mutations. HTTP reads are under
`/api/v0/harnesses`; the shared operation API handles mutations.
