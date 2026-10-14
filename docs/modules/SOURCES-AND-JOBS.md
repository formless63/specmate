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

## Cancellation, recovery and retry

`build.cancel` only records a request (`cancellation_requested`). A stage becomes
`cancelled` solely when its runner reports that the actual container was stopped, and the
application refuses a `cancelled` receipt, and a database constraint refuses a cancelled
stage, unless a cancellation was requested first. Revoking a runner or authority also only
requests cancellation. A persisted tool failure or exit code is never rewritten as a
cancellation by the runner; a success that cannot be accepted after a cancellation request
is reported as cancelled with its observed exit code. A runner shutdown stops the container
and reports a failure, not a cancellation. If the container cannot be confirmed stopped, no
receipt is reported and the durable local receipt waits for reconciliation.

The workflow keeps polling `interrupted` stages (more slowly) until a final receipt exists,
so later expiry or revocation is still observed. Nothing relaunches an interrupted stage.
If the leasing runner credential is revoked or expired, nothing can reconcile or confirm
termination; `build.abandon` (requires the state token, an idempotency key and a stated
basis, from the requester or a member with execution authority) then resolves the stage as
`failed` with `termination_confirmed: false` and the resolution
`abandoned_unreconciled`. It is refused while the credential is still valid, for work that
never started (cancel it instead) and for stages that already have a receipt. Verified
outputs uploaded before the resolution are retained as evidence only and have no download.

`build.retry` starts a new attempt for a `failed` or `cancelled` stage: a new build
identity and workflow over the same source revision and the same approved recipe
(a changed recipe approval is refused and needs a deliberate new request). It requires the
prior stage's state token and an idempotency key, current execution authority and passes
the same compiler-consent hook as `build.request`, so firmware compiler builds still need
`firmware_build.request`. At most one retry may follow an attempt; a second request reports
the first. The earlier attempt, its receipt and its events are never changed.
`build.history` returns the retained events (without runner identities or fencing tokens),
receipt, unaccepted partial outputs, retry lineage and which actions are available;
`build.list` lists a project's latest generic builds. The Builds tool in the Sources area
uses these. Real container cancellation, restart reconciliation and lost-acknowledgment
replay through the runner remain covered by the runner's isolated Docker cases and an
orchestrated integration checkpoint; the application tests simulate the runner API.

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
reconstruction. The separately invoked bounded ZIP derivation below is the only
implemented expansion path; other formats remain opaque.

## Deliberate ZIP derivation

The Sources panel first preserves an uploaded file as an original bundle. Its separate
`source.expand_zip` command selects an exact original revision and path, with explicit
`format: "zip"`, to create a distinct derivative. Rejection leaves the original intact.
The immutable expansion record pins the exact archive file and parser identity; the
manifest pins member hashes and parent revision. Member rights inherit the archive's
**declared** rights, including unknown; this does not verify licensing. Reopening shows
that exact provenance. A plain derivative or later edited revision does not claim to be
fresh parser output. Current project/blob/parent closure is checked before diagnostics,
expansion, replay, source inspection and downloads. No state token is required to create
a new derivative from an immutable revision; revising a bundle still uses its state token.

The `specmate-classic-zip-v1` parser supports classic single-disk stored/deflated ZIPs
with DOS or Unix creators. It rejects encrypted entries, links/special files, ZIP64,
data descriptors, unknown flags and metadata extensions, path traversal and inconsistent
local/central records. Supported timestamp and uid/gid metadata are ignored, not restored.
Input is bounded to 16 MiB, central metadata to 1 MiB, entries to 1000, individual expanded
members to 16 MiB, total expansion to 64 MiB, ratio to 200:1 and file depth to 32.
Declared limits are checked before decompression; each output allocation is bounded and
actual size, complete deflate stream and CRC must match before a derivative is accepted.

