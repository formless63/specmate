# Notes, decisions and attachment links

KNW-001 keeps one identity for each note, decision or attachment reference and lets it
link to several engineering objects. Code: `backend/src/specmate/knowledge/`,
`frontend/src/features/knowledge/`.

## Identity and history

A knowledge item belongs to one project and has a kind: `note`, `decision` or
`attachment`. Content lives in append-only entries. `knowledge.revise` appends the next
entry under the item's state token (`knowledge-v<n>`); a stale token is a conflict and
nothing is overwritten. Decisions always state `proposed`, `accepted`, `rejected` or
`superseded`; other kinds never carry a decision status. Recording or revising knowledge
is attached information. It does not edit frozen design content, approve a decision's
engineering effect or qualify anything physically.

## Attachments

An attachment references an exact registered source file: bundle revision plus path.
Bytes are uploaded and preserved through the existing source operations
(`source.register_blob`, `source.create_original_bundle`), so the blob keeps its single
project registration, hash, media type and declared rights. Attachments must be
registered in the item's project; the database rejects any other reference. Several
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

Creating, revising, linking and unlinking require `design.edit` in the item's project and
current read access to every attachment closure. Creating or adding links requires
current read of the supplied targets; removing a link requires current read of that
link's target. A hidden existing foreign link does not prevent reading or revising an
otherwise authorized owned note. Reads require project
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
- `GET /api/v0/knowledge/projects/{project_id}/items`, `GET /api/v0/knowledge/items/{item_id}`

## Limits

Previews are not rendered; attachments download as inert bytes. Rich-text collaboration,
search, notifications and review workflows are KNW-002/KNW-003 scope. The panel chooses
targets with a picker; discipline views can embed `KnowledgePanel` with a fixed `target`
for their current selection. Global navigation mounting is left to integration.

The reusable panel accepts `principalKey` and `onAccessLost` from its workspace.
Project, principal, permission and fixed-target changes discard retained results and
prepared inputs. Current-authority refreshes hide cached target, item and attachment
results while requests are pending or denied. An open editor keeps its own staged
title, text, attachment references and declared rights inert during a transient
source/target denial. It keeps the exact state token from when editing began; a
newly read entry cannot silently advance that token. Choosing a new edit basis is
deliberate. An uncertain mutation retries the same payload and idempotency key.
Uploads stop before a later source-registration step if their workspace changes.

Local definition choices use the existing authorized project-metadata listing.
Offering a local definition name is separate from resolving its complete target
closure: deliberate inspection can report that a target is unavailable. Denied
knowledge target and link results retain no cached target labels. A readable item
owned by another project can be inspected from a linked target, but content and
link editing are offered only in that item's owning project workspace. Server
permissions remain authoritative for each mutation and download.
