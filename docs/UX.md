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

## Links and selection

Status: implemented for the shell, library lists and the scene-based discipline views (shared
scene, and the contextual tree, board, cable, scene, inspector, schematic and BOM views); other
panels join by contributing relations and reading the probe.

Items are addressed in the workspace, never through an owning project. One URL carries the
area, lens, optional project context and the probe (the shared selection):

```
/                                       Project area, Overview lens, Library scope
/<area>                                 an area at its default (first) lens
/<area>/<object>                        probe on a workspace item, following its latest revision
/<area>/<object>@<rev>                  probe on an exact frozen revision number
/<area>/<object>@<rev>/~/<seg>/<seg>    probe on a path inside the item (occurrence, pin, feature)
  ?lens=<tool>                          lens, omitted when it is the area's default
  &project=<project id>                 optional navigation context
```

- `<object>` is an opaque workspace record id of any library family; path segments are
  percent-encoded. A lens named for another area selects that area; unknown areas or lenses
  fall back to defaults and the address is rewritten to its canonical form in place.
- Back/forward and reload restore area, lens, scope and selection. Area, lens, scope and a
  newly selected item are history entries; moving to another path inside the same item and
  revision replaces the current entry. Explicit sign-out clears the address; an expired
  session keeps it so signing in again resumes the link.
- Authorization stays on the server. The probe is resolved with
  `GET /api/v0/workspace/library/{record_id}`, which answers alike for missing items and items
  outside the member's workspace. A target that cannot be read, or an address that is not
  well formed, shows "Selection not available" without naming the target. A project context
  the workspace does not have returns to Library scope with a plain note that does not name it.
- The probe is shared by tree rows, tables, diagrams and the inspector. Selecting in any of
  them selects everywhere; a library row stands for the whole item, so any revision or path
  of it marks the row selected. The selection header shows one fact per cell: the item,
  kind, revision (exact, latest or draft only, unknown hatched), path, use count and related
  count.
- Relations come from a registry that modules contribute to while they are mounted
  (`features/probe`). Every address has built-in containment (a path is contained by its
  ancestors and its item; an exact revision belongs to its item). A view marks related
  targets with a rule and a "related" tag, not color alone. Contributors describe records
  already read; they never fetch or authorize.
- Scene uses are probe targets: the object is the assembly the scene was frozen from, the path is
  the occurrence path, and a stable feature (component, pad, endpoint) is one last segment marked
  `#`. Each repeated use keeps its own path, so selecting the second of two identical boards
  selects only that use in every connected view and in the URL, and opening the link selects it
  back. The scene contributes the other end of declared relationships (electrical, mating,
  mounting, ...) and nested uses as related; a selected feature relates only exact feature ends.
- The Design area's PCB lens lists boards and board populations from the workspace library;
  PCB intake (one native source) stays below the list at project scope.

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
