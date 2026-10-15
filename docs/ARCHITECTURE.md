# Accepted architecture

Status: accepted direction; exact compatible dependency versions are locked during the
first executable implementation. No runtime compatibility is claimed by this bootstrap.
Primary documentation references are collected in [SOURCES](SOURCES.md).

## One application authority

Use a Python modular monolith with Django ORM/transactions, Django Ninja APIs and Pydantic
contracts. The browser is a React/TypeScript/Vite application; compiled assets are served
by Caddy. Django is the only authoritative application backend. No TanStack Start,
Next.js, or second business server is required. Use TanStack Router/Query/Table and Mantine
as browser libraries, and preserve useful TypeScript geometry/rendering packages.

The application and its trusted jobs process share versioned Python command, validation
and pure-engineering modules. A module executed in another process is not a separate
engineering catalog. Keep transactional work short and synchronous at the Django boundary;
long computation belongs in workers. Generate client schemas/types rather than duplicate
authoritative rules in the browser.

## Selected baseline

| Layer | Choice | Notes |
| --- | --- | --- |
| Application | Python 3.13 baseline, Django 5.2 LTS, Django Ninja, Pydantic, Uvicorn | Qualify latest compatible patches; native packs pin their own Python. |
| Browser | React, TypeScript, Vite, Mantine, TanStack Router/Query/Table | Static production bundle, no app-side Node server. |
| UI geometry | React Flow, elkjs where useful, Three.js/React Three Fiber | Occurrence-aware selection and canonical placement are custom contracts. |
| Data | Standard PostgreSQL 18, Django ORM | pg_trgm and pg_stat_statements; pgvector only with enabled semantic search. |
| Workflows | Self-hosted Temporal + Python SDK | One implementation, not a small-install/enterprise split. |
| Identity | Django sessions + django-allauth | Local accounts; optional external sign-in. No required SMTP/IdP. |
| Artifacts | Application-owned content-addressed filesystem | Optional supported S3 adapter; Garage is the organizational FOSS option. |
| Agent access | Official MCP Python SDK | Optional PydanticAI for built-in assistance; no required model server/provider. |
| Documents | Reuse suitable SVG/PDF generators; Typst/Graphviz/XlsxWriter as needed | WireViz only for outputs it represents faithfully. |
| Development | uv + Ruff (Python); Bun as JS package manager and script entry point; pinned Node 24 LTS where a tool requires Node | Exact Bun pin, one committed `bun.lock`, frozen installs in CI/images; no other JS lockfile. Bun is not an app server and tools are not forced onto the Bun runtime. Node may run reused TS export jobs on demand. |
| Deployment | OCI images, rootless Podman reference, certified Docker Engine compatibility, Compose, Caddy | Users receive prebuilt images and a managed startup. |

## Application modules

Use clear boundaries for identity/workspace access; library/catalog; drafts/revisions/assemblies;
interfaces/topology; stock/cables/preparation; PCB intake; mechanical/scene; configuration;
sources/artifacts; builds; firmware; inventory/make; evidence/releases; knowledge;
extensions/integrations; and installation diagnostics. Avoid one giant generic object
JSON table. Normalize identities and critical relationships; use typed versioned payloads
for discipline-specific details. Database constraints protect essential invariants.

Native sources remain authoritative for explicitly designated properties. Extracted data
is a versioned interpretation with provenance. A workflow edits the source or the owning
record; it never silently maintains two editable truths. Keep a single implementation
of authoritative calculations and use outputs as shared inputs for documents/views.

## Workspace scope and authorization

