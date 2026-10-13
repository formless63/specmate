# KiCad synthetic fixture environment

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
