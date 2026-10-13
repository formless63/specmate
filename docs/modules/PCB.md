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
