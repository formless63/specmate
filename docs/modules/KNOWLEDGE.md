# Notes, decisions and attachment links

KNW-001 keeps one identity for each note, decision or attachment reference and lets it
link to several engineering objects. Code: `backend/src/specmate/knowledge/`,
`frontend/src/features/knowledge/`.

## Identity and history

A knowledge item is held by the workspace and has a kind: `note`, `decision` or
`attachment`. Content lives in append-only entries. `knowledge.revise` appends the next
entry under the item's state token (`knowledge-v<n>`); a stale token is a conflict and
nothing is overwritten. Decisions always state `proposed`, `accepted`, `rejected` or
`superseded`; other kinds never carry a decision status. Recording or revising knowledge
is attached information. It does not edit frozen design content, approve a decision's
engineering effect or qualify anything physically.

## Project context

A project does not own knowledge items. `knowledge.create` takes `workspace_id` and an
optional `project_id`. With a project, the item is a note or decision held by that project
(its context, never its owner); without one, it is a library note about the items it
links. The project must belong to the same workspace, otherwise it is not found. Library
notes and project notes are both visible to every workspace member, and
`knowledge.list` / `knowledge.search` take an optional `project_id` filter.

## Attachments

An attachment references an exact registered source file: bundle revision plus path.
Bytes are uploaded and preserved through the existing source operations
(`source.register_blob`, `source.create_original_bundle`), so the blob keeps its single
workspace registration, hash, media type and declared rights. Attachments must be
registered in the item's workspace; the database rejects any other reference. Several
items and entries can reference the same file without another blob registration.
Downloads use the existing source file route and its current closure checks.

## Links

A link addresses one exact target using the facts target contract: project, definition,
exact revision, contextual occurrence (root assembly snapshot plus local ID path) or one
actual physical unit. A definition, each of its revisions, each occurrence of a reused
revision and each serialized unit are separate targets. An optional feature ID is kept
exactly and reported as `not_evaluated`.

`knowledge.link` is idempotent per active exact target. `knowledge.unlink` records who
removed a link, when and why. It never deletes the item, its attachments, the
referenced bytes or other links; removed links stay in item history and the same
target can be linked again as a new link. The database rejects link deletion, a second
removal and any other link update.

## Authority and disclosure

Creating requires `item.create`. Revising, linking and unlinking require `design.edit`,
or authorship of the item (contributors edit the notes they created), in the item's
workspace and
current read access to every attachment closure. Creating or adding links requires
current read of the supplied targets; removing a link requires current read of that
link's target. A hidden existing foreign link does not prevent reading or revising an
otherwise authorized owned note. Reads require workspace
read access and current source closure for every entry's attachments, including
historical entries. Each link target is re-resolved under the reader's current access.
Targets the reader cannot see are omitted from item reads: no name, identifier, kind or
count is returned. `knowledge.for_target` resolves the exact target first and lists only
items the reader can read, again without counting hidden items. A link whose target the
actor cannot read cannot be removed by ID. Idempotent replays re-check current authority
over the stored item and the payload's targets. Before returning an immutable item
receipt, replay also authorizes every target named in its stored active and removed
links. A receipt with now-forbidden target metadata is unavailable; a fresh owned-item
read still filters those links. Restoration permits exact receipt replay without
rewriting history or appending another entry.

## Operations and reads

- `knowledge.create`, `knowledge.revise`, `knowledge.link`, `knowledge.unlink`
- `knowledge.read`, `knowledge.for_target`, `knowledge.list`
- `knowledge.search`, `knowledge.preview` (fresh reads without idempotency receipts)
- `GET /api/v0/knowledge/search`, `GET /api/v0/knowledge/preview`
- `GET /api/v0/knowledge/workspaces/{workspace_id}/items[?project_id=]`, `GET /api/v0/knowledge/items/{item_id}`

## Limits

Collaboration, notifications and review workflows are separate KNW-002 scope. The panel chooses
targets with a picker; discipline views can embed `KnowledgePanel` with a fixed `target`
for their current selection. The development workspace mounts it lazily in the
Notes & files tab with the current principal and workspace permissions.

