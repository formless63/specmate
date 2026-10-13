# PCB and firmware workflows

## Intake

Preserve original sources and report supported versions/types. Extract parts, pads, nets,
outline, mounting features, placements, population and candidate interfaces/models as a
versioned interpretation. Show schematic/PCB disagreement and lost semantics. Review
matching rather than silently promoting inferred connector ports to truth.

### Preserved intake and the initial native adapter

The implemented intake pins an immutable source-bundle revision and an optional
selected `.kicad_pcb` path. All registered originals, scripts and companion inputs
remain reconstructible through scoped downloads. Intake examines manifest metadata
only. It creates no build and does not parse or execute source contents.

`pcb.register_intake`, `pcb.request_extraction`, `pcb.accept_extraction` and `pcb.get`
use the shared command authority. Reads under `/api/v0/pcb` enforce current project
membership. A request requires `build.execute`, an idempotency key and an installed
operator-approved recipe with the exact adapter program, image, limits and outputs.
The existing build/outbox/lease/receipt engine performs execution. Source-registration
authority validates the accepted bounded JSON report after successful native execution.
The interpretation retains the exact intake, build, output and source hashes, and is
immutable. Accepting it never changes the native original or creates a reviewed port,
catalog match, manufacturing approval or physical qualification.

The initial pack supports KiCad **10.0.6**, board format **20260206**, **linux/amd64**.
It extracts native component/pad UUIDs, references/values/footprint identifiers,
basic pad/drill geometry, pad net memberships, absolute placements/rotation/side,
native DNP/BOM exclusion flags, closed line polygon outlines/cutouts and nonplated
pad-drill candidates. Hole roles require review. Arcs and other non-line outlines
remain explicitly unsupported. Copper membership never follows the separately
labelled, unreviewed resistor reference/value candidate passages.

Other KiCad versions, schematic parity, netlist/fabrication/BOM/placement-file parsing,
foreign CAD formats, native model extraction and manufacturing rules remain unsupported
or unverified. Companion bytes are retained with unparsed coverage. A native source
flag is not an approved population configuration; an absent outline is unresolved
geometry. This is incremental PCB-001/002 implementation, not acceptance of the
complete PCB product scope.

The PCB panel preserves packages, lists exact source revisions and coverage, downloads
originals, requests extraction explicitly, validates successful reports and displays
native placements, pads, nets, outline and limitations. Project changes discard its
captured data; a denied refresh removes prior report counts and file names.

Focused PostgreSQL tests cover scope, replay, rollback, immutable evidence and rejected
provenance/JSON. `scripts/check_pcb_intake.py --evidence-dir <new-external-directory>`
is the opt-in cached-image checkpoint against the unchanged independent synthetic
oracle, including malformed input. See the [pack guide](../../toolpacks/kicad/README.md).

## Population options and reviewed associations

`pcb_population` uses the shared Definition/Draft/Revision command and snapshot layer.
`pcb.population_create` seeds a default option with an explicit unresolved decision
for every native component in one accepted interpretation. `pcb.population_update`
uses the draft state token; `pcb.population_freeze` pins the complete target-revision
closure. Generic definition and draft commands apply the same typed validation,
authorization and exact dependency closure. A later draft may select a different
accepted interpretation; existing frozen revisions retain their original pins.

Each named option records `populate`, `omit` or unresolved for every exact native
component UUID. Only explicit `populate` enters that option's included set; explicit
`omit` enters its excluded set. Unresolved has no inclusion boolean. Decisions require
a human basis. The report's native DNP/BOM flags remain separate source assertions,
including when an option decision differs from them. No option alone qualifies an
assembly, fabrication output or purchase.

An association is an exact native component or pad UUID linked to a candidate target:
a pad to a connector-body contact through an exact pinout revision, a component to a
registered model representation, or a component to a library revision. The pinout's
body contact may have an unknown electrical assignment; mechanical keys are excluded.
Review is separately `candidate`, `accepted` or `rejected`. Accepted means the
association itself was reviewed, not that electrical compatibility, 3D fit, part
interchangeability or manufacturing readiness was approved. Accepted and rejected
decisions require a basis and either an attributable citation or one preserved source
file with exact revision, path, hash and rights. All candidates, including rejected
ones, remain in the permission and dependency closure. Source, interpretation,
target and evidence authority is rechecked on read, mutation and idempotent replay.

The PCB panel provides option decisions and association review forms over these
commands. Its target selector displays up to 2,000 authorized revisions and 2,000
registered models, and explicitly reports truncation. It does not claim complete
discovery beyond that limit. The option and association UI is an authoring and review
surface; physical and native-tool qualification remain separate checkpoints.

