# PCB and firmware workflows

## Intake

Preserve original sources and report supported versions/types. Extract parts, pads, nets,
outline, mounting features, placements, population and candidate interfaces/models as a
versioned interpretation. Show schematic/PCB disagreement and lost semantics. Review
matching rather than silently promoting inferred connector ports to truth.

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
