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
