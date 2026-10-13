# Reviewed passive passage models

A `passage_model` is a separate, explicitly idealized circuit declaration pinned to one
exact frozen copper graph root. Stable terminal IDs include the root revision, occurrence
path, owning revision and feature. A repeated instance or later root cannot inherit an
assertion merely because its labels or child definitions match.

`passage.create`, `.update` and `.freeze` share design permissions, optimistic draft
concurrency, exact dependency capture and current source authorization with generic design
operations. Typed content is under `passages`; generic operations enforce the same rules.
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
inductor losses, transformer coupling, active regeneration or conditional states. Those
paths retain type, traversal direction and condition, and remain unknown. Incompatible or
undefined switch states cannot form a positive continuity conclusion.

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