Members stream only into application-owned content-addressed staging, never paths chosen
by the archive. No nested archives are expanded. Safe unknown file formats and scripts
remain inert octet-stream bytes; no file permissions, links or execution authority are
restored. Explicit empty directories are validated but omitted from the file-only manifest.
Original bytes retain all original metadata. If persistence fails after blob promotion,
unreferenced blobs can remain for the existing bounded reconciliation process; engineering
rows and idempotency outcomes roll back together.

These explicit limits intentionally reject some valid ZIP files. Other archive formats
can be preserved but have no expansion operation. Bounded in-process parsing does not
establish general hostile-format isolation or qualification of native tools and previews.

## Native editing handoff

Native sources can be edited with their own tools outside Specmate without Git.
`GET /api/v0/sources/revisions/{id}/handoff` exports an exact revision as a deterministic
classic stored ZIP: the files at their manifest paths plus a reserved root
`SPECMATE-HANDOFF.json` naming the baseline revision, manifest hash, file hashes and
declared rights. The current revision closure is authorized first; project readers may
export. Export refuses revisions that already use the reserved name or exceed the
re-entry limits above, and verifies stored bytes before writing them.

Edited files return through two shared operations, listed in the operation catalog and
used by the Sources panel, HTTP command API and trusted jobs alike:

