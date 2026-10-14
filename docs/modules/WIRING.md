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
Which stock end each cable endpoint is attached to is not part of the cable record, so
the cable inspector lists every endpoint's contact for each element instead of assigning ends.

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
