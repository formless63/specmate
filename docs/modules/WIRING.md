# Wiring, interfaces and preparation

## Ownership

Stock construction, preparation profile, finished topology and display arrangement are
separate records. Preserve element IDs for conductors, layers, screens and drains. A
reviewed bond belongs to electrical topology, not a geometric gathering operation.
One body can carry different logical pinouts; viewing side/orientation is explicit.

## Workspace scope

Stock, interfaces, cables, harnesses, assemblies, passive models, option sets and
configurations, workshop/preparation/end-preparation profiles and BOM, material and
cable test plans are workspace collection items. Typed `*.create` commands take an
optional `workspace_id` (the actor's only workspace when omitted) and never a project;
creating requires `item.create`. Projects reference these items afterwards. Every
exact pin in typed content (and every revision a read combines, such as a profile
applied to a cable or a document binding) must belong to the same workspace. A
revision from another workspace, a missing revision and a revision the actor cannot
read all produce the same `Not found.` response before any graph, mapping or
semantic diagnostic, and before a database guard could reject the write. Membership
in the root's workspace covers the exact closure; typed validation and source
evidence checks still run for every pinned record.

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
Stock queries do not require connectors, devices, PCB sources or topology.

Stable local element IDs form hierarchical paths. Groups declare concentric,
ring, linear or figure-eight arrangements. Explicit pitches and offsets locate
conductors, drains, and nested groups. Round material elements declare both inner
and outer diameters; a web declares width and height. Null values remain unknown,
including a null offset, which leaves that element's position unknown.
Material/color/source tables retain elements whose geometry is unavailable.

Placement has one definition: a node sits at its parent's position plus its own
offset, and members (conductors and nested groups) of a ring, linear or figure-eight
group also take the displacement from the group's pitch (rings start at 12 o'clock
in the stated direction; linear rows are centred). An offset on an arranged member
adds to that displacement. `specmate/wire_stock/geometry.py` and
`packages/section-layout/src/placement.ts` implement it and are both tested against
`tests/fixtures/wire-stock-placement.json`.

Fit findings compare placed outer circles with the bores of enclosing layers (a
tube in the same or an ancestor group) and with sibling elements, within 0.001 mm:
`containment` (extends beyond a bore), `wall_overlap`, `outside` (beyond a group's
outer layer) and `overlap` (siblings), plus an `offset_on_arranged` note. Webs are
not compared with the legs they join. A check with an unknown dimension or position
is `not_evaluated`, never a pass. Stock records carry the report as `geometry`.
Failing findings do not block saving; `wire_stock.freeze` refuses them unless the
request sets `acknowledge_geometry_findings`. Findings describe declared geometry
only, not clearance, manufacturing or physical qualification.

The stock panel's construction builder starts from templates (coax, multi-core
round, twisted pairs, ribbon, figure-eight). The user enters real dimensions
(conductor diameter, AWG or area; insulation, screen, drain and jacket values) and
colours; the builder computes the centred lay-up, ring diameter, drain interstice and
screen/jacket bores and writes the ordinary version 1 tree, so nothing new is stored.
A saved stock reopens in the builder only when its read-back regenerates the stored
tree exactly; otherwise the element editor remains, with offsets under "Advanced
placement". An incomplete construction is drawn with labelled placeholder
proportions; the stored values stay unknown.

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

## Cable views: appearance, end faces, 3D and information

`packages/section-layout/src/appearance.ts` is the one colour and material model for
every cable view. A recorded `#rgb`/`#rrggbb` colour is drawn as recorded; a few
conventional names and a `base/stripe` tracer form are accepted and labelled as
conventional. Free-text materials are classified (copper and plated coppers, aluminium
and foil, PVC, polyethylene and foam, fluoropolymers, silicone, polyurethane, elastomers,
film, paper, textile) into a finish (metallic, foil, gloss, satin, matt, foam, fibre) and a
surface texture (strands, braid, spiral, tape, foil, foam, fibre). Bare metals with no
recorded colour use the typical colour of that metal and say so. An unrecorded polymer
colour, or an unrecorded or unrecognized material, is drawn neutral with a hatch and is
listed as unknown; nothing is guessed. Selection on an engineering view is a reticle, never a fill.

`end-face.ts` shows one cut end looking into it. The section is drawn as seen from its
recorded `viewed_from` end; the other end is that drawing mirrored about the vertical axis,
so each ring reads the opposite way round. Rotation is a viewing input. Every conducting
element has a terminal marker. A stock whose viewed-from end is unknown has no end face.
Each cable end records which stock end it uses (`a`, `b` or `unknown`); an unknown stock
end is never guessed, so the inspector lists every end's termination for each element.

The wire viewer builds physically based materials from the same model with generated
(code-only) surface textures, uses an image-based light when WebGL allows it, writes a
plain-text description of what it draws, recovers from a restored WebGL context and
renders only on events. The information view is a datasheet-style table of layers in their
drawn colours with recorded facts. Views are mounted in the stock panel, the frozen stock
viewer and the frozen cable inspection; none of them evaluates continuity, fit, bonding
or physical qualification.

