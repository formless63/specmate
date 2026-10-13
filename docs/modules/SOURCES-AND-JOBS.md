# Source, artifact and execution implementation

Keep engineering transactions independent of native subprocess duration. Commit exact
snapshots/attempt/outbox together; dispatch stable workflows afterward. The jobs process
is part of the application codebase, not an alternative persistence layer.

The implemented foundation uses `build.request` with an immutable source-bundle revision
and an operator-approved single-stage recipe. Its asynchronous result identifies a
durable build and outbox. Temporal dispatch uses a stable workflow ID with duplicate
reuse rejected; short activities use the shared Django operation layer. Recipes and
source identities are preserved in application records, and workflow history carries IDs.

Runner credentials are issued locally by the installation operator and restricted to
one project and a list of approved recipes. Only the matching fenced stage may download
inputs or register output bytes. A recipe's execution limits and manifest paths must be
supported before a build is accepted. Changes to current authority or recipe approval
prevent further execution and successful result acceptance.

An expired lease becomes interrupted and requires reconciliation of the original
execution. The foundation does not reassign it or automatically rerun a tool; a new
build request creates a distinct attempt while prior evidence remains immutable.
Successful output is available only after verified terminal acceptance and a current
project access check. Mixed source-rights policies and artifact caching remain future
capabilities; matching hashes alone grant no disclosure permission.

## Pipeline

Preserve/import source -> extract -> review -> generate/modify -> validate/route/compile ->
convert/render -> package. Recipes can omit irrelevant stages. Each stage declares exact
inputs, outputs, tool pack, permissions, resources and recoverable state boundaries.
A successful parse is not a reviewed association; a successful package is not a release.

## Blob protocol

Stage uploads with size/hash limits. Verify before immutable promotion and record database
references. Coordinate DB commits, staged bytes and cleanup so a committed source reference
cannot silently point to missing bytes. Treat orphan cleanup as a bounded reconciliation
process, never arbitrary filesystem deletion. Cache hashes do not bypass access/rights.

## Native runner

Lease scoped work through the application boundary, stage only allowed inputs, launch
approved pinned images, heartbeat and report receipts. Use a fencing token so an old runner
cannot publish after reassignment. Reconcile a lost receipt before repeating work. Actual
process termination establishes cancellation. Retain useful incomplete artifacts honestly.

## Acceptance emphasis

Crash at commit/dispatch, lease/run, write/receipt and accept/cleanup boundaries. Exercise
actual tool failure and cancellation, not only test doubles. Restore the app/bytes/workflow
boundary consistently and suspend external actions until authorized. No separate init or
migration container is required to bootstrap the early deployment.


Source manifests reject case-insensitive duplicates and file/directory collisions
before committing an original or revised bundle. Shared directory prefixes remain
valid. Blob lookup is bounded to the requested hashes within the owning project.
Imported archive bytes remain inert: there is no automatic decompression or link
reconstruction, and this does not establish hostile archive extraction safety.
