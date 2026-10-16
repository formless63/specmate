# Manual engineering canvas

`EngineeringFlow` is a presentation-only React Flow adapter. `FlowItem` supplies an
opaque node id, title/detail, exact domain-owned port ids and a starting position.
`Edge[]` comes from declared assignments/joints. `onConnect` returns handle ids to the
discipline controller; it never adds an engineering edge by itself. Keyboard/mobile
Add and connection forms call the same discipline controller as drag/drop.

`ManualCanvas` currently adapts Cable0.2: one stock piece and two end stacks. A dragged
Library revision is read under fresh current authority, then reviewed for placement.
Connectors, pinouts, boards and saved end stacks retain exact pins. A body without a
pinout stays incomplete. Shell/hardware Part uses are explicit. Declared inline
components have unknown values and no invented Library Part identity. The controller
preserves existing endpoint ids/labels, stock-end declarations and all hand mappings;
changes may leave unresolved mappings which must be reviewed before Save. No device
port, source/sink role, compatibility, measured continuity or physical qualification
is inferred. Applying a canvas edit only changes the parent working buffer. Explicit
Save/Freeze uses the existing shared operations and original draft state token.

Moving nodes changes session layout only. Browser storage contains numeric positions
under opaque hashes scoped by principal/workspace/definition and draft or exact
revision; it contains no record labels, source bytes, topology or authority. Reset
layout clears these positions; Fit canvas changes only the viewport. Storage failure
falls back to usable session layout. Inactive/denied controllers fence all controls
and portals while preserving private prepared buffers; principal replacement remounts
private state. Held reads cannot apply into a newer buffer or another scope.

The same `EngineeringFlow` view can adapt Harness0.2 sections/segments/endpoints and
explicit joints/breakouts. A multi-section engineering graph belongs to Harness; this
view does not silently convert a cable or create another persisted graph model.

`EngineeringFlow` also accepts optional `selectedId` / `onSelectItem` for a
consumer-owned inspector selection. `initialFocusId` starts at a readable 0.9
zoom around a node; an explicit `initialViewport` takes precedence, and
`onViewportChange` lets the consumer retain numeric pan/zoom in its own scope.
Fit remains an explicit whole-graph overview. None of these presentation fields
change engineering geometry, terminal identities, or saved connections.
