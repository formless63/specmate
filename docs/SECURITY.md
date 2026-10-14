# Security, privacy and authority

## Assets and actors

Protect source/artifact bytes, engineering facts, workspace membership, credentials,
workshop stock, physical evidence, releases and execution hosts. Actors include owners,
workspace members, scoped machine clients, external agents, operators, native runners,
plugins, importers and untrusted source authors. An imported document's instructions are
content, not commands from an owner. Runtime agents cannot inherit contributor privileges.

## Access boundaries

Authenticate once at transport and authorize every operation in the shared service layer.
Server-derived scope is not a client parameter to trust. Filter trees, full-text search,
where-used links, autocomplete, counts, logs, notifications, jobs, hashes and exports.
Nothing outside the actor's workspace is disclosed by name, count or denial message; such
a record is reported as not found. Retest disclosure permission on artifact download and
export after a job completes.

Local sessions use appropriate CSRF/cookie protections; API and machine credentials are
scoped, revocable and auditable. API keys are not automatically the complete authorization
protocol required by every remote MCP client. Use the selected official SDK/auth guidance
and advertise supported transports/auth flows. Do not invent a custom OAuth substitute.
One-time ownership setup has a short lifetime, one-use semantics and no public default.

## Workspace roles

Status: accepted target model; it replaces per-project membership and grants as the
workspace-collections migration lands.

The workspace is the privacy boundary (see [DOMAIN](DOMAIN.md#workspace-collections-and-projects)).
All members see every project and collection record in it; projects are not separate
access scopes. A member's role decides what they may change. Permission names are stable
atoms so that machine clients and agents can be granted a subset of a member's authority.

| Role | Permissions |
| --- | --- |
| Viewer | `workspace.read`: read every project and collection record, inspect results. |
| Contributor | Viewer, plus `item.create`, `source.register` and `project.edit`: add new definitions, sources, catalog associations, facts, notes and match candidates, create projects and edit project content, and edit the drafts of definitions they created. Contributors are never blocked from bringing new items into the workspace. |
| Editor | Contributor, plus `design.edit` on every item, `design.freeze` and `inventory.reserve`: change or freeze any shared item and record reviews and decisions. |
| Admin | Every permission, including `workspace.admin` for membership and roles. |

`build.execute` (native execution) and `inventory.manage` (stock and physical-unit
mutation) remain separate authorities: admins hold them, and an admin may grant either to
another member explicitly. The workspace must always retain an active admin. Installation
ownership claims the first admin membership; creating a local account grants no
membership. Operator actions, runner credentials and deployment changes are not workspace
roles.

## Execution

Application and job-worker images do not receive a container-runtime socket. The native
runner is a privileged trusted controller despite rootless execution. Give it dedicated
host/user authority where practical. Tool containers receive only staged inputs, bounded
outputs, explicitly allowed network/secrets and resource limits. No host home, whole artifact
store, database credentials or runner socket. Isolate hostile shared workloads with stronger
sandbox/VM boundaries when ordinary containers are insufficient.

Imported scripts remain data until an allowed recipe receives separate execution authority.
Archive traversal, symlinks, bombs, external entities, remote fetches, hostile meshes and
active documents are all input hazards. Sanitize previews and attachments. Parsing untrusted
files can require isolated execution even without a visible script.

Lease/fencing tokens reject stale runner outputs. Cancel the real OS work and reconcile
uncertain results; never mark a side effect undone because a request timed out. A cache
hit is not an authorization bypass. Network egress is denied unless the recipe explicitly
needs it; downloads record hashes and permitted destinations.

## Authority matrix

| Action | Default engineering agent authority |
| --- | --- |
| Read authorized records, inspect results | Granted only within its session scope. |
| Reversible draft edits | Bounded grant can cover many edits. |
| Run native sources/tools | Separate approved capability with limits. |
| Reserve/consume/adjust stock | Separate workshop-write authority. |
| Freeze/review/release | Explicit engineering authority; release shares `design.freeze`. |
| Export/download/share | Workspace reads (`workspace.read`) with recorded sharing; closure, rights and visibility review applies. |
| Purchase/order/flash/printer operation | Not baseline capabilities; no permission atom exists for them. |
| Reset databases/change deployment | Management commands, not registered operations; never grantable to runs. |

## Public source privacy

No private development sessions, Beads state, business designs, person/company names,
absolute local paths, credentials or private reference origins belong in public source by
default. Public examples must be independently synthetic or explicitly approved. Generic
renaming does not sanitize a proprietary design. Check screenshots, filenames, image/CAD
metadata, build logs, source maps, package contents and Git history as well as text files.

Keep private denylist values outside the public repo. Heuristic scanning and secret tools
assist review; they cannot prove absence of private business information. Preserve required
upstream notices, not private narrative. Never build an image from the parent workspace.

## Extension and operator surfaces

Admins decide what to enable; review declared needs, digests and dependency closure first.
There is no signature or publisher-trust check, and in-process code is fully trusted. Operators can access
Temporal UI and administrative operations; workspace membership, including the admin role,
is not sufficient.
Do not proxy an unauthenticated Temporal service to the public web.

## Dev-state safety

Disposable resets require a recognized installation and bounded paths, never DEBUG alone.
No broad host or container-volume cleanup. Permission/security tests remain relevant before
production exists. Restore disables execution/side effects until deliberately resumed.
Source bytes and private planning are outside disposable caches by default.

Reference: [Docker build contexts](https://docs.docker.com/build/building/context/).