The reusable panel accepts `principalKey` and `onAccessLost` from its workspace.
Workspace, project, principal, permission and fixed-target changes discard retained results and
prepared inputs. Current-authority refreshes hide cached target, item and attachment
results while requests are pending or denied. An open editor keeps its own staged
title, text, attachment references and declared rights inert during a transient
source/target denial. It keeps the exact state token from when editing began; a
newly read entry cannot silently advance that token. Choosing a new edit basis is
deliberate. An uncertain mutation retries the same payload and idempotency key.
Uploads stop before a later source-registration step if their workspace changes.

Local definition choices use the existing authorized definition listing.
Offering a local definition name is separate from resolving its complete target
closure: deliberate inspection can report that a target is unavailable. Denied
knowledge target and link results retain no cached target labels. A readable item
held by another workspace can be inspected from a linked target, but content and
link editing are offered only in that item's own workspace. Server
permissions remain authoritative for each mutation and download.

## Permitted search and safe previews (KNW-003)

Search matches literal case-insensitive substrings in titles, note/decision bodies and
attachment labels, paths, source bundle names, media types, rights and hashes. Registered
file contents are not indexed. Current entries are the default; historical entries are
an explicit option. Optional workspace, project, kind and exact target filters share the existing
target resolver. Results identify the exact item and entry, current/historical state,
visible links and registered source provenance. Plain snippets are bounded to 320
characters plus ellipses, with at most five matching fields. Pages contain at most 50
permitted entries and no totals. Cursors name only disclosed entries and are rechecked
under current authority. Hidden entries supply no snippets, counts or cursor identity.
Historical attachment closure is checked before deriving any result and again before
returning the page. Access lost during rendering fails that request closed; the next
search uses normal filtering. Foreign links are
filtered independently without hiding an otherwise readable owned note.

Preview resolves the exact item, entry, source revision and path under a fresh actor
and full historical source authority. It reads at most 2 MiB and independently checks
registered size and SHA-256 before interpreting bytes. Larger originals are explicitly
`download_only` with integrity `not_read_for_preview`; supported-size originals report
the verified original hash even when their format remains download-only. Preview never
changes the original, its single blob registration, ownership, rights or entry history.

- UTF-8 text, Markdown, CSV, JSON and log files use a narrow media-type/extension allowlist,
  at most 128 KiB, with control-character rejection. They render as escaped plain text;
  Markdown, HTML-like text and JSON are never interpreted or executed.
- PNG preview accepts noninterlaced 8-bit grayscale/RGB with optional alpha channels,
  at most 2048 pixels per axis and 1,048,576 pixels. Every chunk CRC and the complete
  bounded decompressed scanline stream must validate. Palette, animation, keyed
  transparency, unknown critical chunks and unsupported variants remain download-only.
  The versioned preview derivative strips ancillary metadata and retains the pixel
  stream in a fresh minimal PNG; it may therefore differ in color presentation. It
  reports separate original and preview hashes, dimensions and transformation version.
- Classic ZIP preview reuses source archive path and format safeguards, limits listing
  to 100 members and 8 MiB total uncompressed bytes, and streams each member to verify
  its size/CRC. Only inert paths and sizes are displayed; nothing is extracted, executed
  or registered as another original.

HTML, SVG, PDF, code, native files, unsupported images and oversized inputs are visibly
download-only. These previews establish neither document trust nor engineering or
physical qualification. The browser independently checks returned text/PNG byte sizes
and preview hashes and verifies their exact selected attachment identity before display.
The original download remains protected by the existing current source closure.

`KnowledgeSearchPanel` takes `workspaceId`, an optional `projectId`, `principalKey` and
`active`; retained hosts must pass their actual active-tab state. Scope/principal changes clear the workspace.
Inactive, window-blurred and hidden states abort requests and hide protected results;
return/focus performs fresh authorization. Pending or denied reads hide old metadata and
previews while preserving the typed query. PNG object URLs are revoked when hidden,
replaced or unmounted. The panel requires only read permissions.
