# KiCad synthetic fixture environment

## Preserved PCB intake adapter

`backend/src/specmate/pcb/native_script.py` contains the trusted native program for
`kicad-intake-v1`. The application reads its text, and the runner executes the exact
program in the pinned container. Neither the application nor jobs imports `pcbnew`.
The recipe has no network, read-only inputs, a read-only root filesystem, no socket
or DB access, a nonroot user and CPU/memory/PID/time/output bounds. The adapter only
reads the selected board and never upgrades, downgrades, refills or saves it.

Generate an operator-reviewable recipe from the exact bundle path and source rights:

```bash
cd backend
uv run python ../toolpacks/kicad/intake_recipe.py board.kicad_pcb --rights AGPL-3.0-only
```

This prints a recipe registry entry; it does not install a recipe, pull an image,
issue runner credentials or enable execution. The installation operator reviews and
adds the entry to the private approved registry, and grants narrowly scoped runner
authority through the existing build system. Recipe IDs depend on path and rights;
the PCB request additionally verifies exact argv, image, limits and declared output.
Mixed rights cannot be combined by this initial single-stage build policy.

The one `pcb-intake.json` output is a bounded, versioned interpretation carrying the
board hash, native tool/format versions, native UUIDs, coordinates, pad memberships,
closed line outlines/cutouts, nonplated drill candidates and explicit unsupported
coverage. Failed parsing produces incomplete diagnostic JSON and a nonzero exit,
which cannot become an accepted interpretation. See [PCB scope](../../docs/modules/PCB.md)
and the generated [report schema](../../contracts/schema/pcb-report.json).

Opt-in qualification reuses the cached image and existing runner Docker boundary:

```bash
cd backend
uv run python ../scripts/check_pcb_intake.py --evidence-dir /external/new-evidence-directory
```

The checkpoint verifies unchanged source bytes, exact report provenance, native facts
against the unchanged independent geometry/net/resistor oracle, independent placements
and malformed-source failure. It leaves no persistent service or enabled recipe.
The fixture/checker below retains its original authoring/DRC/SVG behavior.

## Synthetic fixture checkpoint

`manifest.json` pins KiCad 10.0.6 by its `linux/amd64` image digest, with the
upstream tag and manifest-list digest retained for review. The official
[KiCad container page](https://www.kicad.org/download/docker/) identifies the
Docker Hub repository. The selected release's manifest contains only amd64;
there is no arm64 qualification claim. The image contains Python 3.13.5 and
the matching `pcbnew` bindings. The image is an external tool environment,
not a backend dependency or a permanently running service.

This fixture pack covers original synthetic board authoring, native board
inspection, JSON DRC and SVG board export. It is not an application-installed
recipe or a general PCB adapter. The [KiCad CLI reference](https://docs.kicad.org/10.0/en/cli/cli.html)
documents the native commands. No schematic ERC, fabrication output, foreign
format, arm64 or physical design qualification is implied.

Fetch the exact image explicitly before running integration checks:

```bash
docker pull kicad/kicad:10.0.6@sha256:40568bc95527f3a673a31a9b59badf512e71046c2d5068a364503c525f946a4e
```

The checker runs with network disabled, read-only inputs and root filesystem,
bounded CPU/memory/processes/time, and one writable output directory. Output
reports belong outside the source checkout. It compares independent expected
geometry and electrical semantics rather than trusting a successful exit alone.

To regenerate, run this command inside the pinned image:

```bash
/usr/bin/python3 /inputs/generate_fixture.py /outputs/two-net-board.kicad_pcb
```

Use only the generator
mounted read-only at `/inputs/generate_fixture.py` and a disposable directory
mounted at `/outputs`. Set `HOME=/tmp` and provide a writable `/tmp` tmpfs;
use the same isolation and resource limits as the checker. KiCad also writes
local `.kicad_pro` and `.kicad_prl` siblings while saving; they are not fixtures.
Only compare or copy the generated `.kicad_pcb`, then check its manifest hash and
run the independent native checks. Two generator runs produce byte-identical
board files; expected facts must never be regenerated from native output.

The fixture uses no stock footprint/model or predecessor hardware asset.
KiCad's image and its dependencies retain their upstream licenses; the image
labels KiCad GPL-3.0-or-later. These instructions fetch the upstream image without
rebundling it. Releasing a bundled image requires the repository's separate
licensing and publication review.
