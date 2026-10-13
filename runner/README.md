# Native execution controller

The optional runner leases one approved stage at a time through the application's
`/api/v0/runner` HTTP operations. It has no Django dependency or database credential.
Only this trusted controller receives a Docker socket. Enable the Compose runner
profile deliberately, provision its scoped credential, and cache approved tool images
by digest before submitting execution. An unavailable image fails visibly; this
runner never silently pulls an unapproved tag or substitutes a tool.

## Configuration

| Variable | Meaning |
| --- | --- |
| `SPECMATE_APP_URL` | Application origin, for example `http://app:8000`; use HTTPS across untrusted networks. |
| `SPECMATE_RUNNER_TOKEN_FILE` | Private file containing the runner bearer credential; preferred over an environment value. |
| `SPECMATE_RUNNER_TOKEN` | Alternative bearer credential, when no token file is configured. |
| `SPECMATE_RUNNER_STATE_DIR` | Durable controller directory, default `/runner-state`. |
| `SPECMATE_RUNNER_HOST_STATE_DIR` | Absolute host directory bind-mounted at the state directory; Docker resolves sibling container mounts on the host. |
| `SPECMATE_TOOL_USER` | Nonroot numeric UID:GID for native tools, default `65532:65532`. |

The controller needs permission to use its Docker socket and to assign the private
output directory to the tool user. For direct host development, select the current
nonroot UID:GID. The state root is private (mode 0700); preserve it across runner
restarts. Its receipts contain scoped lease data and must not be published. A single
process holds a lock on each state directory. Losing both receipts and the runtime's
container state requires operator investigation, not an automatic rerun.

Run from this checkout with `PYTHONPATH=runner python3 -m specmate_runner`.
Build the controller with `docker build -f runner/Dockerfile .` from the repository
root. Its Python base and copied Docker CLI are pinned by digest; no backend source,
native CAD pack or whole artifact store is in the controller image.

## Execution and recovery

The approved manifest provides an image digest, recipe identity, argument vector,
exact input hashes, output declarations and resource limits. Argument vectors are
never interpolated into a host shell. An application-approved tool recipe may itself
run an interpreter inside its bounded container; imported source does not select the
host executable or mounts.

Inputs are downloaded through fenced stage access and verified by size and SHA-256.
Native containers run as a nonroot user with no network, a read-only root filesystem,
read-only inputs, a private output directory, dropped capabilities, no new privileges,
CPU/memory/PID limits and bounded temporary space. They receive no database credential,
runner bearer token or runtime socket. The controller currently supports only network
policy `none`; a recipe requiring network access fails validation.

A durable receipt and deterministic labelled container name precede startup. Recovery
reconciles that existing container before starting new work. Exit state, timeout and
cancellation refer to the actual container. A cancellation is reported only after
termination is confirmed. Loss of application control stops execution and preserves
its receipt. Refused lease authority stops the old container and fences its local
receipt without attempting result registration. An identical completion can be
replayed after acknowledgment loss without launching the tool again.

The runner refuses undeclared files, path traversal, links, special files, absent
required output and excessive file counts/sizes. It hashes output after the container
stops; the application independently verifies and accepts uploads with current fencing
and source/rights checks. Nonzero exits and failed validation do not expose partial
files as successful artifacts. Local receipts and bytes are retained for diagnosis;
retention cleanup is an operator responsibility in this foundation.

The output byte setting enforces a per-file `RLIMIT_FSIZE` and checks aggregate bytes
at each poll and at completion. A bind-mounted output directory **does not have a hard
aggregate filesystem quota**: writes between polls can temporarily exceed the declared
aggregate size. Use a dedicated quota-managed state filesystem for hostile workloads;
filesystem quota qualification remains separate from these runtime limits.

## Verification

Unit/contract boundary checks:

```bash
PYTHONPATH=runner python3 -m unittest discover -s runner/tests -v
```

Actual Docker process tests additionally require an explicitly supplied, already cached
image digest that provides `/bin/sh`, `/bin/true` and `/bin/sleep`:

```bash
SPECMATE_RUNNER_TEST_IMAGE='<repository>@sha256:<verified-digest>' \
  PYTHONPATH=runner python3 -m unittest discover -s runner/tests -v
```

Without that variable, Docker cases report skipped, not verified. These cases exercise
real success, timeout, descendant cancellation and restart fencing. They establish
controller behavior, not compatibility of a CAD tool or engineering/physical validity.
Application API integration, real native packs, supported CPU architectures, rootless
Podman and quota-managed storage require their own integration evidence.
