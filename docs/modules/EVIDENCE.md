# Evidence kinds (EVD-001)

A shared, read-only taxonomy and project read model. Source modules (facts, builds,
cable test intent, physical units) stay authoritative for their own records; this module
only names what kind of statement each record is, what it can support and what it never
establishes. Nothing is a generic "passed".

| Kind | Meaning | Source today |
|---|---|---|
| `requirement` | Stated need or test intent; satisfies nothing | Frozen cable test plans |
| `source_claim` | Value reported by a citation or registered source, including a manually entered rating; retained, not verified | `source_observation` facts; declared unit registrations |
| `calculation` | Derived by formula and algorithm version from input assertions | `calculation` facts |
| `generated_check` | Tool or recipe receipt over exact retained inputs | Build attempts |
| `review` | Human reviewed association | `reviewed_association` facts |
| `physical_measurement` | Observation of an actual unit with instrument, procedure and time | `measurement` facts on physical-unit subjects only |
| `physical_observation` | Observed or declared status of an actual unit with no instrument or procedure | Unit registrations with `observed`/`measured` status |
| `preference` | Declared choice; not a rating | `preference` facts |

`facts.append` rejects a `measurement` on any subject but a physical unit. A legacy
design-scope measurement row is shown as a declared claim with a warning, never as a
physical measurement. A declared `measured` unit status is a declaration, not a
measurement.

`evidence.list` (HTTP `GET /api/v0/evidence/projects/{id}?kind=...`) merges the sources
newest first with filtering by kind and by fact subject. Each record is authorized
individually; unreadable records are omitted and never counted or named. A scan limit per
source bounds a request and is reported. `evidence.taxonomy` reads the kind definitions.
Items carry subject (design, actual or project scope), statement, status, conditions,
method (instrument, procedure, formula, algorithm version, recipe), provenance basis with
an explicit `independently_verified` flag, and lists of what the kind does and does not
establish. `physical_qualification` is always false.

Not yet mapped (no persisted record to read): interface assessments are computed live
and firmware impact reviews keep their own tools; knowledge notes are context, not
evidence. Applicability or supersession rules, batch/configuration test scope and release
closure belong to later evidence capabilities.
