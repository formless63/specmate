# Source, artifact and execution implementation

Keep engineering transactions independent of native subprocess duration. Commit exact
snapshots/attempt/outbox together; dispatch stable workflows afterward. The jobs process
is part of the application codebase, not an alternative persistence layer.

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
