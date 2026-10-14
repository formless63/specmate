# Evidence kinds (EVD-001)

A shared, read-only taxonomy and workspace read model. Source modules (facts, builds,
cable test intent, physical units) stay authoritative for their own records; this module
only names what kind of statement each record is, what it can support and what it never
establishes. Nothing is a generic "passed".

| Kind | Meaning | Source today |
|---|---|---|
| `requirement` | Stated need or test intent; satisfies nothing | Frozen cable test plans |
| `source_claim` | Value reported by a citation or registered source, including a manually entered rating; retained, not verified | `source_observation` facts; declared unit registrations |
| `calculation` | Derived by formula and algorithm version from input assertions | `calculation` facts |
| `generated_check` | Tool or recipe receipt, or recorded derived result, over exact retained inputs | Build attempts; recorded interface assessments and firmware impact reviews |
| `review` | Human reviewed association | `reviewed_association` facts |
| `physical_measurement` | Observation of an actual unit with instrument, procedure and time | `measurement` facts on physical-unit subjects only |
| `physical_observation` | Observed or declared status of an actual unit with no instrument or procedure | Unit registrations with `observed`/`measured` status |
| `preference` | Declared choice; not a rating | `preference` facts |

`facts.append` rejects a `measurement` on any subject but a physical unit. A legacy
design-scope measurement row is shown as a declared claim with a warning, never as a
physical measurement. A declared `measured` unit status is a declaration, not a
measurement.

`evidence.list` (HTTP `GET /api/v0/evidence/workspaces/{id}?kind=...`) merges the sources
newest first with filtering by kind and by fact subject. Each record is authorized
individually; unreadable records are omitted and never counted or named. A scan limit per
source bounds a request and is reported. `evidence.taxonomy` reads the kind definitions.
Items carry subject (design, actual or project scope) and `workspace_id`, statement, status, conditions,
method (instrument, procedure, formula, algorithm version, recipe), provenance basis with
an explicit `independently_verified` flag, and lists of what the kind does and does not
establish. `physical_qualification` is always false.

## Recorded results

Interface assessments and firmware impact reviews are computed live from exact frozen
inputs, and reading them never records anything. A person with `item.create` records one
deliberately:

- `evidence.record_interface_assessment` (`revision_id`) stores the current
  `interface.read` result of one frozen assessment revision.
- `evidence.record_firmware_impact` (`comparison`, optional
  `expected_comparison_sha256`) stores one `firmware_impact.compare` result; a different
  current comparison hash is a conflict, so the stored result is the one that was shown.

A record keeps the exact request, the result, its SHA-256, the algorithm version, an
optional note, the actor and time, and one pin per exact input revision with its role
(assessment, pinouts, dependencies; baseline/candidate firmware, population and assembly).
Database triggers reject any update or delete and keep pins inside the record workspace.
Both commands support idempotent retry; replay re-checks current read authority.

Records appear in `evidence.list` as `generated_check` items with origin
`recorded_result`. A record is `stale` when any pinned input definition has a newer
revision; it is never rewritten or re-evaluated, and the warning names each superseded
pin. Every workspace member reads everything in the workspace and pins stay inside the
record workspace, so listing and reading a record need only `workspace.read`; idempotent
replay of a record command re-resolves the exact inputs through the owning module.
`evidence.read_recorded` (HTTP `GET /api/v0/evidence/recorded/{id}`) returns the full
snapshot with per-pin staleness. A recorded firmware review holds the observation page
that was compared; when that is not every observation in scope, the item states
"observations N–M of T". It is not a human approval and evaluates no hardware.

## Actual-subject tests (EVD-002)

`evidence.record_test` (needs `inventory.manage`, like physical-unit facts) stores one
immutable test record: the procedure, one or more instruments (name, optional identifier,
calibration `unknown`/`calibrated` with a reference/`uncalibrated`), conditions (known or
explicitly unknown), observation time, the criterion and a finding of `criterion_met`,
`criterion_not_met` or `inconclusive`, plus the exact subject:

- one physical unit, or
- one work batch taken as a whole, with an optional units-tested count (omitted is
  unknown, never zero or all).

An optional resolved configuration records the exact configuration the subject was tested
as; omitted, the list states that the tested configuration is unknown. The design revision
of the subject is stored for later applicability review. A record never extends beyond its
subject: a test of unit A is invisible under unit B of the same revision, lot or batch,
and a batch test is not shown under its member units. An uncalibrated instrument can only
support an inconclusive finding. Records are append-only (database trigger), idempotent on
retry, and appear in `evidence.list` as `physical_measurement` items with origin
`test_record`; `actual_id` lists the records made on one unit or batch.
`evidence.read_test` (HTTP `GET /api/v0/evidence/tests/{id}`) reads one record. Listing and
reading re-check current read authority over the subject and configuration. A record is
not qualification and is `independently_verified: false`.

Not mapped: knowledge notes are context, not evidence. Applicability or supersession
rules, batch/configuration test scope and release closure belong to later evidence
capabilities.
