# Bodies, pinouts and boundary mappings

The `interfaces` module implements typed content on existing reusable Definitions,
Drafts, Snapshots and Revisions. It introduces no second identity registry.

- `connector_body` owns physical contacts, shell/key roles, family, mating role and
  optional drawing coordinates in millimeters. A drawing's viewing side and optional
  datum/rotation are explicit. Assembly occurrence placement is independent.
- `pinout` pins one exact body revision and assigns logical signal roles, directions,
  declared voltage/current limits, protocol and applicable conditions to contacts.
  Omitted assignments and null values mean unknown. Review records a declared basis;
  review never implies electrical interchangeability.
- `interface_map` pins an assembly revision and external pinout revision. Each declared
  passage identifies an external contact and an internal path of stable occurrence
  IDs, its exact terminal revision and feature ID. Repeated display references do not
  merge paths. Conditions and declaration basis travel with each passage.

`interface.create`, `interface.update`, `interface.snapshot` and `interface.freeze`
use the shared operation transaction, actor/workspace idempotency namespace, current
permission checks and draft concurrency tokens. Creating takes an optional
`workspace_id` (the actor's only workspace when omitted) and never a project. Freeze
requires `design.freeze` (editors by default, or an explicit grant).
`interface.read` and `interface.trace` are live read operations. HTTP read routes are
under `/api/v0/interfaces`; mutation adapters use the normal operations endpoint.

Body/pinout contact targets are checked against their pinned body. Other feature IDs
(such as board pads) retain their exact occurrence/revision address but report
`not_evaluated`; board terminals are declared on typed `board` records (see PCB.md),
not inferred from interface maps. Tracing returns
`declared` or `unknown`, and always reports continuity and compatibility as
`not_evaluated`. It does not infer copper paths, mating, clearance or measurements.

The generic design integration uses `queries.validate_content`,
`queries.dependency_revisions` and `queries.authorize_content`. All interface-bearing
content must receive the same validation and closure authorization through generic
create/update/capture/read paths. Capture derives the exact dependency closure, and
must reject caller-supplied pins that differ. Dedicated module commands also enforce
these checks. Core immutable snapshot/dependency constraints preserve frozen state.

The workspace Connector record uses one retained controller across bodies, pinouts,
device ports and saved end stacks. The body page separates Pinouts from Device ports;
related records open their exact listed revision. New variants, ports and end stacks
copy explicit exact pins into independent local creation buffers. A project filters
collection rows or receives an explicit reference; it never owns the editor.

Source choices use lazy kind-filtered metadata pages. A selected state and its complete
reference closure are reauthorized on activation and focus before retained drawings or
fields become visible. Principal/workspace changes replace retained local sessions.
Multiple editable drafts require an explicit exact draft choice, never catalog order.
Save and freeze use the retained original CAS token and returned successor token.
Feature and operation tests cover two pinouts on one body (INT-001), exact repeated
occurrence addressing (INT-002), current authorization, replay, atomic validation
rollback and concurrent writes. Browser journeys remain integration checkpoints.

`interface.related` and `GET /interfaces/revisions/{body_revision_id}/related` list
bounded connector-record relations for an exact authorized body revision. They return
only names, kinds, exact revision IDs/numbers and the direct body revision pins of
pinouts, device ports and saved end stacks. The page compares those pins with the
selected body revision; a pin to another revision never implies compatibility.

Pages use the latest frozen revision per related definition at a signed page anchor,
ordered by kind and definition ID. The cursor preserves that anchor while every read
rechecks current actor, workspace and complete dependency/source authority. Inaccessible
relations are omitted; candidate scans and returned pages are bounded separately, with
an explicit continuation/scan-limit flag and no hidden total or hidden IDs in cursors.
An optional `kind` filter selects pinouts, ports or end stacks for their own
record sections; signed cursors cannot transfer between filters. A transitive
mating dependency alone is not a direct connector association.
