# Installation and operations contract

This describes the target packaged experience. The current source-built foundation is
documented in [deployment instructions](../deploy/README.md): six core services with
startup-managed schemas and optional scoped runner execution. Published installation
bundles, native pack qualification and restore acceptance remain separate obligations.

## Installation surface

A user installs a supported container runtime and the prebuilt Specmate bundle, chooses
an instance address and optional state location, and explicitly enables native execution
when desired. Generate internal passwords/keys once and retain them. A one-time owner
bootstrap establishes ownership; no default password, required SMTP, IdP, ERP or AI key.
Local accounts work without email. Default network exposure is loopback; LAN/public access
and TLS are deliberate. Private TLS may require client trust; public TLS requires the
usual DNS/network conditions. Do not advertise impossible one-variable universal TLS.

Reference Linux target: rootless Podman with a tested Compose provider. Certify compatible
Docker Engine/Compose use. Desktop deployments use a managed Linux VM where needed;
measure that overhead separately. Users do not install native CAD/compiler/Python/Node
packages on the host. Optional local KiCad/FreeCAD graphical editing is a source handoff.

## Service topology

| Service | Persistent role | Authority |
| --- | --- | --- |
| web | Caddy + static frontend | Public entry point; proxies only approved routes. |
| app | Django/Ninja/MCP | Engineering commands, auth, database/artifacts; no runtime socket. |
| postgres | Standard PostgreSQL 18 | Separate app/Temporal/Visibility databases and roles. |
| temporal | Compact production server roles | Private workflow coordination. |
| jobs | Application workflow worker | Trusted commands/stages, no imported in-process execution or socket. |
| temporal-ui | Operator-only UI, enabled by default but disableable | Not ordinary workspace-member access. |
| runner | Enabled native executor | Narrow job leases + runtime authority, no direct engineering DB access. |

Heavy tool containers run only for jobs. Cached images are not running services. No
Elasticsearch, permanent admin-tools, dedicated init/migration, broker, ERP, accounting,
identity or inference server is required. Optional shared storage/observability are added
when needed. Compose profiles choose installed services; the runner creates dynamic jobs.

## Startup and readiness

PostgreSQL initializes its empty data directory and required databases/roles. Temporal's
existing service startup runs version-matched upstream schema tooling under an initializer
lock, then starts the server. Package tools with that image, not a dedicated admin service.
The app startup applies checked-in migrations under its own lock, performs idempotent
bootstrap, then reports ready. Jobs wait for required service/schema readiness.

Generate no schema guesses at runtime. Failed migrations/startup remain visible and fail
readiness; do not wipe data to recover. Distinguish process alive, database reachable,
schema compatible and application ready. Keep bounded retries and diagnostics. If packaging
matching schema binaries needs a small derived image, maintain that image explicitly.

## Tool enablement and job lifecycle

Expose supported packs, operations, architecture, download size, rights/notices and
requirements before enabling. Ship pinned tool images and optional offline bundles.
Do not install packages from the internet on each startup or stage. Record pack/image
versions in results; unsupported operations return a clear boundary.

Stage inputs are scoped and immutable. Cancellation reaches the subprocess; forceful
termination records incomplete status. Restart reconciles stage leases/container receipts.
Expired work is not all blindly restarted. Closing a browser does not cancel work unless
requested. A safe stop can drain work or explicitly interrupt it. A stopped installation
cannot receive requests; make missed schedules and time-sensitive work visible on restart.

## Diagnostics and safe stop

Diagnostics keep four causes apart, each with its own recovery path: a tool that is not
approved, enrolled or pinned (`tool_unavailable`); storage that is missing, unreadable,
read-only, full or has lost recorded bytes (`storage_failure`); withdrawn execution or
runner authority (`permission_denied`); and lease-expired or interrupted work whose
outcome is unknown (`stale_evidence`). Dispatch backlog and an installation stop are
reported separately. A check that did not run is `not_evaluated`, never healthy; the
workflow engine is not queried by these reads.

Any workspace member can read that workspace's queue, runner, tool, storage and finding
state (`diagnostics.workspace_status`, `GET /api/v0/diagnostics/workspaces/{id}/status`),
which feeds the workbench status area. It never includes other workspaces' work or storage
numbers. The
local operator uses `python manage.py work_control diagnose` for installation-wide detail.

