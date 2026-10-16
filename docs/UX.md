# Workshop experience

## Workspace

Specmate opens on Designs. The left rail has nine destinations: Designs, Library, Make,
Jobs, History, Products & releases, Projects, Extensions and Settings. Library has seven
collection tabs: Connectors, Boards, Wire stocks, Parts, Shells & hardware, Kits and
Vocabulary. A new capability belongs in an existing record section, inspector tab or
Advanced entry; it does not add a rail destination or collection tab.

The top edge holds the Specmate home link, current location, item search, appearance
control and account controls. The logo always links to the landing page. System appearance
follows the operating system; Light and Dark are explicit alternatives. Navigation stays
on the left and top. On narrow screens, controls wrap or collapse without hiding the
appearance or account controls; wide engineering tables scroll inside their own regions.

Draw the thing first. A stock opens with its model and section, a connector with its face,
a board with pads and paths, and a device with Scene and Tree. Forms and exact provenance
sit beside the visual in bounded inspectors or record sections. Do not require a diagram
or 3D viewer to be usable before the record can be inspected or edited.

## Library and projects

Library home presents existing attention, unknown values, recent edits and freezes, and
all items. Missing checks never imply success. Unknown-only items are distinguished from
recorded failures. Typed collections offer search, filters, table/gallery views, creation
and links to records. Thumbnails show declared content with unknown geometry visibly
unresolved; they are not a source of new engineering facts.

Items belong to the workspace Library. Projects group references, notes, decisions and
reviews; they do not own copies of Library records. Project chips filter a collection,
while **Use in project…** adds a reference. Creation does not require a project. A project
reference may follow an item or pin an exact revision; opening it preserves that choice.
Project changes retain workspace editor buffers rather than remounting the application.

Record pages separate browsing from editing. Their sections expose relevant properties,
revisions, Where used, reference and rights, evidence, sources and Advanced information.
Exact IDs and paths remain reachable without becoming ordinary form inputs. A draft is
visibly different from a frozen revision. Opening a historical revision never silently
substitutes current content; continuing a draft is a deliberate action.

Connectors includes bodies, pinout variants, device ports and saved end stacks. **Pinouts**
means contact-to-signal assignments; device ports additionally declare the role and facts
of a connection on a device. These remain distinct records even when both show a connector
face. Parts, hardware and kits likewise keep their own meanings and exact references.

## Designing cables and harnesses

Manual construction is a first-class cable entry path. A blank cable can be assembled on
the React Flow canvas by dragging exact Library stock, connectors, pinouts, end stacks,
boards and supported parts into the working design. Wiring is authored by connecting
handles or by the keyboard-accessible manual mapping controls. The optional device-port
recipe is not a prerequisite for creating or wiring a cable.

Canvas placement and engineering content are distinct. Moving a node changes the working
layout, not a physical dimension or electrical fact. New wire mappings change the local
buffer and carry an explicit manual basis. Replacing an existing landing or declaring a
joint requires the corresponding review. Undo/Redo operates on local edits; Save persists
the draft, and Freeze creates immutable content. Dragging never silently saves or freezes.

A cable has its declared stock and two ends. Harnesses represent multiple physical
sections, segments, endpoints, joints and breakouts. A canvas gesture must not silently
turn a cable into a harness or create a parallel graph model. Unknown pinouts, dimensions,
component behavior and unconnected conductors remain visible. A catalog Part reference
alone does not establish terminal correspondence or electrical behavior.

The optional two-device-port path collects ports, end stacks, stock, length and unresolved
questions. Library creation can open in a side sheet and return its exact saved selection.
Requirements are reviewed and frozen explicitly before a wiring proposal is accepted.
Changing a recipe pick invalidates the old proposal; accepted hand edits retain their
basis when a new proposal is reviewed. Proposal success is not physical qualification.

Build, Schematic and Documents are views of the selected design. Selecting a wire carries
the shared probe between applicable views. The cable inspector separates Connection,
Part, Signals, Issues, Notes and Recipe information. Issues distinguish failures from
unknowns and explain their basis. Versions supports exact inspection, comparison and
explicit draft continuation without changing older revisions.

## Boards and devices

Boards combine drawing, pads and paths, populations, source intake, reviewed extraction
and source disagreements in one record. A bought board can have declared geometry and
connectivity without native source files. KiCad-derived content retains its original
source, extraction receipt and exact native identities. A label match alone never proves
that a schematic pin corresponds to a PCB pad.

Devices combine Scene, Tree and Documents with Interfaces, Options, Firmware, Enclosure
and Drawings sections. A scene captured from a saved draft is identified as that draft
and snapshot; it is not presented as a frozen design revision. Capture is explicit. Shared
selection preserves the exact occurrence path, so the second use of a repeated board
remains distinct from the first in scene, tree, board, cable and BOM inspection.

