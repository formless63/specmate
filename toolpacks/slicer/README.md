# Optional slicer and resin-inspection packs

Printing is an optional extension; nothing in the base product needs these images and no
image has printer, network or device access. Building an image is separate from approving
any recipe.

| Pack | Tool | Profile / adapter | Status |
|---|---|---|---|
| FDM slicing (default) | OrcaSlicer 2.4.2 | `print-slice-orcaslicer-v1` | built and exercised on synthetic fixtures |
| Resin file inspection | UVtools 7.0.0 (`UVtoolsCmd`) | `print-resin-inspect-uvtools-v1` | built and exercised on synthetic files |
| FDM slicing (alternative) | PrusaSlicer 2.5.0 | `print-slice-prusaslicer-v1` | image never built; unpinned |

## OrcaSlicer FDM pack

`orca/Dockerfile` pins the Ubuntu 24.04 base by digest, downloads the upstream release
asset `OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage` by URL with BuildKit
`ADD --checksum` (SHA-256 `d12fb8c8...f029fd`, equal to the GitHub release asset digest),
extracts the AppImage without FUSE, and installs the 235 runtime packages listed in
`orca/packages.txt` at exact versions from `snapshot.ubuntu.com` at `20261010T000000Z`.

The command line slices headless: no display server or Xvfb is needed. OpenGL is not
available in the container, so the slicer logs a GLFW error and skips plate thumbnails;
the G-code and project are unaffected.

### Vendor presets

A print profile may name a preset from a vendor bundle shipped inside the OrcaSlicer
release (`vendor_preset`: tool, vendor, bundle version, preset name). Preset files are
never copied into this repository or the record; they stay in the pinned image. The
adapter resolves each preset's `inherits` chain inside the image (the OrcaSlicer 2.4.2
command line does not resolve inheritance of loaded files), applies only the declared
overrides, and refuses a missing preset, a base (non-selectable) preset, or a bundle whose
version differs from the pin. The presets exercised with the real image (0.4 mm nozzles):

| Printer | Machine preset | Process preset | Filament preset | Bundle |
|---|---|---|---|---|
| Qidi Q1 Pro | `Qidi Q1 Pro 0.4 nozzle` | `0.20mm Standard @Qidi Q1 Pro` | `QIDI PLA Basic @Qidi Q1 Pro 0.4 nozzle` | Qidi 02.04.00.06 |
| Qidi X-Plus 4 | `Qidi X-Plus 4 0.4 nozzle` | `0.20mm Standard @Qidi XPlus4` | `QIDI PLA Basic @Qidi X-Plus 4 0.4 nozzle` | Qidi 02.04.00.06 |
| Bambu Lab P1S | `Bambu Lab P1S 0.4 nozzle` | `0.20mm Standard @BBL X1C` | `Generic PLA` | BBL 02.01.00.19 |

Other presets in the bundles are accepted by name but are unverified. Declared profile
parameters override the preset (for example layer height, wall loops, infill density,
nozzle and bed temperatures, filament density); undeclared settings come from the preset
and are listed as preset settings. A declared G-code flavor is not sent: the preset's
machine start G-code depends on its firmware flavor.

### Program and limits

The trusted adapter (`backend/src/specmate/printing/orca_script.py`) checks the exact
model bytes and the release identity recorded in the image, writes the flattened presets
to private files under `/tmp`, and runs:

    AppRun --datadir <tmp> --slice 0 --load-settings "machine.json;process.json"
           --load-filaments filament.json --outputdir <tmp> [--export-3mf sliced.3mf]
           [--clone-objects <copies> --arrange 1] --ensure-on-bed <model.stl>

Only STL input and as-modelled orientation are accepted: OrcaSlicer 2.4.2 terminates with
SIGSEGV on `--rotate`, `--rotate-x` and `--rotate-y`. Slicing works inside the runner's
64 MiB `/tmp`; a model whose G-code exceeds it fails explicitly ("Is the disk full?").
Read-only inputs, network none, nonroot, no capabilities, no new privileges, 2 GiB memory,
2 CPUs, 128 PIDs, 900 seconds and 64 MiB total output apply through the shared runner.

