# Workspace, projects and members

Status: accepted target model. The current implementation still uses per-project
membership and grants; it is replaced as the workspace-collections migration lands.
Semantics are in [DOMAIN](DOMAIN.md#workspace-collections-and-projects) and roles in
[SECURITY](SECURITY.md#workspace-roles).

One workspace holds all engineering records of an installation: its library, sources,
stock, physical units, facts and builds. A person working alone and a team that shares
everything use the same workspace and the same operations. Records are never cloned per
project or per member.

A project is a composition and decision context inside the workspace. It holds its name,
purpose, notes, decisions, reviews, future requirements and releases, and references to
the collection items it uses. Creating a project gives nobody special ownership; every
member sees every project. Archiving a project hides it from default lists and keeps its
history; it never deletes or edits referenced items.

An archived project is read-only (name, purpose and references) until it is unarchived.
`project.delete` is allowed only for the project's creator or a workspace admin, and only
while nothing depends on the project (decisions, notes, reviews, reservations, work and
other project-held records); otherwise it reports the dependent counts and the project
can be archived instead. Deleting a project never deletes or edits a referenced item.

`project.add_reference` and `project.remove_reference` record and retire a project's use
of an item, with its role, under the project's state token. Removal is recorded, not
erased. Creating a definition, source or other record takes no project; a client that
wants the new item used in a project adds the reference as a separate operation.

The installation owner claims the first workspace admin membership and can create local
accounts without email. Account creation does not grant workspace membership.
Passwords are validated and hashed; account creation rejects idempotency keys and never
retains a credential response. Stored usernames use Unicode NFKC normalization before
length and password validation.

`workspace.access` returns the actor's current role and permissions. Only admins receive
the member roster and access-state token. `workspace.set_member` and
`workspace.remove_member` require that token, serialize on the workspace row, reject
stale edits and keep at least one active admin. Keyed outcomes use the workspace
namespace and recheck current administration before replay. Database administrators
retain their direct administration authority.

Workspace reads (`/api/v0/workspace/library`, `/projects`, `/projects/{id}`) list one
collection family at a time with no owning project. Each row reports where it is used:
the projects whose active references name it, floating or pinned to an exact revision.
With a project as navigation context the project's referenced items come first. Every
read is one bounded page served by a fixed number of queries; non-members get NotFound.

The Workspace access panel creates local accounts where permitted and manages members,
roles and explicit `build.execute`/`inventory.manage` grants. Losing membership clears
all private data in the browser and returns to the signed-out-safe state; a role change
refreshes which actions are offered. The server authorizes every action regardless.