Access is scoped by workspace (see [DOMAIN](DOMAIN.md#workspace-collections-and-projects)).
Collection records carry their workspace identity; a project carries its workspace too
and holds only project-owned records plus references. One shared authorization helper
resolves the actor's current workspace membership and role for every operation and read,
across GUI, API, MCP and trusted jobs. Modules do not implement per-project checks, and
a project identifier in a payload is navigation context, never authority.

Because every dependency stays inside one workspace (enforced by database guards), the
authority to read a root record covers its pinned closure: closure traversal validates
typed content and exact pins but needs no per-dependency membership lookups. Native
execution, inventory management and operator actions keep separate permissions;
distribution and export keep their rights and closure review.

Idempotency keys are namespaced by workspace. Operations that are independent of any
workspace (installation ownership, account creation, session) use the global namespace.

## Persistent compact deployment

Six services with operator UI enabled: `web`, `app`, `postgres`, `temporal`, `jobs`,
`temporal-ui`. Enabling local native execution adds `runner`. UI may be disabled.

The one PostgreSQL instance has separate databases and credentials for Specmate,
Temporal persistence and Temporal Visibility. PostgreSQL is the default Visibility
backend: no Elasticsearch container. Do not introduce TimescaleDB for ordinary results,
pgvector without a search need, or separate PostgreSQL servers solely by copying an
upstream demonstration stack. Move workloads to separate instances when measured needs
justify it, not by changing the engineering model.

Initialization and approved schema changes are startup phases of existing services.
Package version-matched Temporal schema tools with its startup environment. Keep admin
commands available without a dedicated admin/init service. App readiness waits for
its schema and bootstrap; one initializer holds a lock; errors remain visible. Never
run automatic migration generation or destructive recovery during startup.

## Jobs and execution boundaries

The command transaction records a build attempt and outbox entry. A dispatcher starts
an idempotently identified Temporal workflow. Workflows reference immutable manifests,
not large CAD blobs. Stage identities, retries and cancellation rules are explicit.
Application records, not Temporal retention, preserve permanent engineering evidence.

A trusted native runner accepts narrow stage leases through authenticated operations.
It obtains exactly scoped inputs, starts approved image digests, supervises resources,
reports heartbeats and output receipts, and reconciles after interruption. It has no
direct engineering DB access. Neither `app` nor imported tool containers receive the
container socket. Only the runner has that privileged authority. The jobs process may
use application operations but cannot execute imported code in-process.

Run untrusted parsing/conversion as sandboxed stages too; an import is not harmless
merely because it is not labeled a script. Output registration validates path, size,
hash, declared type, source links and rights before exposing artifacts. Cache correctness
and permission to reuse/disclose an output are separate checks.

## Engineering engines

PCB: KiCad/kicad-cli and KiBot; InteractiveHtmlBom for supported assembly output;
Freerouting optional. Advertise exact operation/format/version support. Prefer native
authoring adapters over a new universal EDA model. KiCanvas is a qualification candidate,
not a core requirement that may constrain viewing.

Mechanical: build123d/Open CASCADE for new code-driven recipes; FreeCAD for native
source workflows and manual editing. Accept useful CadQuery recipes via an adapter;
do not force two competing default source truths. Native B-rep/STEP geometry and derived
meshes have different roles and identities. Preserve semantically meaningful feature
references rather than identifying mounts by transient mesh face indices.

Wiring: retain capable custom cross-section/parametric geometry and React interactions.
Generalize workshop defaults into versioned profiles. Reuse document generators that
work; add Typst where needed, not as a mandatory rewrite. Firmware: PlatformIO Core and
explicit target toolchains. Rendering: Blender on demand. Later preparation: OrcaSlicer
with bundled vendor presets for FDM, and UVtools to inspect sliced resin files, without
pretending UVtools is a resin slicer.

Each pack pins tools, libraries, dependencies, recipe interfaces, supported architecture,
input/output types, permissions and resource limits. Images are cached, not permanently
running. Tools do not all resolve into one Python environment.

## Storage and search

Use transactional identities and immutable blobs, with staged uploads, verified promotion
and recoverable orphan cleanup. Do not rely on S3 versioning/object lock to implement
engineering revisions. Hashes identify bytes, not owners or permissions. Deduplication
stays within one workspace and never reveals existence across workspaces. Full-text and
relational/recursive queries come first; specialized search is an optional measured
enhancement.

Inventory is native, with one authoritative stock ledger per workspace and explicit procurement
projections. No required InvenTree, ERP, invoices, accounting or currency configuration.
No distributed event-sourcing platform or graph database is required just because
engineering records form graphs.

## Growth without idle burden

A compact deployment uses bounded pools/workers and normally one heavy stage at a time.
Do not eagerly import CAD libraries, run inference, poll supplier sites, or render static
browser frames continuously. Stop tool subprocesses after work. Measure CPU, resident
memory, connections, disk growth and post-job return to baseline; no unmeasured RAM promise.

Scale native runners first, then application/workflow workers and shared storage. Qualify
organization-scale Temporal/database availability, visibility-index maintenance,
identity integration and operational recovery deliberately. A local install does not
carry an idle enterprise monitoring/search cluster by default.

## Superseded choices

DBOS is not the chosen execution stack. TypeScript is not the authoritative backend.
Temporal UI is wanted; Elasticsearch and a permanent admin-tools container are not.
Separate initialization containers are not the default. Filesystem storage is the default;
Garage is optional. TimescaleDB, external inventory and ERP are not required. A new
framework starter does not replace the scope/domain/acceptance contracts in this repository.