Outputs are `slice.gcode` (plate G-code), `sliced.3mf` for the 3MF output format (the
project with that G-code embedded, the form Bambu Lab printers take), `slice.log` and the
`slice.json` report. The report carries what OrcaSlicer states in its G-code: estimated
print time (and the separate model time for Bambu Lab presets), filament length, volume
and mass, and layer count. Unstated or zero values stay unknown. It also lists the applied
preset identifiers and the preset value replaced by each override. The G-code header holds
the generation time, so raw G-code and 3MF hashes differ between runs; `gcode_body_sha256`
excludes that one line and was identical across repeated runs.

## UVtools resin inspection pack

`uvtools/Dockerfile` pins the same base, downloads `UVtools_linux-x64_v7.0.0.zip` with
`ADD --checksum` (SHA-256 `bcd47d2d...b8cbd1`, equal to the GitHub release asset digest)
and installs `uvtools/packages.txt` (Python, ICU, fontconfig) from the same snapshot.

It inspects one preserved sliced resin file. The primary format is ChiTuBox `.ctb`,
including the encrypted v4/v5 variants ChiTuBox writes; Elegoo `.goo` is secondary.
ChiTuBox `.chitubox` project files stay preserved source attachments and are never parsed.
The adapter (`uvtools_script.py`) checks the exact file bytes and runs
`UVtoolsCmd --no-progress print-properties <file>`. The report separates values the file
states (machine name, resolution, display size, pixel size, layer height, layer count,
bottom layers, exposure times, print height, stored print time and material) from values
UVtools computes from the layer images (volume, computed print time, display on-time).
A missing or zero value stays unknown. Nothing is modified, converted or sent to a printer.
Limits: network none, nonroot, 2 GiB, 2 CPUs, 128 PIDs, 600 seconds, 16 MiB output.

Resin slicing itself is not provided: no pinned headless resin slicer was found (the
mslicer 0.9.2 release is a GUI-only binary).

## Reproducible build

Build with exactly:

    docker build --network=default --provenance=false --sbom=false \
      --build-arg SOURCE_DATE_EPOCH=1791590400 \
      -f toolpacks/slicer/orca/Dockerfile -t specmate-slicer-check:orcaslicer-2.4.2-v1 toolpacks/slicer/orca
    docker build --network=default --provenance=false --sbom=false \
      --build-arg SOURCE_DATE_EPOCH=1791590400 \
      -f toolpacks/slicer/uvtools/Dockerfile -t specmate-resin-check:uvtools-7.0.0-v1 toolpacks/slicer/uvtools

The expected image IDs are recorded in `backend/src/specmate/builds/tool_catalog.json`.
Two independent `--no-cache` builds of each gave identical IDs on Docker 29.9.0
(containerd image store, BuildKit 0.34). Package lists are copied in through bind mounts
and the extracted release through a bind mount plus `cp -a`, because `COPY` records the
build time on parent directories. snapshot.ubuntu.com redirects to HTTPS and the base has
no CA bundle, so TLS peer verification is disabled for that host only; apt still verifies
the signed InRelease files with the base image's keyring and every package hash. If a
rebuild gives a different ID, compare layer digests before re-pinning.

## Rights

OrcaSlicer and UVtools are AGPL-3.0; the vendor printer profiles are part of the
OrcaSlicer release and stay inside the image. Ubuntu package notices stay under
`/usr/share/doc`. Consult the exact notices before redistributing an image. Generated
outputs carry rights derived from the staged source bundle. This pack copies no
predecessor code, vendor profiles or printer files. PrusaSlicer is AGPL-3.0-or-later; its
unbuilt Dockerfile remains as `Dockerfile` and its recipe code is unchanged.
