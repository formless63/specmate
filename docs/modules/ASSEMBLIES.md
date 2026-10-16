# Reusable assemblies and contextual occurrences

Assembly definitions use the existing editable draft and immutable snapshot/revision
identities. Their `content.assembly` is a versioned typed payload. Each occurrence has
a stable local ID, an exact child revision, a separate display reference, canonical
placement and permitted firmware assignment. Nested addresses combine the root snapshot
ID with the ordered local ID path. A stable feature ID extends that address; display
labels and mesh indices never substitute for it.

`assembly.create`, `assembly.update`, `assembly.snapshot` and `assembly.freeze` share
the design operation layer. Updates require the draft concurrency token. Capture
discovers and pins the complete exact revision closure, including nested occurrences,
firmware and referenced revisions. Child drafts or newer child revisions never replace
those pins. Contextual firmware assignments can distinguish two uses of a shared nested
board revision without changing its copper. An assignment may also record
`population_option_id`, one option declared by the occurrence's exact board population
revision; it is rejected on any other occurrence kind or for an undeclared option. A
contextual record replaces the occurrence's assignments as a whole, so writers keep the
fields they do not change.

Relationships have distinct contracts for containment, electrical connection, mating,
mounting, source derivation, documentation and procurement. Structural occurrence edges
and explicit containment edges must be acyclic. Electrical and documentary cycles are
permitted. A relationship records intent; it does not establish electrical compatibility,
mechanical fit, source ownership, procurement availability or physical qualification.
Source/document/procurement references currently address exact design revisions; source
bundle-file linking and orderable manufacturer variants remain their respective domains.
Definition equality alone is not a cycle: a new revision can document or contain its
own older finite revision. Cycle detection follows exact resolved containment paths.

Canonical placement uses explicit known/unknown status in a right-handed z-up millimeter
frame. Known transforms require a translation and unit quaternion. Unknown placement has
no guessed coordinates. The inspector's spread layout is browser view state, separate
from canonical placement. Native geometry, collision evaluation, world-transform
composition and placement tooling remain separate mechanical-scene obligations.

Assembly reads and replay checks reauthorize the entire referenced closure before
disclosing paths, counts or diagnostics. The closure stays inside the assembly's
workspace: workspace membership covers it, and a child from another workspace (even
one the actor can read) is rejected as not found before any path or graph
diagnostic. An unavailable dependency makes the closure unavailable; omission never
masquerades as a complete assembly. Reads are bounded to
5,000 contextual occurrences, depth 32 and 2,000 distinct revisions, and cannot use
idempotency to preserve readable results after permission changes.

Feature addressing currently reports `not_evaluated` for feature existence and
compatibility until a discipline feature registry supplies evidence. The inspector
preserves selection across the occurrence tree, assembly contents and display layout.
This is focused FND-003/FND-004 implementation evidence. Integrated geometry, firmware
build assignments, BOM/document/export propagation and portable subassembly journeys
are still required before full capability acceptance.


Electrical relationships can declare exact wiring between reusable child products.
In this form `a` and `b` identify occurrence paths without legacy `feature_id` strings,
`a_terminal` and `b_terminal` identify contacts, exact stack terminals, or exposed
segment/pigtail ends, and `basis` states the declaration. The complete pinned closure
is authorized before terminal diagnostics. Material ends already owned by a child
joint, preparation or breakout cannot be landed again by the parent. Repeated uses
of one cable revision retain separate terminal identities and physical stock pieces.

The copper graph connects these exact addresses as declared joins; matching labels
never create continuity. Existing feature-string electrical relationships retain
their unevaluated meaning. Device relationship controls offer exact terminal choices
from the selected frozen children; saved inspection and coordinated schematic and
termination documents retain both occurrence paths and the declaration basis.