Read-only PCB review endpoints resolve the current draft and each frozen population
revision through the shared design authorization path. A frozen review loads its own
canonical snapshot and the exact accepted interpretation it pins, independently of
later draft edits or the currently selected intake report. The inspector shows native
DNP beside each option decision, and shows exact component/pad/contact, target
revision or model representation, model source path/hash/rights, review basis and
evidence citation or preserved file. The UI pages long component and association
tables and clears cached review data before each focus recheck. Revoked access removes
the retained review; there is no fallback to current draft state for an unavailable
frozen revision. This is engineering review visibility, not native or physical
qualification.

## Authoring and builds

Native editing is a controlled source handoff with expected revision checks. Use KiCad
adapters for specific released CLI/API operations and KiBot/InteractiveHtmlBom where
appropriate. Freerouting is an optional stage whose output is revalidated. Keep tools and
libraries pinned per pack; do not depend on the web process importing native bindings.
A black-box bought board can expose declared ports without invented internal detail.

### Bounded native fabrication evidence

`pcb_fabrication.request` generates outputs from one exact preserved board using an
operator-approved `kicad-fabrication-v1` recipe and the existing build/outbox/runner
boundary. An accepted native intake with a closed line outline is required. Requests
carry no scripts or mutable report payloads. The recipe retains exact source bytes,
rights, image, program and resource bounds. Source bytes are never saved, upgraded,
refilled, routed or changed for population decisions.

The initial subset is KiCad 10.0.6, board format 20260206, linux/amd64, two copper
layers and one closed line outline without cutouts. Straight outer copper tracks,
circle/rectangle pads and circular plated/nonplated through drills are supported.
Zones, vias, curved tracks/outlines, slots, custom pads, production-layer graphics/text,
native DNP, variables/embedded assets and companion project rules/settings fail
explicitly. Custom project-rule coverage is not inferred from standalone DRC defaults.
Companion bytes remain preserved; the pack cannot silently omit required custom rules.

Every successful build declares JSON DRC, nine Gerber X2 layers (`F.Cu`, `B.Cu`,
`F.Mask`, `B.Mask`, `F.SilkS`, `B.SilkS`, `F.Paste`, `B.Paste`, `Edge.Cuts`), the
Gerber job, separate PTH/NPTH Excellon files and a bounded hash manifest. Gerber
precision is 4.6 millimetres; drills use absolute coordinates, millimetres and decimal
zeros. KiCad's output Y axis has the opposite sign from its native board coordinates.
Empty layers and empty drill categories remain explicit files. Missing outputs fail;
failed or partial stages cannot become successful review evidence.

`pcb_fabrication.read` reviews only successful registered StageOutputs, verifying
the exact recipe, source, successful receipt, hashes, sizes, rights, media types,
complete declared output set and DRC counts. Current authority over the entire source
bundle and every output source, including derivation/archive parents, is checked
before diagnostics, retained-request conflicts and downloads. Direct API reads refresh
the actor's active account state. Reads
under `/api/v0/pcb-fabrication` and shared command/API/MCP/job paths use the same
authority. There is no client report acceptance. The PCB panel requests builds
deliberately and displays currently authorized exact evidence; scope changes, denied
requests, denied refreshes and focus rechecks discard retained output names and links.

Native DRC uses all severities and retains excluded/ignored-check metadata in its JSON.
The CLI omits `--exit-code-violations`: findings are retained diagnostics alongside
successful export, including unconnected items. A parse, export or command failure
remains a failed stage. Zero findings do not approve manufacturing, electrical intent
or physical qualification. ERC, schematic parity, source generation/modification,
autorouting and assembly BOM/placement remain separate PCB-005 work.

The opt-in standalone checkpoint is `scripts/check_pcb_fabrication.py --evidence-dir
<new-external-directory>`, using the existing isolated Docker runner boundary and
unchanged original synthetic fixture. It independently checks Gerber coordinates,
NPTH/PTH drilling, complete job layers, a disconnected-board DRC finding, malformed
input and unsupported slots/DNP. This proves bounded native CLI/program behavior;
approved runner transport, leases, cancellation/fencing/recovery and real browser
journeys require their own checkpoint. No installed execution authority is implied.

## Firmware

Resolve target, population, pin contract, sources, toolchain and configuration by exact
board occurrence. Two identical board revisions can use distinct firmware. Hardware changes
produce reviewable impact on firmware assumptions; firmware changes affect commissioning
applicability. Preserve compile results and a separate handoff, with no automatic flashing.

## Acceptance emphasis

Create a small original synthetic native board fixture with independently specified net
memberships, outline and holes using the actual toolchain during implementation. Test
preservation, discrepancy review, supported authoring, ERC/DRC, fabrication and assembly
outputs against those expectations. A tool absent from an environment is unverified, not
a passing mocked adapter. A bought populated board stops procurement expansion appropriately.

