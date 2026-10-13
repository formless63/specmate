# Personal and team projects

A project is a private scope for the same definitions, sources, inventories and builds.
Creating one gives its creator project ownership. Adding a local account to a project
shares these records through membership; it does not clone an engineering model.

Viewers read authorized records. Editors also edit drafts and register sources.
Freezing, native execution and inventory management require separate explicit grants.
Project owners hold all project permissions. A `project.admin` grant authorizes managing
membership and grants, including ownership. A project must retain an active owner when
membership is changed through the operation layer.

The installation owner can create local accounts without email. Account creation does
not grant access to any project, and installation ownership does not bypass project
membership. Passwords are validated and hashed; account creation rejects idempotency
keys and never retains a credential response. Stored usernames use Unicode NFKC
normalization before length and password validation.

`project.access` returns the actor's current permissions. Only administrators receive
the member roster and access-state token. `project.rename`, `project.set_member` and
`project.remove_member` require that token, serialize changes on the project row, and
reject stale edits. Keyed outcomes use the authorized project namespace and recheck
current administration before replay. Scope reads serialize against membership changes.
Database administrators retain their direct administration authority.

The Project access panel creates local accounts where permitted, renames projects and
manages membership. Scope loss clears the roster and refreshes the enclosing workspace,
including after an administrator removes their own membership. Other views continue to
use the shared operation and authorization layer.