- `source.preview_edit` reviews edited input against the selected baseline without
  changing state or promoting bytes. Input is either `files` (paths and hashes of bytes
  already registered in the baseline's project, for example a browser folder upload) or
  `archive` (a ZIP first preserved as its own original and parsed by the bounded parser
  above). It reports every path as added, modified, rights changed, unchanged, removed or
  excluded with old and new hashes, the baseline bundle's current head and state token,
  and a `review_sha256` over the exact change set.
- `source.submit_edit` requires that state token as `expected_state` and the reviewed hash.
  It recomputes the change set and conflicts if either differs, so only the reviewed
  bytes, paths, rights and exclusions can be recorded.

The marker is optional and grants nothing. When present it must name the selected
baseline; a marker from another revision is a conflict, never a silent rebase. If it sits
in one top-level folder that contains every file, that folder is treated as the root.
The marker itself is never stored. Exclusions are explicit; common operating-system and
editor by-products are suggested for exclusion but never dropped silently.

Unchanged and modified paths keep the baseline's declared rights unless the submitter
declares otherwise; added paths require a declaration, which may be `unknown`. Media types
of existing paths are retained; new files are inert octet-stream bytes.

Targets never merge or overwrite. `new_derivative` creates a separate derivative bundle
whose `derived_from` is the baseline; a stale baseline is allowed only after reviewing it
against the current head token, and later revisions remain untouched. `next_revision`
appends to a derivative bundle only when the baseline is still its head; originals are
never revised by edits. Concurrent submissions from the same baseline therefore produce
one next revision and a conflict, after which the other edit can be reviewed again and
kept as a separate derivative. An immutable `SourceEditSubmission` pins the baseline,
optional preserved archive file and parser, marker outcome, root folder, review hash and
summary; revision detail shows it. Baseline and archive revisions join the source closure
checked before diagnostics, retained idempotency outcomes, inspection and downloads.

Re-entry is not native validation, conversion, regeneration or physical qualification.
Specmate does not interpret the edited formats, detect semantic conflicts inside native
files, or reconcile parallel edits; reconciling two derivatives is a later explicit edit.

## Concurrent source authoring

Every write that appends to an existing bundle, `source.revise_bundle` and
`source.submit_edit` with either target, takes the bundle row lock and rereads the head
under it before comparing the caller's `expected_state` (`bundle-r<n>`). Two writers from
one base therefore produce exactly one new revision; the other receives a conflict that
names the current head revision, number and manifest hash. Nothing is merged,
overwritten or reordered, and earlier revisions stay immutable. Separate derivatives from
an immutable revision need no lock.

A conflict loses no writer data. Registered bytes and preserved uploaded archives were
committed before the attempt and remain in the project; staged archive members are
discarded and can be regenerated from the preserved archive. A conflicted request stores
no idempotency outcome, so the same key may carry a deliberate retry with the reported
state. A completed keyed request replays its retained result instead of writing again,
including a duplicate sent concurrently, after current authority is rechecked.

Before any stale-state detail, retained outcome or keyed mismatch is disclosed, the
current head's complete source closure is authorized with source registration
permission; a retained result is authorized against its produced revision as well.
Direct source reads refresh the current actor.

Recovery is a fresh, deliberate review. An agent rereads the head and resubmits its
complete file list with the new state. In the Sources panel a conflicted submission keeps
the prepared upload, per-file rights, exclusions, target, name and summary visible; submit
stays disabled until the writer reviews again against the current state. A next-revision
target that is no longer available must be chosen again rather than silently becoming a
separate derivative. Reviewing edited files against the winning revision instead of their
exported baseline requires deliberately omitting the handoff marker, and the review then
shows exactly which of the winner's files the submission would replace. Each reviewed
submission reuses one idempotency key, so retrying after a lost response replays rather
than duplicating. Specmate never merges opaque native files.

## Explicit property authority

A governed native property has exactly one designated owner: an exact `.kicad_pcb`
path in one source bundle. The first supported property is `pcb.board_outline`, the
Edge.Cuts outline and cutouts extracted by `kicad-intake-v1`. Specmate stores no editable
copy of an owned property. Its value is only a reconciled projection of an accepted
extraction, and it is never edited as a table.

- `source_property.declare` designates the owner from the bundle's current revision and
  records an immutable owner change. Only one authority may exist for a property and path
  within a source lineage: the original bundle and every bundle derived from it, by
  derivation, expansion or reviewed edits. A fork or another file cannot become a second
  owner. An original can own a property read-only; editing it needs a derived working copy.
- An outline edit goes through the owner. Export its current revision, edit it natively,
  and submit the reviewed edit as that derivative's next revision. Then extract the new
  revision through the PCB intake, accept the successful report, and reconcile.
- `source_property.reconcile` takes the authority state token (`authority-v<n>`) and pins
  one accepted interpretation. It must be of the owner's current revision and exact file
  bytes, produced by the declared adapter. It locks the owner bundle so the head cannot
  move during reconciliation. An extraction of a fork or other bundle is refused and stays
  listed as preserved, non-authoritative evidence. If accepted extractions of the current
  revision disagree, nothing is chosen. Unsupported outline coverage becomes an explicit
  unknown projection; a previous outline is never carried forward as current.
- `source_property.transfer` moves ownership only to the current revision of another
  bundle in the same lineage that contains the current owner's latest revision in its
  exact manifest ancestry. A transfer leaves the projection stale until reconciled.
- `source_property.read`, `GET /api/v0/pcb/projects/{id}/property-authorities` and
  `GET /api/v0/pcb/property-authorities/{id}` report the owner, its current revision and
  file hash. They also report the status (`unreconciled`, `current`, `stale` or
  `conflicting`), the current projection with source revision, path, file hash, report
  hash, interpretation, build, adapter and tool pins, and a summary of the change from
  the previous projection. Accepted extractions of the head, preserved non-owner
  evidence, immutable projection history and owner changes are listed too.

Projections and owner changes are immutable; database triggers validate their owner and
extraction provenance and allow an authority row to change only its owner and version.
Every operation authorizes the owner's current source closure and every projected or
previous owner revision before diagnostics; retained keyed outcomes are authorized before
a changed-payload conflict. Direct reads refresh the current actor. The Sources panel
loads property authorities on request, routes outline edits to the owner revision and
its editing handoff, and offers deliberate reconciliation or transfer with a basis.
Reconciliation is not native validation, fabrication approval or physical qualification.
Other properties, other native formats and arcs or curved outlines remain unsupported.