## Independent source assertions and disagreement review

`pcb_assertion` records explicitly human-entered terminal/net statements about one
exact preserved PCB, schematic or netlist file. The source revision, manifest hash,
path, file hash and rights remain pinned. Source role and property ownership are
explicit; the original stays authoritative. Coverage is either partial or a human
declaration of completeness with a basis. Unknown net state differs from explicitly
unconnected. Entered native IDs remain assertions; labels never establish identity.
These records do not parse original bytes or claim native schematic parity.

`pcb_comparison` independently pins two assertion revisions or accepted native PCB
interpretations, including exact report/source hashes. Board inputs preserve the
native extractor version, build/output evidence, native component/pad identities
and unsupported coverage. Blank native net names remain unknown. Comparisons use
explicit one-to-one terminal correspondence with a basis. Duplicate reference/pin
labels never trigger inferred matching; unmapped terminals remain reviewable unknowns.
An explicitly absent counterpart distinguishes declared complete from partial coverage.

Net-name differences and membership partition differences are separate findings.
Unknown assignments do not become agreement, disconnection or zero. No finding
chooses the correct source, merges nets, rewrites the original or updates an existing
copper graph. Human decisions are separately acknowledged, require source correction,
or mark the comparison not comparable, each with a basis. Finding identities bind the
exact source pins and correspondence; changed evidence cannot silently inherit an
old review. Freezing preserves both unresolved findings and reviewed decisions.

`pcb_disagreement.create`, `.update`, `.freeze` and `.read` use the shared operation
layer, source authorization, draft concurrency and current replay checks. The generic
design path applies the same validation and captured assertion-revision dependencies.
Reads recheck all retained source inputs before discrepancy diagnostics. Supported
comparisons are bounded to 2,000 terminals per input and 2,000 correspondences.
Schematic/netlist native extraction and automatic parity remain unverified by this
manual-assertion workflow. Physical qualification is never implied.

The source-disagreement workspace selects preserved files and exact assertion or
accepted board-report inputs, edits explicit terminal correspondence, shows independent
source evidence and findings, and saves/freezes review decisions. Changing inputs or
correspondence requires saving before reviewing new findings. Source, draft or frozen
read denial clears retained private findings and disables dependent editing actions.
HTTP inspection is available under `/api/v0/pcb-disagreement`.

Comparison output additionally has a cumulative 20,000-reference bound across finding
anchors, terminal details and repeated membership lists. A large split/merge partition
that exceeds it fails without saving a partial conclusion; compare a smaller explicitly
selected subset. Complete current source authorization still precedes this diagnostic.

### Controlled independent native extraction

`pcb_disagreement.request_native` pins the exact preserved file and source role to
an approved `kicad-net-assertions-v1` recipe through the shared build operation.
`pcb_disagreement.accept_native` accepts only registered successful JSON/XML output
pairs whose receipt, source, hashes, rights, image and exact program match that request.
It accepts no client report payload. The app validates bounded JSON and registered
bytes; XML parsing and schematic export occur only inside the isolated native program.
Accepted attempts and interpretations have database immutability guards.

The supported subset is standalone schematic format 20250114 exported by KiCad 10.0.6,
or preserved KiCad XML version E. Methods remain `native_schematic_export` and
`preserved_netlist_parser`; a netlist's source-tool string is retained as reported
metadata. Native component UUID, actual root sheet path, unit and pin fields combine
with the exact source hash to derive terminal occurrence IDs. Terminal UUIDs are not
exported. Duplicate labels or multiunit pin ambiguity remain unresolved, missing net
membership stays unknown, and no board-pad correspondence is inferred.

Comparison inputs can pin an exact accepted `source_net_interpretation` alongside a
human assertion or an existing immutable board report. Every correspondence and review
remains explicit. Existing board intake and reported-net graph evidence are unchanged.
The UI offers approved extraction request, status, acceptance, exact evidence inspection
and deliberate comparison selection. Read APIs under `/v0/pcb-disagreement/native`
return currently authorized metadata or exact interpretations; denied refreshes hide
cached rows and terminal choices.

Native request/acceptance and source-review commands authorize retained keyed outcomes
before reporting a changed-payload conflict, including unresolved legacy keys. Native
mutation failures clear the extraction preview and recheck affected source/interpretation
queries shared with comparison selectors. Refreshing extraction status also rechecks a
selected interpretation; this does not replace unsaved comparison edits or their state token.

The original fixture, contradictory variant, malformed input and trusted program were
checked with the exact isolated KiCad image. Full approved runner transport, cancellation,
fencing/recovery and application acceptance remain an integration checkpoint. Hierarchy,
variants, other formats, schematic parity and physical qualification remain unsupported.
