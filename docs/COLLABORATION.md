# Exact changes and internal review

Team review is an optional record of discussion about two explicitly selected frozen
revisions. It does not edit either revision, replace a parent pin, require formal review
at every edit, or approve compatibility, a physical result, distribution or release.
An owner can use the same workflow without assigning collaborators.

`collaboration.compare` compares declared content using deterministic JSON paths.
Missing keys and explicit nulls are distinct, as are booleans and numbers. Array positions
are positions in the captured declarations; equal positions or labels do not establish
feature correspondence. Different definition identities may be compared explicitly, with
that boundary visible. The response retains exact revision IDs, snapshot hashes and
dependency pins; unknown declarations remain unknown. Changes and parents are paginated.

Affected parents are currently authorized snapshots retaining the selected exact pin,
including dependencies captured by typed cable, harness, board, assembly, preparation,
mechanical and firmware contracts. Both the old and candidate sides can be inspected.
This is captured dependency use, not an exhaustive physical-unit, artifact or evidence
impact assessment. Parents are listed from the revisions' workspace only; every member
reads them all, and projects that reference the revision are reported separately by
where-used. Nothing outside the workspace contributes rows, counts or cursors.

## Controlled discussion and provenance

`collaboration.create` captures the exact pair, title, opening basis, explicit workspace
member recipients, an optional project context (the project the review was raised in;
navigation only, never authority) and an optional exact existing knowledge entry. It reuses that knowledge
identity and registered attachment ownership. Later note entries never rewrite the
pinned entry. Append-only review history retains original registered source-file evidence
and rights or an explicit unknown/unverified citation; it is not measured evidence.

`collaboration.respond` appends a comment, recommendation, request for changes, decline,
close or explicit reopen against a compare-and-set token. A conflict preserves the
prepared response. `collaboration.propose_upgrade` appends a separately created exact
upgrade proposal against the same token. Supported proposals use the existing
`revision_upgrades` contracts: later revisions of one definition and explicitly selected
direct assembly occurrences of the owning snapshot. Declared replacement identities and
nested consuming contexts are proposed through `upgrade.propose` with an explicit
reviewer declaration ([revision upgrades](REVISION-UPGRADES.md)); comparison never infers one. Upgrade review,
feature correspondence and application to an explicitly selected/new owning draft remain
separate controlled operations. Frozen consumers are never rewritten by this module.

Mutations use one database transaction for history, notifications and idempotency outcome.
Fresh actor, workspace membership, exact root, source, catalog-origin and historical evidence/proposal
authority precede state/key diagnostics and replay. The stored outcome is independently
authorized before replay even if a changed incoming payload omits its old sources.
Final authority checks reject a closure revoked during a write and roll back its records.
Database guards preserve exact inputs, sequential immutable history and notification
pointers independently of browser validation.

## Internal notifications and authority

Notifications contain only an entry pointer and recipient/read state. Creation occurs
atomically with the relevant review entry for assigned workspace members and the creator
who can currently read its complete closure, excluding the acting author. Protected
labels are resolved on a fresh read; there is no external delivery, polling integration,
email, webhook, or copied private message payload. A recipient can acknowledge only their
own notification. Inbox pages cover the actor's notifications in one workspace;
read state and acknowledgement never constitute engineering approval.

| Action | Current permission and scope |
| --- | --- |
| Compare exact declarations | `workspace.read` in the revisions' workspace; typed closure validation still runs. |
| Read/list team reviews | `workspace.read` in the review's workspace. Lists cover the workspace; an optional `project_id` lists reviews raised in that project first (`in_project`). |
| Open/respond/close/reopen team review | `design.edit` in the review's workspace; a response requires the original expected review token. |
| Propose a separate upgrade | Same review edit authority plus `design.edit` on the exact owning assembly, old/candidate closure and supported proposal validation. |
| Read/list/acknowledge notifications | Recipient-owned record and current workspace membership; acknowledgement requires its original read-state token. |
| Apply an upgrade | Separate existing upgrade authority, correspondence review, owning draft choice and draft/review CAS; no team outcome grants it. |

The reusable panel fences protected comparisons, knowledge, parent labels, history and
inbox while any required authorization is pending, denied or inactive. Prepared values
and original retry intent survive inertly across refresh, focus and tab changes. Fresh
inspection of current history does not silently replace a prepared response's original
CAS token/key. Deliberate latest-state review permits a new token; discard remains
available outside hidden fields. Both exact pins are chosen from the workspace library.
Project-context/principal changes discard the former selection and
late responses cannot revive it. Viewer inspection/recipient acknowledgement remain
separate from engineering review writes. All rendering is escaped text.
