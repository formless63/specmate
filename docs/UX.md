# Workshop experience

## Workspace

Provide one workspace shell with an assembly/library tree, a central selected view and a
context inspector. Views include composition/interface diagram, cable/stock, board,
mechanical scene, sources, BOM/preparation, checks and physical records. Shared contextual
selection is the invariant; not every discipline must use the same renderer.

A selected occurrence stays selected through filtering, grouping, view switches and
exploded arrangements. A board definition view and a board occurrence view are different
contexts, visibly labelled. A reusable cable can be opened without loading its parent device.

## Library and project scope

Status: accepted target model for the shell; earlier per-project gating is being replaced.

Signing in lands inside the one application shell (top bar, area rail, context header,
lenses, status line); there is no pre-project gate. The top bar's scope control selects
**Library** (the whole workspace) or one project, and is searchable. Every area is
reachable at both scopes. Scope changes navigation and filtering only, never access.

- At Library scope each lens lists its workspace collection in a dense, paginated table
  (kind/role, name, latest frozen revision, and the projects that reference it), with
  kind and text filters. Lists are served by bounded single queries; the browser never
  fans out per project.
- At project scope a library lens shows the items that project references first, with a
  visible control to show the whole library. The Project area shows the project overview:
  its purpose, notes, decisions, reviews and its references grouped by area, each opening
  the item in its own lens. Counts are counts of references, not of owned records.
- Creating an item never asks for a target project; it is added to the library. At project
  scope the create form offers **Use in this project** (on by default), which adds a
  reference after the item exists. Every library item offers **Use in project…** to add a
  reference to a chosen project and shows where it is used.
- Selecting an item keeps the current scope, area and lens. Opening a referenced item from a
  project keeps that project as context. Lenses that work on project-held records (project
  notes and decisions, references, releases) show an inline project chooser at Library scope.
- Actions the member's role does not permit are shown disabled with the reason (for example
  "Editors can freeze"); the server still authorizes each action. Nothing opens a project
  automatically after sign-in. Sign-out, session expiry, loss of membership or a role change
  clear or refresh private data and return to a safe state with a plain explanation.

## Editing and evidence

Allow incomplete drafts and useful output without requiring a formal review at every edit.
Show compact statements such as 'dimension entered manually', 'shield allowance unknown',
'extraction needs review' and 'model is illustrative'. Expand provenance on demand. Never
make an unknown look like a validated default. Review at meaningful transitions: accepting
matches, freezing, changing dependencies, releasing or publishing.

Every edit has save/conflict/error feedback. A stale edit offers an inspectable comparison,
not last-write-wins. Show what operation is running, its source snapshot, progress where
known, and safe cancellation. Do not invent precise progress for opaque native tools.
A completed build is labelled separately from check results and physical qualification.

## Entry journeys

Stock: construction/profile, declared dimensions/colors, source references, cross-section,
preview, specification. No project-wide assembly setup required.

Cable: purpose/endpoints, stock/body/pinout candidates, topology, preparation, routes and
lengths, tests, review, coherent package. Keep coax layer/pigtail controls from useful prior
implementations. Advanced profile editing is available but ordinary edits use forms.

Board: upload or source-authoring handoff, preserved original, extraction report, association
review, population/ports/models, checks and fabrication output. Show schematic/PCB conflicts.

Device: reuse boards, place enclosure/hardware/harnesses, align interfaces, trace wiring,
inspect geometry limitations and configuration differences. Canonical placement survives
open/exploded display modes. Change review identifies affected parents/artifacts/evidence.

Workshop: choose contents/procurement/consumables view, availability/reservations, make/buy,
bench package, actual unit/batch consumption and observations. Hide irrelevant costing when
not configured. Do not require financial setup.

Agent: show allowed actions/budget/checkpoints, draft proposals, missing facts, execution
requests and a reviewable change/result summary. Built-in chat is optional; external MCP
agents use the same operations. Never make chat the only route to a feature.

## Accessibility and idle use

Keyboard-accessible forms/navigation, readable labels and tables, non-color-only statuses,
units and contextual help are acceptance requirements. Do not depend solely on a 3D scene
for selecting a feature. Browser rendering is on-demand for static scenes; pause hidden tabs
and dispose unused buffers/workers. Lazy-load heavy viewers and detailed geometry.

## Installation and diagnostics

First use establishes ownership, not a demo pretending to be real hardware. Synthetic
examples are labelled and optional. Tool capability cards show enabled/available/unavailable,
architecture and download requirements. Tool absence does not block unrelated library or
review work. Storage, permission, job, stale-evidence and missing-tool failures have distinct
recovery paths.
