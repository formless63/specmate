# Scoped facts, explicit unknowns and provenance

`facts.register_subject` resolves a project, definition, exact revision, contextual
occurrence or actual physical unit to a fact ledger. Occurrence targets use the root assembly snapshot and
ordered local ID path, optionally extended by a stable feature ID. Two repeated uses
have separate ledgers. Feature existence remains explicitly `not_evaluated` until a
discipline registry provides that evidence.

An actual-unit target resolves one immutable serialized unit and its exact as-obtained
or as-built revision through current project and revision access checks. Two units of
one revision have separate ledgers; a later revision receives no copied observations.
Registering or appending to a unit ledger requires `inventory.manage`. Existing design
subjects retain `design.edit` write authority; current project read and all evidence
closure checks govern disclosure. The facts panel selects actual units by serial and
shows unit identity independently from design and occurrence targets.

`facts.append` records an immutable assertion under the ledger's expected state token.
Corrections, competing sources and later observations append new records. Neither an
assertion nor its source/input links can be updated or deleted in PostgreSQL. Actors
and request IDs come from the shared operation context. Register and append operations
have authorized project idempotency namespaces and current authority replay checks.

Each assertion declares its property, status, purpose, value role, conditions, basis and
provenance. Status is `known`, `unknown`, `conflicting`, `not_applicable` or
`not_evaluated`. Only known assertions carry values. An absent allowance is unknown;
it is never zero. Source observation, reviewed association, calculation, measurement
and preference are separate methods. Measurements require an observation time,
instrument and procedure. Calculations name their formula/version and immutable input
assertions; recording a formula never executes it. Preferences cannot claim engineering
rating or manufacturing purposes.

Known values may be quantities, ranges, tolerance deltas, text or explicit booleans.
Nominal, actual, lower bound, upper bound and tolerance roles stay distinct. Numeric
values use finite decimals and a modest supported unit registry for length, mass, time,
voltage, current, resistance, capacitance, inductance, frequency, temperature, angle,
count and dimensionless quantities. Unsupported units are rejected. Original values
and units remain in the assertion; canonical values are separate. Celsius temperatures
convert to Kelvin, while temperature tolerance deltas do not receive the absolute
temperature offset. Conditions also retain original and canonical values.
Extreme decimal exponents are rejected before precision normalization. Canonical
arithmetic uses a bounded decimal context with inexact/underflow traps, so a nonzero
input cannot silently become zero.
Wire magnitudes use decimal strings or exact whole JSON integers. Binary floating-point
JSON values and booleans are rejected because decoding can already have rounded or
underflowed them before fact validation. Internal typed callers may pass `Decimal`.

Reads authorize the subject, every registered source file and transitive input assertion
before returning values, counts, hashes, state tokens or conflict diagnostics. A revoked
dependency makes the ledger unavailable. Registered source rights and hashes remain
attached. Free-text citations are declared and unverified; they grant no authority or
qualification. Read pagination never loses conflicts from earlier assertion pages.
Registered source paths and opaque feature identifiers retain their exact spelling;
whitespace is not trimmed into a different file or feature identity.

Assessments compare assertions only for the same property, purpose, role and conditions.
Equal canonical values can be displayed once. Disjoint numeric intervals, incompatible
dimensions or different text/boolean/tolerance candidates remain conflicting. Overlapping
ranges retain each candidate without selecting a scalar value. Explicit unknowns and
unperformed evaluations remain visible alongside known observations. Illustrative
dimensions are separate from manufacturing or clearance assertions; this module does
not perform fit checks or elevate a fallback into measured geometry.
A known assertion and a not-applicable assertion in the same context are an applicability
conflict, regardless of insertion order; neither silently wins.

Assertions linked to a revision or occurrence are **attached evidence**, not implicit
edits to frozen content. Recording one later does not modify its canonical snapshot or
retroactively add that assertion to earlier build inputs. Explicit assertion pinning in
future build/configuration/release manifests needs its own reviewed contract. Actual-unit
measurement assertions now attach to exact units, but they do not themselves establish
qualification, release, or applicability to another unit, lot or revision. Batch and
configuration test scope, automated rule/calculation execution and physical qualification
remain separate evidence and discipline obligations.

The panel opens resolved subjects, inspects unknowns and all conflict candidates, and
records typed assertions and provenance through the shared operations. Focused FND-005
checks use original synthetic inputs; integrated mechanical/wiring calculations and
agent journeys remain acceptance checkpoint work.
