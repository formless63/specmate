# Engineering history evidence

`history.list` and `GET /api/v0/workspace/history` share a fresh `workspace.read`
projection. Filters select one workspace, an optional definition, actor ID, definition
kind, inclusive timezone-aware date range, evidence source and a page of at most 50.
The actor filter queries only that workspace's evidence; it does not enumerate users.

The default source combines immutable frozen revision events with retained keyed
create/update/freeze receipts from an explicit operation allowlist. These are separate
evidence bases: a freeze may produce both rows. Unkeyed calls, unrelated operation
families and deleted receipts are not a complete audit. Receipt projections select only
reviewed top-level engineering IDs in SQL. Raw results, payloads, request keys,
fingerprints, emails and old content are never exposed.

A receipt with an exact revision links that retained revision. An update/create receipt
without one links the current draft, after its current full content closure is checked;
it does not retain the old draft content or identify its original field values. Every
row's touched identity states whether it names an exact revision or current draft.
Names are current authorized definition labels, not retained historical names.

`source=current_drafts` is an explicitly separate current observation. It reports each
current draft's last updater, update time and current CAS token. Edits can move or remove
these observations while paging; refreshing starts a new observation. This is not
historical before/after content.

Each source fetches at most 100 candidate metadata rows, then the combined scan processes
at most 100 and returns at most 50. Frozen closures are authorized in batches, isolating
denied subgroups; current draft content is freshly authorized. Unauthorized targets are
omitted before their actor, name or identity is returned. There is no hidden total.
Signed actor/filter-bound cursors carry an immutable time anchor and per-source scan
positions, never IDs of omitted records. Current membership and source authority are
checked again on every page, including cursors issued before revocation.

Reads never modify drafts, snapshots or receipts. Future compare, restore into a new
current state, and fork actions must use exact retained identities and preserve frozen
history; none of those mutations is introduced by this read surface.
