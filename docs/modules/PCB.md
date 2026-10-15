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
use the shared command authority. Reads under `/api/v0/pcb` enforce current workspace
membership. Payloads and list routes are workspace-scoped (`workspace_id`,
`/api/v0/pcb/workspaces/{id}/...`); creating a firmware item needs `item.create`. A request requires `build.execute`, an idempotency key and an installed
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
remain explicitly unsupported. The board outline can be designated as owned by its
native file and reconciled from accepted reports; see [explicit property
authority](SOURCES-AND-JOBS.md#explicit-property-authority). Copper membership never follows the separately
labeled, unreviewed resistor reference/value candidate passages.

Boards in released KiCad 5, 6, 7, 8 or 9 formats are read only through a recorded
upgrade derivative (below). Schematic parity, netlist/fabrication/BOM/placement-file parsing,
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

### Recorded KiCad format upgrade

Extraction reads only board format 20260206. An older board fails with a specific
message instead of a generic one: a released KiCad 5-9 format (boards 20171130,
20211014, 20221018, 20240108, 20241229) "must be upgraded first"; older s-expression
formats (KiCad 4) are too old; unreleased development formats and formats newer than KiCad 10.0.6 are named
as such; a file without an s-expression version is not a KiCad board.

`pcb.request_upgrade` (`build.execute`) runs the separate `kicad-format-upgrade-v1`
stage through the same approved-recipe build path. The recipe pins the image, the
board path, every `.kicad_sch` path in the bundle (at most 90), rights, limits and
outputs. Inside the container the program copies each input to private scratch space,
runs `kicad-cli pcb upgrade` or `kicad-cli sch upgrade` on the copy, checks that KiCad
wrote board format 20260206 or schematic format 20260306, and confirms that the
read-only original bytes are unchanged. It writes only `upgraded/<path>` files and a
bounded `kicad-upgrade.json` report ([schema](../../contracts/schema/pcb-upgrade-report.json)).
The report records each file's source and output hashes, from/to format versions,
source KiCad major and exact `kicad-cli` argv. An already-current schematic is
carried over unchanged without a run; an unrecognized one fails the whole stage.

`pcb.accept_upgrade` (`source.register`) accepts only a successful receipt whose
outputs, hashes, rights and report match the exact recipe and original files. It
creates a derivative source bundle with the original revision as ancestry. Upgraded
files replace their originals; every other file keeps its original bytes. It records
immutable `PcbFormatUpgrade` provenance (tool version, image, recipe, build, report
hash, from/to versions) and opens a new intake on the derivative. Extraction then runs
there with the same path-pinned `kicad-intake-v1` recipe. The original revision,
intake and any failed attempts are unchanged. A recorded upgrade cannot be upgraded
again. `pcb.get` shows "Upgraded from KiCad N format" on the derivative intake and
lists upgrade attempts and derivatives on the original intake.

KiCad assigns fresh UUIDs to some items that older formats did not identify, so two
upgrades of the same original can produce different bytes. Population decisions,
associations and firmware pins bind the exact accepted interpretation of one
derivative. Project (`.kicad_pro`), library, rule and other companion files are
preserved unchanged; KiCad migrates project settings when the project is opened. The
upgrade is a native format conversion only. It is not a design review, schematic
parity check or physical qualification. Upgraded schematics are format 20260306,
which the separate `kicad-net-assertions-v1` pack reads. KiCad 5 schematics are legacy
`.sch` files; they are preserved unchanged and not upgraded.

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
operator-approved `kicad-fabrication-v2` recipe and the existing build/outbox/runner
boundary. An accepted native intake of the same exact board bytes is required; its
outline coverage does not gate fabrication, because KiCad exports line, arc and curved
outlines and cutouts natively. Requests carry no scripts or mutable report payloads.
Each recipe retains exact source bytes, rights, declared copper layer count, image,
program and resource bounds. Source bytes are never saved, upgraded, refilled, routed
or changed for population decisions.

Supported input is KiCad 10.0.6 board format 20260206 on linux/amd64 with an even
copper layer count from 2 to 32. A board in an older format must first be upgraded in
KiCad and preserved as a new source revision. When the bundle preserves a same-named
`.kicad_pro` (and `.kicad_dru`) beside the board, the program stages it with the board,
so its design rules, severities and text variables apply to DRC and plotting; the
report records each companion's path and hash, and review rejects a report that
disagrees with the preserved files. Without a project, KiCad default rules apply and
the report says so. Zones are exported with their stored fills and never refilled;
the report counts copper zones, rule areas and copper zones with no stored copper.
Production-layer graphics and text, arcs, through vias, custom/rounded pads and
oval slots are exported; production text that still contains unresolved
`${...}` variables is counted and shown as a warning.

Each failure names its check through a distinct program exit code and a bounded
`fabrication.json` failure report: tool version, board format, embedded files, board
parse, copper layer count against the recipe, renamed production layers, missing
closed outline, blind/buried/micro vias, native DNP, copper zones without stored fill,
invalid project JSON, the native DRC/Gerber/drill command, a native timeout, missing or
undeclared outputs, output size, and a source changed during export. A native command
failure also classifies its stderr (invalid input, board load, memory, filesystem,
arguments, signal or unknown). Anything else is reported as `unknown`. The bounded
stderr excerpt stays only in the registered failure report, which the runner registers
as a verified partial output of the failed stage; listings show the check, message,
detail and classification. The runner registers declared outputs that a failed tool
left behind; a refused upload never hides the failure itself.

Every successful build declares JSON DRC, Gerber X2 for every copper layer (`F.Cu`,
`In1.Cu` … `B.Cu`) and `F.Mask`, `B.Mask`, `F.SilkS`, `B.SilkS`, `F.Paste`, `B.Paste`,
`Edge.Cuts`, the Gerber job, separate PTH/NPTH Excellon files and a bounded hash
manifest. Gerber precision is 4.6 millimeters; drills use absolute coordinates,
millimeters and decimal zeros, with oval holes as G85 slots. Fixed command-line plot
options apply; board-saved plot settings are not used. KiCad's output Y axis has the
opposite sign from its native board coordinates. Empty layers and empty drill
categories remain explicit files. Missing outputs fail; failed or partial stages
cannot become successful review evidence.

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
original synthetic fixture variants. `scripts/fabrication_outputs.py` independently
parses Gerber X2 file functions, the Gerber job, outline arcs, stored-fill copper
regions and Excellon round hits and G85 slots against declared holes. The checkpoint
covers NPTH/PTH drilling, a disconnected-board DRC finding, an arc edge, circular
cutout, through via, stored zone fill, production graphics and an oval slot with and
without an original project file whose stricter rule and text variable must take
effect, and named failures for invalid project JSON, copper-layer mismatch, native DNP
and malformed input. This proves bounded native CLI/program behavior; approved runner
transport, leases, cancellation/fencing/recovery and real browser journeys require
their own checkpoint. No installed execution authority is implied.

## Firmware

Resolve target, population, pin contract, sources, toolchain and configuration by exact
board occurrence. Two identical board revisions can use distinct firmware. Hardware changes
produce reviewable impact on firmware assumptions; firmware changes affect commissioning
applicability. Preserve compile results and a separate handoff, with no automatic flashing.

### Firmware dependencies and targets

A firmware record is a design definition of kind `firmware` with typed `content.firmware`.
It uses the shared draft, state token and immutable revision layer. It pins:

- exact preserved source files: bundle revision, manifest hash and each file's path,
  hash, declared rights and role (application, library, configuration, board support,
  lockfile or other). At least one application file is required.
- configuration entries that are known values, explicit unknowns or named secret
  references. A secret reference never stores a value.
- a declared toolchain family, name, optional version and framework, and a toolchain
  board identifier label. A missing version stays unknown.
- one target: a frozen `pcb_population` revision, a population option and one exact
  native component UUID. An optional declared part label is informational only.
- pin assumptions: a firmware signal, an exact native pad UUID or unknown, a function,
  an optional peripheral instance, an optional expected reported net and an optional
  exact peer pad.

`firmware.create`, `firmware.update` and `firmware.freeze` use the shared operation layer.
Before any diagnostic, they authorize the complete source closure of every pinned file and
the target population's full closure (interpretation, source, targets and evidence).
Retained keyed outcomes are authorized before a changed-payload conflict. Saving rejects
source pins that do not match their exact revision manifest, file hash or rights, and
a target that is not a frozen PCB population revision.

Evaluation reports each check as valid, invalid, unknown or not evaluated:

- **Invalid:** a missing option or target component, a target component omitted in
  the selected option, a pad that is not an electrical pad of the target component, one
  pad used by two signals, a duplicated exclusive peripheral role, a reported pad net
  different from the expected net, or a peer that is missing or omitted or on another
  reported net.
- **Unknown:** an unresolved population decision, an unknown pad or peripheral
  instance, a blank reported net, an unknown toolchain version and unknown configuration.
- **Not evaluated:** pin function capability and whether a declared part or toolchain
  board label matches the populated part.

Reported net agreement is pad membership, not connectivity proof. References, values,
signal names and part labels never establish pad correspondence. Any invalid finding
blocks freezing, so a wrong target or incompatible pin assignment cannot become a frozen
declaration. Freezing pins the target population revision as a design dependency. Every
declaration review states that toolchain support is declared, not verified. Reviewing or
freezing a declaration performs no compilation, flashing or device operation. Inspect
separate compiler evidence for recorded compile results; a declaration alone does not
establish those results or a working device.

`firmware.read` (a draft or a frozen revision) and HTTP reads under `/api/v0/pcb` list
firmware, frozen population targets, drafts and revisions with current access checks and
actor refresh. `firmware.assignment_review` (also
`GET /api/v0/pcb/assemblies/{snapshot}/firmware-review`) compares each contextual
assembly firmware assignment with the firmware's exact target. The result is valid for
the same population revision and invalid for a different one or an untyped placeholder.
It is unknown when the occurrence is not a PCB population revision. The PCB panel offers
structured authoring, evaluation, freezing and assignment review on request.

### Reviewed firmware for repeated board occurrences

`firmware_occurrence.inspect` projects an assembly draft or exact frozen snapshot,
including nested occurrence paths and each effective firmware revision. Repeated uses
of one PCB population revision retain the same board/native interpretation pins while
selecting independent frozen firmware configurations. A display reference is never the
occurrence address.

`firmware_occurrence.review` compares one exact draft occurrence with a selected frozen
firmware revision. The preview shows the previous and proposed declarations, exact
source manifests/files/rights, configuration, toolchain, population option, native
component and pin assumptions. Its digest binds the complete owning draft state and
the exact reviewed evidence. A different population target is visible as ineligible;
no target correspondence or compatibility is inferred.

`firmware_occurrence.adopt` requires that digest, the owning draft state token and an
explicit review basis. It adds or replaces only the selected outer contextual assignment;
other occurrences and frozen child/firmware/assembly revisions retain their pins. A
reviewed explicit unassignment masks inherited firmware for that occurrence. Concurrent
edits conflict, and evidence/assignment writes commit together. Immutable adoption rows
retain both the before/after content and reviewed declarations, independently of later
draft changes. `firmware_occurrence.read_adoption` reopens this evidence under current
authority; draft inspection lists the latest 100 records and declares truncation.

Reads, previews, mutations and retained keyed outcomes recheck the owning design,
candidate firmware, displaced declarations and their complete source/dependency closure,
including ancestor inputs. Current and retained outcome authority precedes keyed
mismatch or unresolved legacy conflicts. Read operations require a fresh evaluation
without an idempotency key. The occurrence panel supports deliberate review/adoption,
frozen inspection and a stable keyed retry after response loss; denied reads, focus
rechecks and scope changes discard retained private evidence.

This flow records engineering declarations. It does not compile, resolve a binary
artifact, flash hardware or observe device operation; those remain separate capabilities
and evidence. Sharing a board revision does not establish firmware compatibility.

### Exact change and observation review

`firmware_impact.compare` and the Firmware impact tool compare two exact frozen
firmware declarations, optionally at separate frozen assembly occurrences. Choose
authorized local records by name and revision, or choose a named assembly and exact
board occurrence to use its assigned firmware, then inspect their source, native target,
configuration, toolchain and pin identities. The comparison reports changed, unchanged
and unknown assumptions with reasons. Labels and matching reference text never establish
hardware identity or compatibility.

Historical fact assertions on the baseline firmware, population, contextual occurrence
and physical units remain attached to their original subjects. Additional assertions may
be selected deliberately. The review displays their original provenance and applicability;
it never transfers a result to a candidate, modifies an observation or infers which
firmware was installed on an actual unit. Compiler receipts are build evidence and are
not assessed as device observations. Missing physical correspondence stays unknown.

The read operation and `/api/v0/firmware-impact/compare` recheck the selected project,
both frozen dependency/source closures, fact-input ancestry and actual-unit authority
before returning comparison details. Observation pages contain at most 100 rows; scopes
or evidence closures exceeding 5,000 assertions are rejected without a partial result.
The browser clears stale results when inputs, context or current authority change.
This review does not execute a compiler, flash a device or establish physical qualification.

## Firmware change and observation review

`firmware_impact.compare` derives a read-only assessment of an exact frozen baseline
and candidate firmware revision. Each side can additionally name its exact frozen
assembly snapshot and contextual board path; that firmware must actually be assigned
to the selected occurrence. Repeated boards remain distinct even when their labels,
board revision and firmware match. Each contextual snapshot belongs to the selected
project. Its exact assigned firmware and population may retain their owning readable
library project; the shared frozen-input resolver verifies assignment and target.
Standalone firmware belongs to the selected project. Library reuse does not permit
arbitrary foreign firmware or context selection.

The assessment compares firmware identity, contextual occurrence, exact population
target and option, accepted native interpretation and MCU identity, preserved sources
and rights, toolchain declarations, each configuration entry and each signal's pin
assumptions. Pin hardware anchors retain the interpretation hash, population pin and
actual reported pad/net. Changed, unchanged and unknown findings carry reasons.
Matching secret references, absent values or unresolved native nets remain unknown;
matching declarations do not establish MCU capabilities or toolchain compatibility.

Existing fact assertions on the exact baseline firmware/population revisions, selected
contextual occurrence and physical units with those design pins are discovered without
registering another subject or ledger. Exact baseline firmware/population revision
assertions may come from those revisions' owning readable library projects. Contextual
occurrence and actual-unit assertions remain within the selected project; unrelated
library assertions and units are not discovered. Callers may deliberately select up
to 100 additional assertion IDs, also within the selected project. Results preserve
the original subject, recorded value,
method, conditions and evidence. An unrelated assertion has unknown applicability.
Actual-unit observations always require review because the installed firmware and
candidate device state are not established by a design pin. Changes require review
of related observations; historical results are never invalidated, deleted, reassigned
or automatically transferred to the candidate. No candidate test result is created.

Both frozen input closures, parent assembly inputs and all selected/discovered fact
and source-input closures are authorized under current permissions before comparison
diagnostics. Review is fresh and accepts no idempotency key or mutable draft state
token. Up to 5,000 assertions are supported, with 100 rows per page, explicit total,
offset, continuation and partial-review status. Each page rechecks the complete
current closure. The comparison hash identifies the derived response; it is not a
persistent approval, observation or qualification record.

The firmware impact panel selects authorized local frozen firmware by name and revision,
or selects a named frozen assembly and exact occurrence first to resolve assigned
firmware, including authorized library reuse. It optionally selects additional fact subjects and
shows exact hashes, native IDs, assumptions and historical applicability. Focus,
scope changes and denial discard retained evidence; late asynchronous responses cannot
restore stale private findings. HTTP inspection is available at
`/api/v0/firmware-impact/compare`; GUI, agents and trusted jobs share the same operation.
This workflow performs no compilation or flashing. Compiler receipts remain separate
build evidence and cannot establish working-device observations, compatibility or
physical qualification.

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

The supported subset is a standalone schematic in format 20250114 or 20260306 (written
by KiCad 10, including a recorded format upgrade), exported by KiCad 10.0.6,
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

## Board terminals and declared paths (PCB-006, PCB-003, TOP-001, TOP-002)

The `board` kind may carry typed interface content (`interface.create`/`update` with
`kind: "board"`); a generic board without it stays a valid untyped part until its first
typed edit, and `interface.freeze` requires the typed content. A board declares:

- **terminals**: labeled pads, holes, contacts or test points with a group (for
  example "Connector side" or "Cable side") and side. Labels are display text; the stable
  `terminal_id` is the identity. KiCad-derived terminals keep exact native pad UUIDs.
- **carried connectors**: an exact connector body revision and which terminal lands on
  which contact, with a review state. Unreviewed correspondence reads `unknown`.
- **switches and jumpers**: named conditions with mutually exclusive states.
- **paths** between two terminals: straight copper, through a component (kind, written
  value, reference, exact resistance or capacitance, which must agree with the written
  value when both are given), through a switch state, or unknown. The component shape is
  shared with inline cable parts. A terminal without a path is `unknown`, never
  unconnected.

Origin is `black_box` (typed from a drawing or datasheet) or `kicad_derived`, which pins
the exact frozen population revision and its interpretation hash; native pad IDs must
exist in that report. `interface.board_propose` (`GET interfaces/boards/propose`) returns
a proposal from a frozen population: the user chooses which components' pads become
terminals (default: those with accepted port associations), native nets among them become
copper paths with `reported_net_membership` provenance, resistor passages whose nets reach
two chosen terminals become component paths, and port associations become an unreviewed
carried connector. The proposal is never stored or accepted; creating the board is a
separate, explicit command.

`interface.board_trace` (`GET interfaces/revisions/{id}/board-trace`) interprets the
declared paths between two terminals with the passive-passage interpreter: copper needs
the explicit ideal assumption, resistors add declared series resistance, switch paths
follow selected states, and an absent path is not a disconnection proof. In the copper
graph, board terminals are nodes, copper paths are `board_copper` edges, and component,
switch and unknown paths plus connector correspondence stay boundaries. Continuity and
physical qualification remain `not_evaluated`. The Boards lens edits board rows at
Library or project scope.

The authorized draft/frozen population review includes
`interpretation.intake_id` alongside the exact interpretation, attempt, output
and source pins. Record pages use this existing intake identity to open Sources
directly; they need not scan other intakes. It is returned only after the same
current population/source/association closure checks as the rest of the review.

### Drawing-first board records

The Boards collection opens one selected declared `board` or `pcb_population` state
in the shared record frame. Declared topology reuses the board drawing and layout;
its dashed outline is a schematic placeholder. Native placements reuse the accepted
report renderer. An exact historical URL selects that revision even beyond the first
history page; unavailable historical state never falls forward to newest.

Pads, paths, carried connector bodies, population decisions, associations and source
review occupy contextual inspectors. Clicking pads inspects them. Only explicit
Draw path creates a declaration, initially unknown with no basis. Native DNP flags,
option decisions, human associations and physical qualification remain distinct.

Source inspection reads the authorized exact intake from the selected review payload,
then checks the selected interpretation and source hashes. New native attempts do not
repin the record. Independent human assertions, source comparisons and ideal passive
models retain separate draft tokens, source pins and freeze/review operations. Working
references are freshly checked on activation and focus. Authority failures withdraw
retained content while preserving local buffers and their original editing tokens.