Canonical placement survives open or exploded display arrangements. Display transforms
do not assert physical placement or clearance. Unknown geometry and unresolved interfaces
remain visible. Retained drawings, configurations, firmware and proposals have their own
identities; linking to them must not confuse those identities with the parent device.

## Documents and workshop work

Documents is contextual to a design. Build sheet, continuity specification, BOM, drawing,
labels and applicable formboard views keep the selected exact root visible. Draft previews
are marked UNRELEASED. Print presents the paper output; retained exports preserve their
source pins, generation settings, rights decisions, manifest and receipts. Existing
retained bytes are not regenerated silently when defaults or generator versions change.

Make groups Inventory, Physical units, Material plans, Procurement BOMs and 3D printing.
Jobs groups Builds, Agent runs and Runner availability. A job's receipt and outputs are
inspectable without leaving its list. Disabled or unavailable tools are named truthfully;
a completed run is separate from a passing engineering check or manufacturing approval.

History lists authorized changes with actor, time and touched records, with filters and
record-local inspection. Historical comparison, restore and fork must preserve exact
identities. A future restore must create a new current state and retain the state it
replaces; it must never rewrite a frozen revision or erase the intervening history.

Settings groups document defaults, engineering settings, optional numbering, validation,
people, preferences, system information and webhooks. Numbering starts off until configured.
Extensions groups catalog packs, integrations and agents. Neither ordinary engineering
work nor installation requires financial setup, external AI or a paid service.

## Products and releases

The existing Products & releases rail entry has Families, Lineup and Releases tabs.
Families uses structured fields for option axes, values and exact design variants,
with local buffers, explicit Save and Freeze, and exact historical family selection.
Lineup lists only the latest readable frozen family at its page anchor, with exact
family/design links and unknown declared length shown explicitly. Drafts do not
substitute for frozen lineup records. The Releases tab retains the existing reviewed
release workflow; family freezing never implies approval.

## Links and selection

Canonical routes identify collections and records rather than implementation panels:

```
/designs                                  landing collection
/designs/new                              choose a design kind and starting path
/designs/<object>                         design following its current selection
/library                                  Library home
/library/<collection>/<object>            Library record
/library/<collection>/<object>@<revision>  exact frozen revision number
/designs/<object>@<revision>/~/<path>       exact occurrence, pin or feature path
/projects/<project>                       grouped references and project context
```

Filters and view choices are URL state; optional `project` context is not authority.
Opaque IDs and path segments are encoded. Old area/lens bookmarks are interpreted before
canonical routing, retaining their exact revision and path. Kind-aware routing distinguishes
a design root from a test plan, preparation profile, configuration or retained drawing.
An inaccessible or malformed target shows an unavailable state; it never falls forward
to the current revision or silently chooses a different record.

Back/forward and reload restore the address. Selecting a different item adds a history
entry; moving within the same item and revision can replace the current entry. Sign-out
clears private state. Session expiry retains the address so a new sign-in can reauthorize
it. Relations contributed by loaded modules describe already-authorized data; they do not
grant access or fetch records on their own. Related selections carry words and a reason,
not color alone.

## Editing, authority and evidence

Allow incomplete drafts and useful inspection without a formal review on every edit.
Use compact, specific statements such as “dimension entered manually,” “shield allowance
unknown,” “extraction needs review” and “model is illustrative.” Expand exact provenance
on demand. Review meaningful transitions: adopting matches, changing dependencies,
freezing, releasing and exporting governed content.

Every save has success, conflict and error feedback. A stale edit preserves the local
buffer and offers explicit recovery rather than last-write-wins. Authority failures hide
protected content until access is checked again. A change of principal clears private
buffers; a role change refreshes permissions. Viewers can inspect the same records but
cannot create, edit, save or freeze. Disabled controls explain why, and the server still
authorizes every operation independently.

Unknown is never pass. Declared, derived, observed and not-evaluated facts stay distinct.
Checks and evidence name their exact source state and staleness. A build or renderer
finishing successfully does not establish electrical, mechanical or physical suitability.
Progress indicators use measured stage information where available and do not invent
percentages for opaque native tools.

## Accessibility and idle use

Provide keyboard navigation and editing, readable working labels, explicit units and
non-color-only statuses. Canvas Fit is an overview; authoring needs readable controls and
zoom. Long tables scroll within their panels. Motion honors reduced-motion preferences.
Static viewers render on demand; hidden tabs pause drawing and release unneeded resources.
Heavy viewers and detailed geometry load only when needed.

Installation establishes real ownership; optional synthetic examples are labeled. Tool
cards distinguish enabled, available and unavailable capabilities and show relevant
architecture or download requirements. Tool absence does not block unrelated Library or
review work. Storage, authorization, stale-evidence, job and missing-tool failures have
specific recovery paths.
