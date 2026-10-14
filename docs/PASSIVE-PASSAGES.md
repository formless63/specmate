# Reviewed passive passage models

A `passage_model` is a separate, explicitly idealized circuit declaration pinned to one
exact frozen copper graph root. Stable terminal IDs include the root revision, occurrence
path, owning revision and feature. A repeated instance or later root cannot inherit an
assertion merely because its labels or child definitions match.

`passage.create`, `.update` and `.freeze` share design permissions, optimistic draft
concurrency, exact dependency capture and current source authorization with generic design
operations. Typed content is under `passages`; generic operations enforce the same rules.
A passive model is a workspace item: `passage.create` takes an optional `workspace_id`
and no project, and its pinned root graph must be in that workspace (a foreign
revision reads as not found).
Each declaration retains its type, endpoints, basis, nullable parameters, condition and
unknown/citation/exact registered file evidence. A link to a native candidate names an exact
boundary containing both terminals. It does not accept an extracted label, value, population
or electrical behavior automatically. The original copper graph stays unchanged.

Freezing captures immutable model bytes and the exact root revision pin. `passage.review`
appends a sequential, immutable decision about that frozen model under its independent
review token. Its source evidence is retained separately. A current accepted review is
required to use the declarations in `passage.interpret`; unreviewed, rejected and
needs-evidence models yield an explicit unknown result. Acceptance is review of a declared
ideal circuit, not physical qualification. Later model revisions need their own review.

The live query uses distinct `dc_continuity`, `shortness`, `resistance` and `signal`
semantics. It requires explicit `ideal_zero_resistance` copper assumptions before treating
declared copper or reported native-net membership as ideal connections. The default is
`unspecified`, which propagates unknown on affected paths. Reported membership and declared
copper retain separate evidence labels. Neither becomes measured zero ohms or verified
physical continuity.

A resistor with a known positive declared resistance is resistive; explicit zero has
separate ideal-short semantics. Missing resistance is unknown. An ideal capacitor blocks
steady-state DC, and its signal impedance requires positive declared capacitance and query
frequency. Capacitive impedance is a derived approximation using a stated ideal model and
finite pi approximation; it does not establish signal transfer, gain, loading, waveform
quality or measured precision. The adapter does not resolve diode bias/nonlinear behavior,
inductor losses, transformer coupling or active regeneration. Those paths retain type,
traversal direction and condition, and remain unknown. Forward/reverse traversal follows
the declared endpoint order; it is not an inferred diode bias state.

A model can declare up to 64 exclusive conditions, each with a unique model-local identity,
two to 32 distinct named states and a basis. The identity describes one switch or fitted
option in this exact frozen model; labels, designators and similarly named occurrences
never establish shared identity. A `conditional` passage can explicitly declare an
`ideal_contact` with a `condition_id` and required closed `state`. References must name a
state in the model's declarations. The accepted review covers this ideal-contact model:
zero resistance when its required state is selected, open in every other declared state.
It does not model contact resistance, leakage, switching transients or physical fitting.

The read-only query carries `condition_assignments`, with at most one state per identity.
Assignments are assumptions for this query, not observations or edits to the frozen model.
Unknown identities/states and duplicate assignments are rejected. An omitted assignment
keeps the affected path unknown. A path requiring two different states of the same identity
reports `mutually_exclusive_condition_states` and cannot be a satisfied proof, even when
the query selects one of them. Repeated requirements for the same state are consistent;
independent condition identities remain independent. The result retains requirements,
selected states and the explicit ideal-contact assumption.

An untyped conditional passage or additional free-text `condition` remains unknown.
Assignments cannot resolve active or nonlinear behavior. Unsupported behavior still
outranks a local ideal contact/capacitor block, preventing an unknown broader active model
from becoming an open-circuit proof. Every open/block conclusion describes the declared
ideal model only; physical continuity and qualification remain unevaluated.

Electrical parameters use exact decimal strings or exact integers; floating-point inputs
and booleans are rejected. Inputs are bounded to 40 decimal digits, exponents from -30 to
30 and nonzero adjusted exponents in that range. Resistors permit explicit zero; capacitance
and frequency must be positive when supplied. Series resistance arithmetic uses a fixed
80-digit bounded context with rounding/inexact traps. A tiny positive resistance cannot
underflow into a short. Capacitive arithmetic permits rounding only with an explicit
approximation label. Unsupported range or arithmetic produces an error/unknown, never a
fabricated finite result.

The adapter enumerates simple candidate paths with explicit limits: at most 64 hops,
32 returned paths and 20,000 expansion steps. Repeated terminals/edges are excluded from a
path; bounds stop analysis and make the aggregate unknown rather than imply completeness.
A series-path resistance is not a network equivalent. Multiple paths require a network
solver and leave the aggregate resistance unknown while preserving individual path results.
No modeled path is not a physical-disconnection finding. Source boundaries omitted from the
reviewed ideal model remain inspectable.

Current actor, full root/source/origin closure, all assertion evidence and every retained
review source are authorized before terminal diagnostics, conflicts, keyed mismatch or
replay. `passage.read`, `.interpret` and the HTTP model reader evaluate live authority;
queries cannot use idempotency keys to bypass changed permissions or review decisions.
Each result retains exact model/root hashes and the review identity. Physical continuity,
compatibility, signal transfer and physical qualification remain explicitly unevaluated.


The Passive passage interpretation workspace authors explicit terminal declarations, saves
and reopens drafts, freezes saved state, reviews exact model revisions and inspects query
paths. Native-candidate actions preselect only exact endpoints and the candidate link;
kind and parameters start unknown. Electrical text reaches the operation unchanged.
Registered assertion and review files show exact bundle/path/hash/rights provenance.
A source denial clears cached models, graphs and results. A changed draft token requires
reopening current state rather than rebasing unsaved edits silently. Changing query inputs
or the project context fences stale responses; an authorized unchanged refresh retains review text.

Exclusive conditions can be authored alongside passages, reopened from saved drafts and
inspected on frozen models. Conditional contact selectors name exact declared identities
and closed states. Query selectors default to unspecified; changing an assignment clears
and fences any earlier query result. The displayed path steps retain the required and
selected state independently of the free-text unevaluated condition.