The frozen harness inspector also mounts `packages/harness-views`. The formboard draws
each physical section as a bar at one length scale in its jacket's recorded colour,
joined at breakouts. A section without a planned cut length is drawn dashed at a
placeholder length and labelled unknown; legs that share their trunk's section are
dashed stubs with no length. Placement implies no routing, bonding or fit. The build
sheet derives a deterministic, self-contained, escaped HTML document with a page per
stage (kit and cut with exact decimal totals, one page per endpoint listing declared
terminations in contact order, assembly, test). Stages with no recorded data say so;
no workshop procedure or soldering order is assumed.

The same inspector offers full-scale and scaled print output of the formboard and fixed-size
labels (PRE-005), derived from the frozen record and stored nowhere by the browser. Coherent
export packages carry a server-generated 1:1 formboard print of the same exact harness
(a tested Python port of the renderer; see export-packages.md). Only the length axis is to
scale, and only for sections with a recorded planned cut length; thickness, row spacing and
text are fixed-size drawing aids, and unknown-length sections stay dashed placeholders. A plan
states "1:1" only when the effective scale is exactly 1 and at least one length is recorded;
fit-to-page and ratio plans state their true reduced ratio and say they are not full size.
Pages have explicit paper, orientation, margin (warning below 5 mm) and tile overlap, name
their row/column and overlapping neighbours, carry registration marks, and are limited to 64
pages. Every page prints a 100 mm ruler. The user may enter the length measured on a first
print; the plan then pre-compensates and every page states the factor (an implausible
measurement is an error and is never silently ignored; without one the plan says it is
uncalibrated, and the entered value is kept only in the viewer's browser). Labels (one per
section and per recorded physical end) are drawn at the declared width and height with
text fitted by shrinking and wrapping; a label whose text cannot fit is reported and not
drawn, never truncated. Output is a deterministic, self-contained HTML document with exact
`@page` size. Physical printer accuracy is not qualified by this software.

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
visibility, illustration lay length and direction, per-end cut suggestions and lead depiction
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
or electrical bond. Prepend cuts remain inspectable but unsupported: the renderer does
not assign an undocumented manufacturing meaning to that suggestion.

Round pair/bundle illustrations can apply an explicit positive lay period together with
an independent `positive`/`negative` direction practice. Positive is right-hand rotation
about display +x as x increases, with phase zero at end A. Stock group ring ordering is
not a twist direction. The projection uses a single global display-axis rotation and
retains material paths, cut spans, annular caps and separate lead anchors. It does not
model nested engineering lays or transform ribbon, figure-eight or web constructions.
Unknown construction, period or direction, invalid settings and exceeded tessellation
budgets retain the straight depiction with a visible reason. Existing frozen profiles
with no direction remain unknown. The budget is 24 segments per turn, at most 256 per
piece and 16,384 total; excessive requests are refused rather than undersampled. These
illustrations establish no physical wire length, BOM quantity, clearance or qualification.

## Two-end cable assignments

A `cable` definition composes one exact `wire_stock` revision and two stable local
endpoint IDs (content schema 0.2). Each end is an **end stack**, pinned from an exact
`end_assembly` revision or declared ad hoc, and records the stock end it uses. Declared
terminations identify the endpoint, full stock element path, a layer and a terminal of
that layer, and the declaration basis. Conductors, shields and drains retain separate
identities at both ends. A stock feature may be terminated once per endpoint; several
features may land on one terminal (for example screens on one ground pad). Keying features, insulation
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

## End stacks and end assemblies

An end stack is ordered from the wire outward and has at most one layer of each kind:

- **board**: an exact `board` revision (labelled pads and declared paths). When the layer
  names one of the board's carried connectors, that carried connector must be the stack's
  exact connector body, and the board's *reviewed* pad/contact correspondence joins the
  pads to the connector layer. An unreviewed correspondence reads `unknown`.
- **inline**: hand-soldered parts (for example a series or blanking resistor), each with
  the shared `InlineComponent` description and two leads, `<part>.1` and `<part>.2`.
- **connector**: an exact connector body revision and its chosen pinout variant; the
  pinout must pin that exact body revision. Contacts show the variant's typed signals.
- **shell**: an optional exact part revision. It is mechanical: its single terminal,
  `body`, joins nothing unless a `bond` join or a termination names it.

