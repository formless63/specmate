---
name: specmate-native-tool-adapter
description: Integrate a real native engineering tool (KiCad, KiBot, build123d/FreeCAD, PlatformIO, Blender, slicers, converters) into Specmate as an isolated, versioned tool-pack stage. Use when adding or changing a tool pack, recipe, runner stage, output registration, or the advertised capability of a native tool.
---

# Native tool adapter

Contracts: `docs/ARCHITECTURE.md` (jobs and execution boundaries, engines),
`docs/CONTRACTS.md` (workflow recovery, runner and result registration),
`docs/modules/SOURCES-AND-JOBS.md`, `docs/SECURITY.md`, `toolpacks/README.md`,
`contracts/examples/stage.json`. Check rights in `LICENSING.md` before bundling anything.

## Build the pack

1. Declare a versioned capability: operation, input/output formats, exact tool version,
   supported architectures, permissions, and resource limits. Advertise only what is tested.
2. Pin the tool identity: image digest (resolved, never invented), tool/library versions,
   recipe ID. The pack has its own environment; it is not resolved into the app environment.
3. Inputs are an immutable manifest of exact source snapshot hashes; no live DB references.

## Execute (runner boundary)

- Only the runner starts the container, using an application-approved digest, read-only
  scoped inputs, a private output directory, no network unless granted, CPU/memory/time
  limits, and no container socket. Tools get no DB credentials or host paths beyond mounts.
- Stage lease with fencing token and heartbeat. Cancellation stops the actual process and is
  confirmed before the final state. After lost contact, reconcile any existing
  container/receipt before rerunning.
- Imported scripts and recipe strings are data, never an unrestricted host command.

## Register outputs

Validate each output: safe relative path, size, hash, declared type, source association,
rights, and current fencing token. Record provenance (tool, versions, digest, inputs,
recipe, limits). Failed or partial output is kept only as explicitly incomplete evidence.

## Report truthfully

Three different claims: the tool executed successfully; the result passes engineering
checks; something is physically qualified. Report each separately. A missing tool or
unsupported format is an explicit failed/unsupported result, never a mock success.

## Tests

Unit-test manifest/limit/registration logic. Prove the real tool on a synthetic fixture at
the integration checkpoint: success, invalid input, timeout/cancel of the actual process,
stale-token rejection. Follow `specmate-scoped-verification` for scheduling.
