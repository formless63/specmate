# Shared operation and adapter contracts

The files under `contracts/` are v0 contract examples for implementation. They are not a
claim of deployed URLs, generated client code or a completed schema library. Promote them
into authoritative Pydantic models and generate JSON Schema/OpenAPI from that one source.
Keep compatibility checks between generated schemas and retained examples.

## Controlled command layer

Commands are semantic operations, not generic unrestricted table edits. Typical intents:
create/update draft, freeze revision, map interface, resolve configuration, request build,
accept artifacts, reserve/consume stock, record observation, prepare/review release and
export approved closure. API/MCP transport names are discovered from implemented schemas;
do not invent callable endpoints in runtime agent guides.

Each operation uses server-derived actor/scope/authority, a request ID, optional idempotency
key, expected state token for a mutation, and explicit payload. Caller-provided identity
strings cannot authorize access. Reversible authoring and externally consequential actions
use separate permissions. Validate and authorize in the service layer, not only HTTP code.

Optimistic concurrency failures return a conflict plus safe current-state/diff information;
never silently overwrite. An idempotency key is scoped to actor/workspace/operation and a
request fingerprint. Reusing it with a different payload is an error. Transactional
operations either commit the intended invariants and outbox entries or neither.

Keyed operations resolve their namespace on the server before looking up retained results.
Workspace operations use `workspace:<canonical UUID>` after checking the actor's current
membership and the operation's permission; a project, revision or other record in the
payload resolves to its workspace on the server. Operations independent of any workspace,
such as installation ownership, use the `global` namespace. Unknown operations without an
explicit scope policy reject keyed requests before writing. Current replay authority is
checked separately; a retained response never grants access.

A project identifier in a payload is context (for example where a note or reference
belongs), never authority. Creating a collection record takes no project.

The pre-1.0 workspace-collections change resets disposable development databases instead
of migrating earlier project-scoped records or retained outcomes.

Responses distinguish validation failure, permission denial, missing input, unsupported
capability, unavailable tool, conflict, cancelled, failed, partial and completed. Detailed
logs may remain private; errors do not echo secret source content or unauthorized names.
Long-running requests return an operation/build reference, not a fictitious synchronous
success. List/search pagination and filters retain scope on every page.

## Source-bundle contract

A bundle manifest gives version, bundle identity, revision/ancestry, package-relative files,
content hashes, sizes/types, declared origin, rights, and source ownership. Preserve imported
originals separately from editable derivatives. Reject traversal, absolute paths, unsafe
links, archive bombs, contradictory names and excessive size. Treat active content as data
unless a separately authorized recipe accepts execution.

Check-out/edit/check-in reconstructs supported files and compares the expected source
revision. Source owners can use native graphical tools locally. A filesystem watcher is
not a second authoritative project catalog. Extraction results include their parser/tool
version, supported/lost semantics and candidate associations for review.

## Workflow submission and recovery

Commit a build-attempt and outbox record atomically. Deliver the outbox repeatedly if
needed using a stable workflow ID; an acknowledgment failure cannot create duplicate
logical attempts. Temporal workflows coordinate stages; each attempt records recipe,
source snapshots, resolved configuration, tools/libraries/images, limits and authorized
capabilities. Blob data stays in storage, not workflow-history payloads.

Stage states include queued, leased, running, cancellation-requested, succeeded, failed,
cancelled and interrupted/unknown. A retry is a new execution try for a stable stage
intent with an explicit link; retain prior failure evidence. A cancellation request is not
proof the OS process stopped. Stop/reconcile the process and receipt before final state.

A runner lease has a stable stage ID, fencing/lease token, expiration and bounded authority.
A stale runner cannot commit output after reassignment. Heartbeats reveal liveness, not
engineering validity. Reconcile an existing container/output receipt after lost contact
before restarting expensive work. A host restart may require rerunning a native stage;
there is no promise to resume an arbitrary CAD operation in the middle of computation.

## Runner and result registration

A runner reads only its leased manifest and authorized input bytes through scoped access.
It does not receive DB credentials, arbitrary app secrets or whole-store access. Approved
image digests, recipe IDs, resource limits, network policy, mounts and timeout are controlled
by the application. Imported script strings do not become an unrestricted host command.

Tool results report exit outcome, outputs, checks, warnings and partial/incomplete flags.
The application verifies every accepted blob's hash/size/type, safe path, source association,
rights and stage fencing token before promoting it. Failure outputs may be retained as
clearly incomplete evidence. Only an accepted manifest enters successful artifact views.

Cached work requires equivalent declared relevant inputs, recipe/tool identities and
access/rights rechecks. A content hash is not a public download capability. Untrusted or
unauthorized cache entries cannot answer cross-workspace queries.

## Scene contract

The scene is a derived view of a frozen/resolved or explicitly marked draft snapshot.
Nodes have contextual occurrence addresses, engineering feature IDs, geometry reference,
unit/frame metadata, canonical placement, optional view arrangement and geometry roles.
Model accuracy/missing-model status propagates to viewers and checking tools. Root and
nested occurrence identity survives tree filtering, BOM regrouping and diagram relayout.

Sharing vertex/mesh data never merges occurrence identities. Layer/radius centerline pieces
from retained wire geometry may be rendered in React without a server-language rewrite.
Authoritative preparation facts and electrical relationships remain service-owned.

## Evidence, documents and exports

Every important conclusion can point to exact facts, rules, calculations, review decisions
and applicable subjects. Checks report status and context, not just a boolean. Documents
reference engineering IDs/revisions, applicable configuration, source provenance and
unresolved items. Full-scale documents identify scale and calibration.

An export request identifies a target root/occurrence boundary and export purpose. Compute
its dependency closure, filter for permissions and distribution rights, then construct
an independently understandable package with manifest and hashes. Do not silently omit a
required private dependency and claim completeness; block or emit an explicitly limited
package. Verification of a package does not imply physical qualification.
[Coherent export packages](modules/export-packages.md) pin system, cable, PCB, mechanical,
spreadsheet and test outputs of one exact root and check that they cite identical revisions.

## Interfaces for extensions and integrations

Versioned manifests declare publisher (informational), content hashes, capability requirements,
input/output schemas, dependencies, declared needs and migration/update behavior.
Declarative content cannot gain execution through hidden template hooks. Executable
extensions use scoped approved worker boundaries. In-process code is fully trusted code,
not a sandbox merely because it is called a plugin.

External side effects have idempotency/reconciliation semantics and explicit authority.
No default integration auto-purchases, flashes, prints or publishes. Installation/update
permission is different from authority to run every declared action.

## Pre-1.0 contract evolution

Update current schemas and examples together; coordinate consumers and reset disposable
state when justified. Do not maintain a compatibility layer for every experimental API.
Retained predecessor import formats and deliberately exported data have separate product
obligations. At v1.0.0 define the supported schema/API and workflow upgrade baseline.
