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

The React `InterfacePanel(projectId)` exposes creation, editing, freezing, inspection
and declared trace. The application shell supplies the authenticated session and
project. Feature and operation tests cover the two pinouts on one body (INT-001),
exact repeated occurrence addressing (INT-002), strict failures, current authorization,
replay, atomic validation rollback and concurrent writes. Integrated generic hooks,
root navigation and browser journeys are integration checkpoint obligations.