Every other connection is an explicit join (`solder`, `crimp`, `mated`, `integrated` or
`bond`) between terminals of two layers, with a basis; nothing is joined by label. A
reusable `end_assembly` (an interface kind, edited in the Library's End assemblies lens)
holds one stack and a review; cable ends pin its exact revision.

`end_assembly.resolve` (and `POST /api/v0/interfaces/end-stacks/resolve`) returns a
stack's layers, labelled terminals and joins. For pads and inline leads it lists the
connector contacts each is declared to reach, naming every step (board path summary,
landing, join) and the contact's typed signal; a step through an unreviewed landing or
an unknown/switch path makes the reach `unknown`. Reaches are declared topology, never
continuity. The copper graph projects the stack: declared joins, straight board copper
and reviewed landings join copper; component and switch paths and inline parts stay
`not_evaluated` boundaries; unreviewed landings are `unknown` boundaries.

Schema 0.1 content (one connector per end, terminations to contacts) remains readable:
it is read as a one-layer connector stack named `connector`, stock end `unknown`, with
each termination on that layer's contact. Frozen 0.1 bytes are never rewritten; the
`cables` migration upgrades editable drafts only, and inspection reports the stored
schema version. Connector-only consumers (test intent terminals, end preparation,
documents, exports) read the connector layer; terminations on a board pad or inline lead
carry no `contact_id` and those consumers report them by layer and terminal label.

## Branched harnesses and explicit relationships

The separate `harness` kind preserves the two-end `cable` contract. A physical
section identifies one planned retained stock piece pinned to an exact stock
revision. Segments name spans or conductive feature subsets of those sections;
several segments referencing one section do not create additional stock pieces.
The quantity projection expands every explicit physical section once per requested
harness and reports segment counts separately. Counts represent planned material;
actual units and stock issuance are recorded separately. Planned stock cuts require a basis;
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

## Copper graph inspection

`copper.graph` projects one exact revision and its assembly occurrences into bounded
terminal components. Terminal IDs include the root revision, occurrence path, exact
owning revision and typed feature identity. Repeated placements never share copper
merely because their child revision, label or reported net name is the same.

Declared wire edges follow each selected conductive feature between the ends of a
cable or one harness segment. Only explicit terminations, splices, shield bonds and
one-to-one uncut breakout mappings join those spans. Shared physical sections and
stock groups create no additional links. Unknown breakout fates remain explicit;
keying features are excluded from electrical terminals.

Native PCB pad membership groups retain occurrence-scoped native net identities and
are labelled `reported_net_membership`, separately from `declared_copper` evidence.
They do not prove routed copper continuity. Resistor passages remain boundaries, so
resistors between two native nets leave two components. Unspecified interface
passages, assembly electrical/mating relationships, PCB port associations and
unmodelled component behavior also remain boundaries with exact provenance. Even an
accepted association does not assert electrical same-contact identity.

The read-only operation and `/api/v0/copper/revisions/{revision_id}` recheck the full
current owning source closure before projection or selection diagnostics. The operation
can restrict display to an exact occurrence subtree and select a terminal's component;
a restriction does not bypass authorization of the complete root. Projection is bounded
by 2,000 captured snapshots, 20,000 terminals and 40,000 relationship/boundary records;
exceeding a bound produces an error instead of a partial connectivity conclusion.
Deterministic IDs describe the frozen graph and never update its source records.
Continuity, compatibility and physical qualification remain `not_evaluated`. Passive,
conditional and active path interpretation are separate capabilities.

`CopperPanel(projectId)` selects exact frozen revisions and a contextual terminal.
Its inspector lists the terminal's declared component, connection evidence, native
net identities and non-merging boundaries with source provenance. Long terminal,
connection and boundary lists paginate independently. Denied definition, revision
identity or graph refreshes remove retained private results and source-derived choices.
The explicit graph access refresh clears displayed evidence during the request and
rechecks the same frozen revision; reselecting an already selected ID is not a refresh.

## Exact path explanations

The reviewed passive-model query view explains one bounded candidate path at a time.
It exposes every step record identity, traversal, basis and evidence; exact terminal
IDs resolve to occurrence paths, owning revisions and typed feature fields only when
both the query root revision and snapshot hash match the inspected graph. Missing or
mismatched graph metadata stays unavailable. Supplied query provenance is displayed
without substituting metadata from another graph or joining repeated labels.

Copper steps retain physical section and stock/body/pinout pins, native net identities,
interpretation/source revisions and hashes. Independent component assertions retain
the frozen model revision/hash, review identity and exact registered evidence path,
hash and rights, or explicitly unknown/unverified evidence. The shared copper
provenance display also exposes these identities in ordinary copper inspection.

Query semantics, ideal copper/component assumptions, declared parameters, frequency,
condition assignments, required exclusive states and contradictory requirements remain
visible beside the result. Series impedance is a derived model approximation; series
resistance is neither measured nor a parallel-network equivalent. Source boundaries
remain visible independently of reviewed assertions. Steps and boundaries paginate in
batches of 20; path selection does not silently truncate the query's candidate count.
Search-limited results remain incomplete and unknown. Unsupported active behavior,
physical continuity, signal transfer, compatibility and physical qualification are not
established by path reachability or review acceptance. No returned path does not prove
physical disconnection.

An original synthetic harness-to-PCB test uses exact assembly occurrences, authored
wire/termination/breakout relations and reported PCB membership. A separate reviewed
ideal bridge is required between the harness and board; no mating or association is
inferred. Independent resistor and unsupported-active assertions preserve the native
candidate boundary and its source provenance. These fixtures exercise shared
operations against PostgreSQL; they do not execute or qualify a native tool.

## Independent cable length declarations

A cable's optional length plan stores independent route, finished, planned stock-cut
and conductive-feature cut declarations in exact millimetres. Every known value
requires a human declaration and explanation; blank values remain unknown. Conductor
cuts retain the cable's exact stock revision, conductive kind and full stable element
path. A cut for a shield or drain is distinct from a core cut. These planned lengths
never update stock construction, stock ledger quantities, workshop profiles or saved
preparation geometry. Harness section cuts remain separately owned declarations.

An optional explicit model relates finished length to route, stock cut to route or
finished length, and individual conductive cuts to route, finished or stock cut.
Reviewed models add declared slack/preparation allowances and subtract explicit trim
allowances. Each allowance identifies its whole-target or exact endpoint scope and
basis. Null is unknown; zero is a deliberate zero allowance. Empty allowance lists
explicitly add zero. Unreviewed relationships are inspectable but produce no suggestion.
A modeled source uses its model result, so unknown inputs propagate through downstream
models even when an independent saved declaration exists. Suggestions and declaration
mismatches are visible; applying a suggestion requires a deliberate draft edit.

Existing cable create/update/snapshot/freeze commands preserve the plan under the same
state token, permissions, source closure and immutable history as terminations. The
structured cable editor records declarations and reviewed models; frozen inspection
shows their independent values and bases. `cable.length_impact` and the cable HTTP
length-impact query compare two exact revisions of one definition, including hashes,
changed declarations/model suggestions and preparation/document review requirements.
A route change requires review even without a model. Comparison performs no stock or
cut-declaration writes. Current source access is rechecked before both revisions are
shown, and denied browser refreshes hide retained results. A mutation authority
denial also gates retained editors and frozen results while affected reads are
rechecked. Unsaved text and its original editing token survive that gate; a newer
server read does not silently adopt a new token for the unsaved edit. Stock-pin
changes are reported separately from changes to the actual route declaration.
The comparison also lists every changed document-affecting section: lengths, pinned
stock, endpoint connector body/pinout, conductor-to-contact terminations, endpoint
labels and declared review. Each section names whether preparation and/or documents
need review; a label or review-only change affects documents only. Content that
differs outside the known sections is reported as uncomparable and requires both
reviews, so an unknown difference never reports "no review required".

This length model is an explicitly reviewed arithmetic relationship, not a geometric
routing solver or a measurement. It does not derive physical conductor length from a
helical illustration, infer longest-leg cuts, interpret prepend/profile semantics,
produce manufacturing documents, or establish clearance or physical qualification.

## Reviewed preparation profiles and exact cut arithmetic

The separate [preparation material accounting](../PREPARATION-MATERIALS.md) build
sheet keeps installed material, selected cuts, waste, consumables and procurement
distinct, with explicit observations against existing Inventory events.

A `preparation_profile` is a separate versioned engineering definition. It pins one
exact stock revision and stores structured formulas for the whole physical stock
piece or an exact conductive feature path. Illustrative `workshop_profile` cutbacks,
leads, overlaps and prepend practices do not become arithmetic rules implicitly.
Each formula explicitly selects route, finished, stock-cut or conductive-cut input,
and selects either its independent declaration or its reviewed model suggestion.
An unavailable selected input stays unknown; another declaration is never substituted.

Reviewed formulas add slack and preparation allowances and subtract trim. Every
allowance retains a whole-piece or profile-end A/B scope, a basis, and optional
registered source-file evidence or an explicitly unverified citation. Profile end
scopes do not infer connector endpoint associations. Unknown allowances are nullable;
zero and an empty allowance list are explicit zero additions. Unreviewed formulas
remain inspectable but produce no numeric suggestion. Exact decimal arithmetic rejects
nonpositive cuts, overflow and results outside the shared quantity bounds. For example,
a declared 1000 mm input plus reviewed 20, 10 and 5 mm allowances produces 1035 mm;
two requested units produce 2070 mm. Unknown quantity retains a known per-piece cut
while leaving the total unknown.

`preparation.create`, `preparation.update` and `preparation.freeze` use the shared
operation layer, editing tokens, idempotency and immutable snapshot dependencies.
Generic definition paths enforce the same typed content and source closure. Registered
source evidence checks exact file paths, hashes and rights, including current access
to derived-source and archive-original ancestors. Reads refresh the actor's active
account state. Replays reauthorize retained and supplied evidence before returning
results or payload-mismatch diagnostics.

The read-only `preparation.compute` operation and `/v0/preparation/compute` HTTP query
apply exact profile revisions to an exact cable or harness revision. A cable is one
physical piece. Harness applications identify exact retained physical section IDs;
multiple segments through a shared section do not multiply its stock quantity.
Harness sections currently provide their declared planned stock-cut input; unavailable
route, finished and conductive inputs remain unknown. Every application must match
its section's exact stock revision. All supplied profiles and source ancestry are
authorized before selection or arithmetic diagnostics. Results retain subject,
profile and stock revision/hash provenance, the complete formula, selected input
basis and independent saved cut; mismatches remain visible and no suggestion is
applied to saved lengths, stock facts, inventory or workshop geometry. Stock-piece
and conductive-feature totals are distinct. Unprofiled sections are reported.

The Cut preparation panel supports structured profile authoring, explicit draft load,
save/freeze, immutable history inspection and reviewed application queries. Failed
access refreshes hide retained provenance and results. Mutation authority denial
hides the editor until a successful authority refresh; unsaved values and their
original concurrency token survive recovery. A cut-query authority denial also hides
retained editor and frozen evidence until the exact supplied subject and profile
revisions pass current authorization. Late save responses advance the accepted
editing token while preserving edits made after submission; replacing or loading
an editor fences pending responses from the prior selection. Freezing captures the saved draft,
so unsaved edits remain distinct from the displayed frozen profile. Geometric route
solving, helical-length derivation, prepend semantics, manufacturing document
production, clearance and physical qualification remain unsupported or unevaluated.

## Reviewed per-end stripping and shielding intent

An `end_preparation_profile` is an independent engineering definition with an exact
stock revision pin. Its ends A and B each retain their own review decision, review
basis and typed instructions. Layer-strip instructions identify exact jacket,
dielectric, insulation, shield, filler or web paths. Drain treatments and shield-lead
instructions identify their own drain or shield paths. Repeated local labels never
substitute for full hierarchical feature paths. Omitted instructions stay unknown;
workshop display rules, source-only drain practices and illustrative lead defaults
never fill them.

Each dimensional instruction retains exact nullable nominal millimetres, lower and
upper tolerance magnitudes, an explicit datum and a basis. Dimensions measured from
the stock cut end are distinct from length along a finished lead. Zero must be
entered deliberately; missing size or tolerance remains unresolved. Known dimensions
require a datum and basis, floating-point inputs are rejected, and lower tolerance
cannot extend below zero. These values describe reviewed intent, not measurements.
A dimensional instruction with missing size or tolerance remains incomplete even
when the end has been reviewed. Unreviewed ends or mappings remain visibly unreviewed.

A bond expectation identifies a shield or drain and either isolation, an unknown
expectation, or an intended bond. Bond targets identify another exact conductive
stock feature or an exact connector-body revision and physical contact/shell ID.
Keys cannot be bond targets. A bond with no specified target remains unresolved.
The profile does not create a joint, assert actual bonding, modify the copper graph,
or establish continuity. Contact targets add immutable body dependencies alongside
the stock pin. Current source-file authority includes derived/archive-original
ancestry; file paths, hashes and rights are checked after the complete supplied
closure. Inline citations remain unverified references.

`end_preparation.create`, `.update` and `.freeze` use the shared operation layer,
optimistic tokens, retained replay authorization and immutable snapshot dependencies.
Generic definition paths enforce the same profile rules and pins. Reads reload the
actor's current active-account state. `end_preparation.apply` and the read-only
`/v0/end-preparation/apply` query require exact profile and cable revisions plus an
explicit reviewed mapping of A/B to two distinct stable cable endpoint IDs. Labels,
list order and screen orientation do not choose that mapping. The output preserves
exact cable/profile/stock hashes, body and pinout identities and their declared
orientations; it does not invent rotations or a viewing side. Contact expectations
must match the mapped endpoint's exact body revision. Both complete source closures
are authorized before endpoint or feature diagnostics.

Application returns separate instructions and missing-rule lists for both ends,
including their explicit dimensions, tolerances, source and review basis. It leaves
stock construction, cable assignments, saved cuts, inventory and topology untouched.
Physical preparation, actual bonds, measured outcomes and qualification are not
evaluated.

Harness sections may additionally declare `physical_ends`: section-scoped stable IDs,
optional labels, explicit same-section segment-end references, an optional exact
Harness endpoint association, a basis and a review decision. These are retained in
normal Harness drafts and frozen revisions. A segment end cannot identify two physical
ends of the same section. Endpoint association only supplies a body/pinout context;
it creates no electrical connection, joint or bond. Neither repeated labels, displayed
segment A/B directions, breakout fates nor shared-section segment counts establish a
physical end. Existing Harness revisions without declarations keep their unknown ends.

`end_preparation.apply_harness` and `/v0/end-preparation/apply-harness` accept an exact
Harness revision, section ID, profile revision and deliberate profile A/B mappings to
physical end IDs. The additive request has `schema_version: "0.1"`; the Cable request
is unchanged. Both complete frozen closures precede mapping or feature diagnostics.
The selected section must pin the profile's exact stock revision and counts once.
Output retains Harness/profile/stock hashes, the physical declarations and associated
body/pinout orientation when present. Contact-bond expectations without an explicit
endpoint association remain incomplete; incompatible exact body pins are rejected.
An unreviewed physical declaration keeps instruction intent unreviewed.

Sections can retain up to 64 physical end declarations. A two-end profile cannot cover
a section with zero, one or more than two declared ends: the application returns an
unresolved explanation and no fabricated assignments. Missing mapping choices also
remain unresolved. This limit belongs to the current two-end profile projection, not
to Harness topology or accepted generalized preparation scope.

The Harness editor authors these declarations structurally and frozen inspection
shows them separately from electrical relationships. The per-end preparation panel
lists exact Harness sections and declared end IDs from current authorized inspection.
Denials hide retained preparation evidence across the panel; restoration preserves
unsaved mapping fields. Harness draft reads do not replace unsaved declarations or
their original compare-and-set token, and accepted saves advance only their own token.
A frozen-inspector authority denial gates the retained draft as well, including a late
response after revision or quantity browsing. Restoring access freshly checks the
selected and denied frozen revisions, identity, project, saved draft and retained
unsaved references; a newer server draft never supplies a replacement editing token.
Actual draft or project replacement fences requests belonging to the previous editor.
All applications remain read-only; material issuance, measured cuts, actual bonds and
physical qualification are separate records and checks.

## Separate interface assessment dimensions

An `interface_assessment` definition uses the existing `interface.create`, `.update`,
`.snapshot`, `.freeze` and `.read` commands. It pins two exact logical pinout revisions
and their bodies. Each proposed contact row retains its stable ID, left/right contact
IDs, expected signal identity, basis and optional evidence. A missing contact, key,
repeated contact or contradictory declared signal produces an invalid correspondence
finding; the original proposal remains inspectable. Invalid findings can be frozen:
a recorded assessment is useful evidence of an unresolved problem, not approval.

Eight dimensions remain separate: mating, pin correspondence, levels, current,
protocol, shielding, grounding and fit. Mating and fit are explicit declarations
with a basis; neither is inferred from matching family names, opposite mating roles,
scene geometry or a reviewed catalog identity match. They establish no measured fit,
clearance, physical assembly success or qualification.

For each valid proposed contact row, an explicit operating voltage envelope can be
compared with both retained voltage limits, and an explicit current demand with both
retained contact maxima. A current rating never supplies an assumed demand. Missing
ratings and operating inputs remain unknown, including when demand is explicitly zero.
A retained conditional rating is used only when its condition is explicitly selected.
These comparisons do not evaluate driver/receiver signal thresholds, supply capacity,
derating, heating or transfer. Required protocol text is compared with both retained
protocol declarations; equal names do not prove timing, negotiation or interoperability.

Shielding and grounding each retain separate exact contact selections and required
versus declared bond/isolation intent. Known contrary electrical roles and contradictory
intents produce invalid findings; absent role or intent remains unknown. A shield or
shell selection is distinct from a return/chassis selection. These checks create no
copper connection and establish no bond impedance, protective earth or safety approval.
An invalid correspondence prevents electrical comparisons for that row while preserving
unrelated row findings and independent mating/fit declarations. Omitted contacts remain
outside the explicitly named row scope. No overall compatibility boolean is produced.

Evidence reuses reviewed matching's unknown, unverified citation and exact registered-file
contract. Registered evidence discloses retained file hash and rights only after current
source access is checked. Reads, retries and conflicts recheck the actor, both full
subject closures, retained catalog origins and exact receipt evidence; a later draft
cannot erase a historical receipt's authority obligations. Frozen bytes and pins remain
unchanged by later editing or authority recovery.

`InterfaceAssessmentPanel(projectId, principalKey, canEdit, canFreeze)` is a reusable
workspace for structured authoring, tokened edits, deliberate freezing and eight separate
result cards. Current-authority refresh hides cached results and disables mutations while
reads are pending or denied. Prepared edits keep their original token across fresh reads;
changing the editing basis is deliberate. Project/principal changes clear editor state.


## Declared orientation, polarity and conditional ratings

Connector contacts retain a stable `contact_id`, an independently declared nullable
number and label. Repeated numbers and labels are permitted; neither forms physical
or copper identity. Contact coordinates belong to the body's exact drawing revision.
Frozen pinout inspection projects them into an explicitly selected mating or termination
view without sorting, renumbering or changing assignments. The declared drawing convention
places the origin at a shared named datum, x right and y down. It removes the source
rotation, reflects x across the vertical datum axis when changing viewing side, then
applies the selected screen-counterclockwise rotation. Unknown rotations/datums, distinct
datums and absent coordinates remain visibly unresolved. This transform does not assert
actual mating correspondence or measured physical geometry.

Electrical declarations retain independent positive, negative, reference, nonpolarized
or unknown polarity and an explicit declaration basis. A separate polarity finding
compares only the proposed contact row; drawing mirroring never changes its polarity.
A nonpolarized or reference contact paired with a positive or negative contact is
`flagged`: a named, review-level finding with its reason that is allowed and never
blocks freezing or any other dimension. Other differing explicit polarities (for example
positive against negative, or nonpolarized against reference) remain `invalid`. It creates no bond, driver/receiver behavior, safety approval or overall compatibility.

Conditional voltage envelopes and current maxima identify stable local rating IDs,
explicit inclusive Celsius temperature envelopes and/or exact named operating modes,
a declaration basis and unknown, unverified or exact registered evidence. Registered
rating evidence retains the exact source-bundle revision, file hash and rights; current
source and historic catalog authority are checked before relationship diagnostics and
receipt replay. Pinout freezing and generic design capture retain these declarations
without editing their evidence or any prior revision.

Assessment operating temperatures are explicit inclusive envelopes, separate from ratings.
Every scope predicate must be supplied and satisfied before its rating applies. Missing
conditions remain unknown. A temperature scope that only partly overlaps the operating
envelope leaves that rating dimension unknown ("Rating scope covers only part of the
operating envelope"), even when an unconditional legacy limit exists; a fully contained
scope applies, and a fully disjoint temperature scope or mismatched mode is out of scope.
Fully applicable declarations intersect their voltage envelopes
and constrain current by the lowest maximum. A missing conditional condition prevents
an unconditional declaration from silently resolving that dimension. A definitely
out-of-scope rating contributes no limit and remains visible alongside any independently
applicable declaration. Conditional-only dimensions with no applicable rating remain
unknown. No extrapolation, interpolation, measured derating curve or thermal qualification
is inferred. Findings expose the exact declarations, operating assumptions, scope reasons,
effective limits and source evidence independently of mating, correspondence and fit.

## Signal sets, typed pin signals and named pinout variants

A `signal_set` interface definition is a shared vocabulary of what travels through a
contact (INT-001, LIB-001): each signal has a stable key, a display name unique within
the set, a type (analog video, sync, analog or digital audio, power, ground/return,
screen, chassis, data, control, other or unknown), an optional return relation (a
ground, screen or chassis signal names the signals it is the return of) and optional
differential partner. Level and impedance are declarations with a basis; an absent value
is explicitly unknown, never zero. Signal identity is the exact set revision plus key:
equal names in two sets are different signals, and nothing substitutes one for another.

A pinout is a named variant of its pinned body. It carries a variant label, the
application role (source, sink, bidirectional or unknown) and an optional standard name;
per-contact expectations live on the variant, not on the body or a device. A contact's
electrical contract may pin a typed `signal_ref`; the free-text `signal` remains a
display note. The contact role must be able to carry the signal type (a return on a
power role, or any signal on an unused contact, is rejected; an unknown role accepts any
type). Pins may depend on a declared named condition with choices: such a contact lists
one meaning per choice and has no unconditional typed signal, so it reads as
`conditional` (its signal unknown) until a later consumer selects a choice. Frozen body
inspection lists every frozen pinout variant of any revision of that body by name, role
and standard, marking which pin the current body revision; frozen pinout inspection
resolves each typed signal's name, type and exact set. Listing variants together never
claims they are electrically interchangeable; compatibility stays `not_evaluated`.

## Device ports and declared mating

A `port` is a device socket or plug as the outside world sees it, one record per pinout
variant (no inheritance between device variants). It pins the exact variant, states the
device label and role (which must not contradict the variant's role), selects choices for
the variant's named conditions, and adds per-contact device facts: drives/accepts/passes,
level and impedance declarations with a basis, AC/DC coupling, termination, parts the
cable must add (series resistor, series capacitor, shunt resistor, attenuator, other) and
must-not-connect with its reason. Facts a port does not state stay unknown.

A cable end can be given either as a device port or directly as a pinout variant. The
read-only end query (`GET interfaces/revisions/{id}/end`) returns one row per physical
contact for either: the variant's typed signal resolved under the selected conditions and
the device facts, or no device facts for a bare variant. A contact whose condition is not
selected is `unknown` with the reason and every alternative, and is flagged
`may_be_power` when any alternative is power. Compatibility stays `not_evaluated`.

A connector body may declare `mates_with` partners: an exact partner body revision, a
same-ID or explicit contact correspondence, and a review state with its basis. Declared
plug/receptacle roles must be able to mate, and the correspondence must name contacts on
both bodies. Mating is never inferred from family names or labels. Body inspection lists
the declared partners with their contact pairs and, in reverse, the bodies that declare
mating with it; an unreviewed declaration reads `unknown`, never established.

## Conductor conventions

A `conductor_convention` records what a shop usually uses each conductor for (CAB-006). It
is a preference: it ranks proposals and flags a later deviation, and it can never make a
check pass. A conductor it does not mention stays unknown, never "spare".

A **stock convention** pins one exact wire stock revision and one exact signal set
revision, and maps stock elements (conductors, screens and drains, by dot path) to a use:
a signal of the set, a signal type only, "return of" a signal, spare, or do not use. An
element maps once, the path must exist as a conductor, screen or drain in the pinned
revision, signal keys must exist in the pinned set, and a return is the return of a
signal rather than of another return. A **colour code** pins no stock; a rule names a
colour, optionally its exact display colour and element kind. A colour code applies to a
stock only where an element's display colour equals a rule's exact colour; wire labels
never establish a meaning.

Frozen convention inspection returns rows by element label and signal name, and lists
unmapped stock elements as unknown. `GET interfaces/stock-revisions/{id}/conventions`
lists the frozen conventions that apply to one frozen stock revision: exact-pin
conventions with their rows first, conventions pinned to another revision of the same
stock without rows, and colour codes with their matching elements.

## Cable intent

A `cable_intent` (an interface kind, Library lens "Intents") states what a cable must
connect between two ends. Each end is an exact device `port` revision or a bare `pinout`
variant revision. Rows name a from-contact, the to-contacts it must reach, the signal
carried, a requirement (`required`, `optional`, `must_not_connect`), a return policy, a
conductor requirement, parts the cable must add, and the intent records an isolation and
a shield policy. Rows are requirements, never evidence.

`cable_intent.propose` (and `GET /api/v0/interfaces/intents/propose`) proposes rows
deterministically and stores nothing:

- pins are paired only by exact signal identity (signal set revision and key);
- a signal declared on several destination contacts, a look-alike that matches only by
  name and type from another signal set, and a pin whose meaning depends on an
  unselected condition each become an explicit **question** with the candidate
  contacts; a possible supply is called out in the question;
- a port pin marked must-not-connect, and a supply the destination declares no contact
  for, become `must_not_connect` rows; a signal with no counterpart is `optional` and
  `unpaired`, with its reason;
- a conductor kind and impedance are carried only from declared port pin impedances
  (coax for video and sync, pair for data); differing or absent facts stay unknown;
  coax rows return on their own screen; required parts come from `needs_in_cable`.

An intent with open questions can be saved as a draft but cannot be reviewed or frozen.
Inspection labels every row by contact number and signal name. A `cable` may pin one
exact intent revision (`intent_revision_id`); checking the cable against it and wiring
a cable from it are later steps and read `not_evaluated`.

## Checking a cable against its intent

`cable_intent.check` checks a cable draft or frozen revision against an exact
`cable_intent` revision (by default the one the cable pins). Each intent end is matched
to the cable end whose connector mates with it (declared `mates_with`, either body; an
intent end that is a pinout of the cable's own connector body needs no mating step).

Every row gets the declared path chain: port pin, mated cable contact, stack terminals
(board landing, pads, board paths, inline parts, joins), termination, conductor, and on
to the far contact and far port pin. Paths are the declared topology only. Each row
reports ten separate dimensions, each `pass`, `fail`, `unknown`, `not_evaluated` or
`flagged` with a reason and the evidence used:

- **connection**: every intended destination has a declared path; a path through an
  unreviewed landing or an unknown/switch board path is `unknown`. A must-not-connect
  row fails when its pin reaches any conductor.
- **signal match**: every reached far pin carries the row's signal identity.
- **conductor**: kind from the stock structure (coax/pair group), impedance from the
  stock's declared `impedance` fact; no fact is `unknown`.
- **level**: the driven level against the accepted level from port facts; unknown
  facts, differing units, or parts on the path are `unknown`; returns are not evaluated.
- **required parts**: passes only when a declared part of the right kind and value
  (board path component or inline part) is on the path.
- **return**: for a dedicated screen, the conductor's own screen lands at both ends on a
  pin whose signal is a return for this signal.
- **isolation**: the pin reaches no other far pin and no other pin at its own end.
- **shield**: evaluated for the whole cable against the intent's shield policy and the
  stock's overall shield or drain.
- **convention**: compares the conductor with exact stock conventions; it only flags and
  never changes an outcome.
- **mating**: reviewed mating passes; unreviewed is `unknown`; none fails.

A row's outcome is `fail` if any dimension fails, else `unknown` if any is unknown, else
`flagged` if any is flagged, else `pass`; optional rows that are not wired read
`not_evaluated`. Unknown is never pass. The path search is bounded (24 steps, 64 paths);
a row whose search reaches the bound reads connection `unknown` ("search limit reached").
A destination contact wired without an intent source reads connection `flagged`
("wired outside the intent"); if it joins another row's net, isolation fails.
`evidence.record_cable_intent_check` stores the check of exact frozen cable and intent
revisions as a recorded design result (`cable_intent_check` source) pinned to both and to
the cable's dependencies; newer revisions make it stale on read. It is not physical
qualification.