`work_control drain` refuses new build requests while accepted work finishes.
`work_control interrupt` also cancels unstarted stages with a not-started receipt and
asks active stages to stop; they stay `cancellation_requested` until their own runner
confirms, and become `interrupted` if the lease expires first. Interrupted work is never
requeued or marked complete: only its owning runner can reconcile, otherwise a new build
is requested. `work_control reconcile` marks lease-expired stages interrupted and lists
them; `resume` accepts work again. Stopping containers remains a separate operator step,
taken once the report shows no unfinished or unreconciled stage.

Diagnostics report the workflow engine as `reachable`, `unreachable` or `unknown` with a
reason. The probe opens one TCP connection to `SPECMATE_TEMPORAL_ADDRESS`, bounded by
`SPECMATE_TEMPORAL_PROBE_TIMEOUT` seconds (default 2); it runs no workflow and does not prove
the namespace exists. `SPECMATE_MIN_FREE_BYTES` (default 536870912, 512 MiB) is the free
space below which artifact storage is reported as `storage_low_space`.

## Resources

Compact defaults use small bounded connection pools and one heavy native stage at a time.
Do not eagerly load CAD, render hidden scenes, poll suppliers, or run inference by default.
Release subprocess memory and temporary files after work. Keep retention/cleanup bounded
and permission-aware. Measure idle/post-job memory, sustained CPU, database connections,
Temporal history growth, storage usage and disk-cache/VM overhead separately. No unmeasured
memory/SLA claims. Organization installations configure concurrency and limits explicitly.

## Backup and recovery

A product backup operation covers app records, all referenced source/artifact bytes,
installation secrets, extension/recipe/tool manifests and relevant workflow recovery state.
A database dump alone is insufficient. Compact mode can pause writes, job acceptance,
artifact promotion and garbage collection, reconcile active stages, take consistent dumps
and restic backups, then resume. A same-version restore into a new environment is the early
acceptance target. Advanced pgBackRest/WAL and shared-storage procedures are later operational
profiles, not mandatory services.

Back up the app/Temporal boundary consistently or restore workflows through documented
reconciliation. Do not resume external side effects merely because a backup was restored.
Default a restore to maintenance with execution/integration actions disabled until authorized.
Private developer tracker backups are separate and not part of product data backups.

The current procedure is `python manage.py backup create|verify|restore` (steps in the
[deployment guide](../deploy/README.md#backup-and-same-version-restore)). A bundle is one
tar stream with a hashed manifest: a `pg_dump` taken through an exported REPEATABLE READ
snapshot, every content-addressed byte object (each referenced one verified by hash), the
approved recipe registry and, unless explicitly omitted, the installation `.env`. Bytes are
promoted before the commit that references them and never rewritten, so copying them after
the snapshot yields a superset of what the dump references. The manifest records the
schema migration set, installation identity, tool versions and the work open at backup.

Workflows carry identifiers only, so the workflow recovery state is the application's
stages, leases, receipts, runner credentials and dispatch outbox; Temporal histories are
not restored. Restore requires an empty target and an identical migration set, loads the
dump in one transaction, then fences the restored state before readiness: `maintenance`
mode (no requests, leases or dispatch), every runner credential revoked, undelivered
dispatch permanently withheld, unstarted stages cancelled with a not-started receipt and
active stages `interrupted`. `work_control resume` is the deliberate authorization; even
then nothing captured in the backup is dispatched or re-run. Online backup under active
work and restore across versions are not qualified; a restic/offsite schedule, retention
and encryption of bundles remain operator choices.

## Updates and pre-release development

Before v1.0.0, disposable test installations can reset to current baseline. Do not build
upgrade matrices across every transient branch. Retain safe startup, original source
preservation and current backup/restore from the beginning. At v1.0.0 define supported
schema/API and retained workflow baselines; subsequent upgrades use tested migrations.
Pin images and dependencies. Unattended floating-tag upgrades are not the default.

## Organizational path

Add remote authenticated runners first, including architecture/GPU/specialized packs.
Then shared artifact storage, additional app/workflow workers, organizational identity
and measured observability. Qualify Temporal/database high availability and Visibility
index maintenance deliberately; PostgreSQL Visibility is not a claim of unlimited scale.
Only operators access Temporal UI/admin tools. Internal service access must not bypass
workspace permissions through public proxies or a shared runner credential.

External references: [Temporal deployment](https://docs.temporal.io/self-hosted-guide/deployment),
[PostgreSQL Visibility](https://docs.temporal.io/self-hosted-guide/visibility/postgresql),
[Podman service authority](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html).
