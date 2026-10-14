# Optional slicer pack

The first profile is `print-slice-prusaslicer-v1`: PrusaSlicer 2.5.0 from the Debian
bookworm package `prusa-slicer 2.5.0+dfsg-4`, linux/amd64, FDM only. Printing is an
optional extension; nothing in the base product needs this image.

## Status

No image has been built and no actual slicing run is recorded for this release. The
tool catalog lists the pack as `prusaslicer-2.5.0` with no pinned image and unknown
download and installed sizes. Tests exercise the recipe, report and acceptance contract
with a mocked native boundary; they establish nothing about the real slicer.

## Acquisition

```bash
docker build -f toolpacks/slicer/Dockerfile \
  -t specmate-slicer-check:prusaslicer-2.5.0-v1 toolpacks/slicer
docker image inspect --format '{{.Id}}' specmate-slicer-check:prusaslicer-2.5.0-v1
```

The Dockerfile pins the Debian amd64 base manifest (the same one the firmware pack uses)
and the exact `python3` and `prusa-slicer` package versions. The package download happens
at build time and its size has not been measured. The built image ID is specific to the
installation. Before running anything, record the exact package inventory
(`/opt/specmate/packages.txt`), licenses and a synthetic fixture check. Then approve each
generated recipe with that digest (`specmate-slicer-check@sha256:<id>`) in `recipes.json`.
`print_slice.options` returns the exact proposed recipe for a frozen preparation, with the
image left for the operator to fill. Building or approving grants no printer access.

## Program

The recipe runs a fixed trusted Python adapter that:

- checks the exact model bytes against the preparation pin and the installed package
  version against the pin;
- writes only the declared settings to a private configuration file;
- runs `prusa-slicer --export-gcode` (or `--export-3mf` for a prepared project) with fixed
  arguments for rotation, copies and bed placement.

Settings the profiles leave unknown are not written. The tool uses its own defaults for
them, and the record lists them as `tool_default_settings` rather than as declared values.
Required settings (nozzle diameter, bed size, filament diameter, nozzle temperature, layer
height), the orientation, the support strategy and millimetre model units must be declared
before a recipe exists.

The recipe runs with read-only inputs, network none, nonroot, 2 GiB memory, 2 CPUs,
128 PIDs, 900 seconds and 64 MiB of total output, applied by the shared runner. The tool
image has no application database, device or printer access.

## Outputs and claims

Outputs are `slice.gcode` or `prepared.3mf`, plus `slice.log` and the `slice.json` report.
They carry rights derived from the staged source bundle. Estimates are read from the
slicer's own G-code comments. An estimate the slicer does not state, or states as zero,
stays unknown. The mass estimate stays unknown unless the material profile declares a
density, and a prepared 3MF carries no estimates.

A successful slice identifies its exact preparation, profile revisions, tool package and
image. It is never called printable, never submitted to a printer and never physically
qualified. STEP import, resin/SLA output and linux/arm64 are unsupported.

PrusaSlicer is AGPL-3.0-or-later. Consult the installed notices before redistributing the
image. This pack copies no predecessor code or printer profiles.
