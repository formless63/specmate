# Cable recipes and frozen connection discovery

`cable.connections` and `GET /api/v0/cables/connections` list **Frozen designs
connecting these ports**. The caller chooses two exact device-port revisions. Bare
pinouts are different records and are not accepted as device ports by this read.

The result contains the latest frozen revision of each matching cable definition at
a signed page anchor. It uses the cable's exact retained intent, including its exact
port pins; it never substitutes a newer intent or port. Both orientations are accepted
and returned explicitly. Designs pinning older revisions of the same port definitions
are marked separately from exact selected pins. When both selected ends are the same
port definition and old pins cannot establish direction, orientation says
`same_port_definition`. Matching never establishes electrical or physical compatibility.

Drafts, cables without a retained intent, and inaccessible closures are omitted. An
empty page does not establish the absence of all designs. The service checks current
workspace and full cable → intent → port/source authority before exposing any row's
metadata. GET responses are private and not stored by HTTP caches. The shared operation
is a fresh read, with no idempotency key or engineering mutation.

SQL restricts candidates to the workspace, latest frozen cable state and a pinned intent
with the selected port definition pair. It selects at most 51 metadata rows, scans at
most 50, and returns at most 50. Only bounded authorized snapshot and exact intent bytes
are decoded; no whole-library content scan or per-row inspection loop is used. There
are no hidden totals. Cursors bind actor, workspace, exact ordered selected port pair
and time anchor, expire after one day, and obtain fresh closure authority on every page.
Newer freezes after the anchor do not move an in-progress page to another revision.

## Optional recipe authoring

New design offers cable, harness, device, board and printed-part forms. Cable starts
include a blank/freeform form and an optional two-device-port recipe. Opening a form,
changing picks, or reading proposals does not create a cable. Device ports and pinout
variants remain distinct exact records.

The recipe bar uses bounded Library pickers for exact ports, end stacks and stock.
New port/stack side sheets retain partial local forms when closed; only an explicitly
successful freeze returns its exact revision to the caller. Saving a draft alone does
not select an invented revision. Principal/workspace replacement clears private forms;
inactive sheets hide their portals immediately.

Connection requirements are reviewed before freezing a separate recipe record. The
returned exact intent revision drives the wiring proposal. Apply is deliberate: existing
manual landings and reasons remain unless checked replacements have explicit reasons.
Stock-only re-proposal preserves endpoint identities, labels, stock ends and unrelated
length fields. New cable edits made while a proposal is pending withdraw Apply until a
new proposal is requested. Saving the cable is a separate explicit operation.

Designs also offers a bounded Development needs view. Need records have no invented
accept/decline state; enclosure proposal decisions use their existing purpose-specific
workflow. Exact recipe record links remain available for inspection, including historic
revision and occurrence paths; the former standalone Cable intents navigation is hidden.
