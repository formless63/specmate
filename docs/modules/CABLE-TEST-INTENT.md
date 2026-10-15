# Cable test intent and labels

A `cable_test_plan` definition owns explicit continuity, isolation or unknown
expectations and printable label text. Each plan pins a frozen root revision and
one exact cable revision. An empty occurrence path means that the cable itself is
the root; an assembly root uses a stable contextual occurrence path. Repeated
uses of the same cable revision retain distinct scopes and may carry different
expectations. Display labels never identify or merge terminals.

Pairs identify either a physical contact or shell on an exact cable endpoint, or
an exact conductive stock feature at that endpoint. Keying features, insulation,
groups and missing terminals are rejected. Each expectation has a declaration
basis and independent unknown, unverified-citation or exact registered-file
evidence. Labels target the whole selected cable, one endpoint or one terminal.
Unknown intent remains unknown; no signal words, role defaults or shop policy
silently creates a continuity or isolation expectation.

`cable_test_plan.create`, `.update`, `.snapshot` and `.freeze` use the shared
engineering operations, independent draft state tokens and immutable captures.
Generic definition/draft commands apply the same typed validation and dependency
capture. `.inspect_target`, `.read` and `.package` are fresh read operations. Both
supplied scope references and retained idempotency outcomes are reauthorized
before mismatch diagnostics. Test plans are global workspace items that projects
reference; creating one takes an optional `workspace_id` and no project.
The full root closure, selected cable dependencies and registered evidence including
preserved originals and archive/edit ancestors stay inside the plan's workspace and
must remain readable before file-path, terminal, label or occurrence diagnostics are
shown; a revision from another workspace reads as not found.
Direct query boundaries refresh account liveness.

The Cable test intent workspace supports exact revision IDs, contextual paths,
structured pair/label/evidence authoring, saved-draft freeze and frozen inspection.
Refreshes preserve an editor's unsaved values and original optimistic state token;
a successful save advances that token. Inaccessible target or frozen evidence is
hidden, including its derived terminal choices and package link. Download requests
recheck authority independently.

The portable expectation package is inert JSON. It embeds the selected cable's
frozen design closure with snapshot identities, canonical content and SHA-256
hashes, and retains the root snapshot identity/hash and contextual occurrence path.
It does not embed unrelated parent or sibling contents. Registered evidence keeps
its exact bundle revision, path, hash and declared rights; source bytes are omitted.
The package's hash identifies the exported bytes. Reading this package does not
establish distribution rights, which remain `not_evaluated`.

## Proposed from a cable intent

`cable_test_plan.derive_from_intent` reads an exact frozen cable in its exact scope and
the cable intent it pins (or a named intent revision) and proposes a plan body; nothing
is stored or frozen, and the proposal is accepted only through `cable_test_plan.create`
or `.update` and reviewed before freezing. The derivation reuses the intent check's
declared path search and end mating:

- each required (or optional and wired) intent row gives a **continuity** pair from the
  cable contact at the from end to each destination contact, only where the cable
  declares a path. Declared resistors on the path give `expected_resistance_ohm` (their
  series sum); a resistor without a stated value leaves it null. A path through an
  unreviewed landing or unknown board path, or through a capacitor or unknown part, is
  proposed as `unknown` with the reason;
- every two rows that the intent keeps apart (no shared intended contact) give an
  **isolation** pair at the from end; a must-not-connect row gives isolation from every
  other tested net and from its destination contacts;
- rows the cable does not carry (no declared path, an open question, an unmapped pin,
  optional and unwired, no source pin) propose nothing and are listed with the reason;
- labels name each tested contact by number and signal, and each end by its intent end.

Pairs may carry a display `signal` and a `derived_from` record (intent revision and row
IDs). Neither identifies a terminal or establishes a result.

Authored expectations are separate from declared copper, native reported-net
membership, interpreted paths, physical-unit measurements and test results.
`physical_test: not_performed` describes the evidence in this plan/package, not
an assertion about every physical article that uses the design. Physical continuity
and qualification remain `not_evaluated`; freezing or downloading creates no
measurement, pass/fail outcome, electrical rating or execution authority.
