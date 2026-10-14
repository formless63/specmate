# Run the development foundation

This is an early source-built installation, not a prebuilt release or the complete
Specmate product. It runs the application/API foundation, durable jobs, PostgreSQL,
Temporal and its operator UI. Native tool authoring screens and qualified native tool
packs are not included. A successful container or synthetic process test does not
establish CAD compatibility or engineering validity.

## Create a separate stack directory

Use a Linux Docker Engine with the Compose plugin and Python 3 for configuration.
Build images from this public checkout only. Keep the running Compose configuration,
credentials and runtime state in a separate operator directory. From the checkout root:

```bash
specmate_stack="$HOME/stacks/specmate"
install -d -m 0700 "$specmate_stack"
cp compose.example.yaml "$specmate_stack/compose.yaml"
python3 deploy/configure.py --output "$specmate_stack/.env"
cd "$specmate_stack"
docker compose config -q
docker compose build
docker compose up -d --wait
docker compose ps
```

The configuration command creates random secrets in a mode-0600 `.env`, records the
absolute public checkout path as the build context, and creates an empty `{}` recipe
registry in `recipes.json`. It also records an absolute sibling `runner-state` path
for optional execution. It refuses to replace an existing `.env`: retain that file
across restarts and upgrades. Never copy generated configuration into the repository
or share rendered `docker compose config` output containing credentials.

The default stack has six services: `web`, `app`, `postgres`, `temporal`, `jobs` and
`temporal-ui`. The optional `runner` profile adds a seventh. Images and native schema
tools are pinned in [images.json](images.json). Source builds still require access to
the pinned image and dependency registries; this is not an offline release bundle.

