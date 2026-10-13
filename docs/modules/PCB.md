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
foreign CAD formats, models, reviewed matching, population variants and manufacturing
rules remain unsupported or unverified. Companion bytes are retained with unparsed
coverage. A native source flag is not an approved population configuration; an absent
outline is unresolved geometry. This is an incremental PCB-001/002 implementation,
not acceptance of the complete PCB product scope.

The PCB panel preserves packages, lists exact source revisions and coverage, downloads
originals, requests extraction explicitly, validates successful reports and displays
native placements, pads, nets, outline and limitations. Project changes discard its
captured data; a denied refresh removes prior report counts and file names.

Focused PostgreSQL tests cover scope, replay, rollback, immutable evidence and rejected
provenance/JSON. `scripts/check_pcb_intake.py --evidence-dir <new-external-directory>`
is the opt-in cached-image checkpoint against the unchanged independent synthetic
oracle, including malformed input. See the [pack guide](../../toolpacks/kicad/README.md).

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
