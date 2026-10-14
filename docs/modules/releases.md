# Reviewed release closure

`EVD-004` freezes one reviewed closure: the exact revisions, resolved configurations,
dependencies, artifacts and rights of one frozen root, together with every item that is
not established. A release is a workspace item. A project may reference it; the project
never owns it. A release is frozen design state, not manufacturing approval, physical
qualification or permission to distribute; current access and rights still govern every
read, download and export.

## Reused closure

The review composes existing shared reads and does not reimplement them:

- [Coherent export packages](export-packages.md) resolve the root's exact closure, check
  every retained output (preparation document sets, cable test plans, fabrication builds,
  scene drawings, BOM plan) against it and produce the manifest and archive bytes.
- Resolved configurations (CFG-001/002) are read through their own authority. Each must
  target a revision in the closure and must not cite another revision of a pinned
  definition.
- Source pins and rights subjects follow [selected packages](selected-packages.md):
  `design:<revision>` for every pinned revision and `source:<revision>:<path>` for every
  exact source file a pinned revision names, each with its declared rights and an
  explicit `permitted`, `withheld` or `unknown` decision with a stated basis.
- The export package's rights section (declared catalog `rights_status` of every
  representation and source identifier in the closure) is carried as `rights.catalog`,
  read as recorded; nothing is inferred and undeclared revisions are listed separately.
- [Evidence applicability](EVIDENCE.md) (EVD-003) classifies observations against every
  pinned revision. The review records evidence identifiers and statuses only; evidence
  never qualifies the release.

## Operations

All operations go through the shared operation layer for browser, HTTP, MCP and trusted
jobs.

| Operation | Floor | Purpose |
|---|---|---|
| `release.review` | `workspace.read` | Compute the closure, unresolved items, blockers and review SHA-256; writes nothing. |
| `release.create` | `design.freeze` | Freeze the reviewed closure (idempotent). With `project_id`, also needs `project.edit` and adds a project reference. |
| `release.read` | `workspace.read` | The immutable record exactly as approved. |
| `release.list` | `workspace.read` | A workspace's releases, optionally those a project references. |
| `release.verify` | `workspace.read` | Check the record, archive, pins and configurations, and rebuild the stored request. |
| `release.download` | `workspace.read` | The exact retained package archive; also `POST /api/v0/releases/download`. |

A review request is an export package request plus `resolved_configuration_ids` and
`rights_reviews`. `release.create` adds a name, notes, the reviewed SHA-256, an optional
acknowledgement and an optional project context.

## Blockers and unresolved items

Blockers prevent a release: outputs that cite different revisions or quantities, and
configurations that are invalid, target a revision outside the closure or cite another
revision of a pinned definition.

Unresolved items are listed explicitly, each with a stable identifier and category:

| Category | Examples |
|---|---|
| `quantity` | Root quantity in scope unknown. |
| `artifacts` | Unknown output coherence, unresolved BOM items, populations without a registered fabrication output. |
| `configuration` | Unresolved required choices, unknown or not-evaluated constraints, undeclared target. |
| `dependencies` | A source bundle revision named without an exact file. |
| `evidence` | Evidence recorded against an earlier revision (stale), attached only to the definition (unverified), or not reviewed because of scan limits. |
| `rights` | Any subject whose decision is not `permitted`; any declared catalog representation or source identifier whose rights status is `unknown` or `restricted`. |

A release with unresolved items requires an `acknowledgement` with a non-blank reason;
the record keeps that reason with the exact acknowledged identifiers. A database check
refuses an unacknowledged release that has unresolved items.

## Freezing and reconstruction

`release.create` recomputes the review and refuses it (`conflict`) when its SHA-256 no
longer matches what the actor reviewed. The review reports, per pinned revision, a later
revision of its definition when one exists; that later revision is never adopted, and its
appearance changes the review hash, so a new model or pack revision cannot enter a
release silently.

A release stores:

- the canonical record bytes and their SHA-256: the full review (revisions,
  configurations, dependencies, artifacts, rights, evidence, unresolved items), the
  acknowledgement, the releasing actor and request ID;
- the deterministic package archive by content address, verified against its manifest
  before it is stored;
- database rows for every pinned revision (with snapshot SHA-256) and every resolved
  configuration (with resolution SHA-256), so where-used and deletion protection see them.

Database triggers make releases, pins and configuration rows immutable and keep every pin
inside the release workspace. `release.verify` checks the record hash, archive bytes and
manifest, every pinned snapshot and resolution hash, and rebuilds the stored export
request from the same exact pins; an identical manifest shows the release is
reconstructable.

## Later warnings

The approval record is never edited. Later contradictions and security or engineering
warnings (EVD-005) are separate append-only rows that reference a release, optionally a
revision the release pins and an exact source file it names. `release.read` returns them
in `warnings`, beside the unchanged `record`; `release.list` carries `active_warnings`.

| Operation | Floor | Purpose |
|---|---|---|
| `release.warn` | `item.create` | Attach a warning (`contradiction`, `security` or `engineering`; severity `info`, `caution` or `critical`). With `supersedes_id`, replaces an active warning of the same release. |
| `release.withdraw_warning` | `item.create` | Withdraw with a stated reason; only the author or a workspace admin. |
| `release.warnings` | `workspace.read` | Every warning, including superseded and withdrawn ones, with its state. |
| `release.export_warnings` | `workspace.read` | The warnings as a separate canonical JSON file (also `POST /api/v0/releases/warnings-download`). |

Nothing is deleted or edited: database triggers reject updates and deletes, a withdrawal
is its own row, and a superseded warning stays readable. The retained package archive and
its manifest are unchanged; the warnings file is exported beside it and names the release
record hash.

Automatic warnings: when `facts.append` makes a property/context group of a `revision`
subject conflicting for the first time, every release that pins that revision receives an
automatic `contradiction` warning referencing the assertion (once per release and
assertion). Contradictions on occurrence or definition subjects are not yet raised
automatically.