The application is at [http://localhost:8080](http://localhost:8080). Temporal's
operator UI is at [http://localhost:8081](http://localhost:8081). Both host bindings
default to loopback. No database or Temporal RPC port is published. The operator UI
joins a separate `operator` network for its host port and the internal `backend`
network for Temporal access; application requests reach only the `web` proxy.

To omit the operator UI, start the five other named services explicitly instead of
using the unqualified `up` command:

```bash
docker compose up -d --wait web app postgres temporal jobs
```

## Readiness and first ownership

```bash
curl --fail http://localhost:8080/api/health
curl --fail http://localhost:8080/api/ready
docker compose exec app python manage.py owner_setup_token
```

`/api/health` reports process liveness. `/api/ready` additionally requires the current
checked-in application migrations and installation bootstrap; it returns HTTP 503
when that schema is not ready. Neither endpoint certifies native tools or workflow
completion. Compose also checks Temporal service health and the `specmate` namespace
before starting jobs.

The operator command displays a single-use owner setup token valid for 30 minutes.
Claim ownership through `POST /api/v0/setup/owner` with `request_id`, `token`,
`username` and `password`; the API schema is available at `/api/docs`. No default
owner/password or email service is required. The current frontend does not provide
the full ownership and engineering workflows. Treat the token and authenticated
session cookies as credentials. Issuing another token revokes older unused tokens;
issuing one after ownership is established is refused.

PostgreSQL's own first startup creates separately owned application, Temporal and
Visibility databases. Application startup holds a PostgreSQL advisory lock while
applying checked-in migrations and creating the installation singleton. Temporal's
startup holds database advisory locks while its version-matched upstream schema tool
initializes or updates persistence and Visibility, then creates its namespace.
Jobs check the application schema without migrating it. No dedicated migration,
initialization or admin-tools service is needed.

Migration failures remain visible and prevent readiness; startup never generates
migrations or deletes state to recover. Inspect bounded diagnostics with
`docker compose logs --tail 100 app temporal jobs`. Ordinary restarts reuse the same
databases, installation identity and artifacts. Keep the `.env`, recipe registry,
database/artifact volumes and any runner state. There is no automatic destructive reset.

## Backup and same-version restore

One bundle holds a consistent application database dump, every stored source and
artifact byte, the approved recipe registry and the installation `.env`. It contains
credentials: store it privately with the same care as the `.env`. From the stack
directory of a running installation:

```bash
docker compose exec -T app python manage.py work_control drain --reason backup
docker compose exec -T app python manage.py backup create --secrets-env - --output - \
  < .env > specmate-backup.tar
docker compose exec -T app python manage.py work_control resume
```

`backup create` reads the database through one exported snapshot with the image's
version-matched `pg_dump`, then copies the content-addressed byte store, verifying the
hash of every byte object the snapshot references. It refuses while builds are queued,
leased or running, or dispatch is undelivered; drain first, or pass
`--allow-active-work` to accept that a restore will cancel or interrupt that work. The
JSON report goes to standard error; the bundle goes to the output. `--output` with a
path writes a new mode-0600 file and never replaces an existing one.

Restore into a new, empty environment with the **same application version**. From the
checkout root, prepare a new stack directory from the bundle:

```bash
restore_stack="$HOME/stacks/specmate-restored"
install -d -m 0700 "$restore_stack"
cp compose.example.yaml "$restore_stack/compose.yaml"
PYTHONPATH=backend/src python3 -m specmate.backups.bundle extract-config \
  --input specmate-backup.tar --output-dir "$restore_stack"
cd "$restore_stack"
# Review SPECMATE_SOURCE_DIR and SPECMATE_RUNNER_HOST_STATE_DIR in .env for this host.
docker compose build
docker compose up -d --wait postgres
docker compose run --rm -T --no-deps app python manage.py backup restore --input - \
  < specmate-backup.tar
docker compose up -d --wait
docker compose exec app python manage.py work_control diagnose
```

`extract-config` verifies every bundle hash with only the Python standard library,
writes the `.env` (never over an existing one), an empty live `recipes.json` and the
backed-up registry as `recipes.restored.json`. `backup restore` refuses unless the
target database and byte store are empty and the bundle's migration set equals the
installed version's; it never deletes or merges state. It loads the dump with
`pg_restore` in one transaction (extensions come from PostgreSQL's own initialization),
places the verified bytes and then fences the restored state before anything can start:

- the installation enters `maintenance`: no build requests, runner leases or workflow
  dispatch;
- every restored runner credential is revoked;
- undelivered dispatch is withheld permanently, so it is never sent, even after resume;
- unstarted stages are cancelled with a not-started receipt, and leased or running
  stages become `interrupted` (their outcome after the backup point is unknown).

A restore marker beside the byte store keeps the app and jobs from becoming ready until
all of this has finished. If a restore stops midway, discard that target and restore
again into a new empty one; partial state is never resumed. Temporal histories are not
part of the bundle: the restored stack starts a fresh namespace, and the application
database is the authority for build state.

Re-enable execution deliberately: copy reviewed entries from `recipes.restored.json`
into `recipes.json`, recreate `app` and `jobs`, enroll new scoped runner credentials,
then run `docker compose exec app python manage.py work_control resume`. Interrupted
builds stay interrupted; request them again. A bundle can be checked at any time with
`python3 -m specmate.backups.bundle verify --input specmate-backup.tar`.

## Deliberate network exposure

The example uses HTTP on loopback with `SPECMATE_SECURE_COOKIES=false`. For access
over HTTPS, configure TLS at the trusted ingress, set secure cookies to `true`, and
set `SPECMATE_ALLOWED_HOSTS` and `SPECMATE_CSRF_TRUSTED_ORIGINS` for the chosen origin.
Retain the internal healthcheck hosts. Recreate services after changing `.env`.
The bundled Caddy configuration does not enable TLS automatically.

Operator access may bind `SPECMATE_OPERATOR_BIND_IP` to a deliberately chosen private
interface such as a VPN address. Keep it restricted to trusted operators. Do not
publish unauthenticated Temporal RPC or its operator UI on the public Internet.
For a public application behind an existing ingress, attach only `web` to that
ingress network and remove its host port in the stack configuration. Docker's
published ports need deliberate bind addresses; a host firewall alone is not the
access boundary.

## Optional native runner

Read [the runner configuration and authority boundary](../runner/README.md) before
enabling its profile. Only this controller receives the Docker socket; app, jobs and
tool containers receive no socket. The runner has no database credentials. This is
explicit execution authority, not a requirement for storing engineering sources.

First approve a recipe and a workspace for execution. `recipes.json` is an object
mapping each approved recipe ID to a matching [Recipe manifest](../backend/src/specmate/builds/recipes.py):
an exact image digest, absolute executable/argument vector, fixed input/output mounts,
network policy `none`, resource/time limits, and output declarations with media types
and rights. Do not approve an arbitrary imported script just because it is stored.
Cache each approved image by its verified digest on the runner's Docker daemon;
the runner refuses an unavailable image instead of pulling a floating tag.

App and jobs read the registry at startup from a read-only file mount. After editing
the operator-owned `recipes.json`, recreate both consumers so a replaced host file
and its new contents are loaded:

```bash
docker compose up -d --force-recreate --wait app jobs
install -d -m 0700 runner-state
```

The generated `SPECMATE_RUNNER_HOST_STATE_DIR` is the absolute path to that state
directory. If you relocate it, update `.env` and create the new private directory.
It must match the actual host directory mounted at `/runner-state`, because sibling
tool containers resolve bind sources on the Docker host. Preserve it across restarts.

After claiming ownership, issue a credential scoped to the workspace and its approved
recipe IDs. The command returns JSON whose token
is shown once; capture and extract it without printing the raw result. Run this from
the stack directory after replacing the two placeholders:

```bash
python3 - <<'PY'
import json
import os
import subprocess
from pathlib import Path

if Path("runner-token").exists():
    raise SystemExit("runner-token already exists; use an explicit credential rotation.")
result = subprocess.run(
    ["docker", "compose", "exec", "-T", "app", "python", "manage.py",
     "runner_credential", "--workspace", "<workspace-uuid>",
     "--recipe", "<approved-recipe-id>", "--hours", "24"],
    check=True, capture_output=True, text=True,
)
credential = json.loads(result.stdout)
fd = os.open("runner-token", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as token_file:
    token_file.write(credential["token"] + "\n")
print("Credential:", credential["credential_id"])
print("Expires:", credential["expires_at"])
PY
docker compose --profile runner build runner
docker compose --profile runner up -d runner
```

Repeat `--recipe` to grant additional approved recipes. Record the nonsecret credential
ID for revocation; the default lifetime is 24 hours. Revoke with
`docker compose exec app python manage.py runner_credential --revoke <credential-id>`.
An expired/revoked token requires deliberate reenrollment and replacement of the
private token file, then runner recreation. Avoid shell tracing or logging raw
credential JSON. The runner state contains private leases and receipts and must not
be published. Resource, recovery and filesystem quota limitations are documented in
the runner guide; enabling the profile does not accept any native tool pack.
