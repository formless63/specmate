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

## Recorded format upgrade pack

`kicad-format-upgrade-v1` (`specmate.pcb.upgrade_script`) converts a released KiCad
6-9 board, and every schematic in the same bundle, to the KiCad 10 formats with the
pinned `kicad-cli pcb upgrade` / `sch upgrade`. It works on copies in the container's
private `/tmp` (bounded at 64 MiB by the runner), never on the read-only inputs, and
writes `upgraded/<path>` files plus `kicad-upgrade.json`. Unrecognized, too-old or
too-new formats fail with a specific diagnostic. See [PCB scope](../../docs/modules/PCB.md#recorded-kicad-format-upgrade).

Print a proposed registry entry, listing every `.kicad_sch` in the bundle:

```bash
cd backend
uv run python ../toolpacks/kicad/upgrade_recipe.py hw/board.kicad_pcb \
  --schematic hw/board.kicad_sch --rights AGPL-3.0-only
```

The derivative keeps the board path, so the existing `kicad-intake-v1` recipe for that
path and rights extracts it. Approving the upgrade recipe changes no other authority.

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

## Bounded fabrication pack

The separate `kicad-fabrication-v1` program produces fixed Gerber X2, separated
through-hole Excellon, native JSON DRC and a hash manifest from an immutable selected
board. See the explicit support/failure boundaries in [PCB scope](../../docs/modules/PCB.md).
Production graphics/text, native DNP, custom project settings/rules, zones, vias,
cutouts, curved geometry and slotted drills are outside this first qualified subset.
It does not author, modify or route the source, interpret human population options,
generate assembly outputs or authorize manufacturing.

Print an operator-reviewable registry entry without installing it:

```bash
cd backend
uv run python ../toolpacks/kicad/fabrication_recipe.py board.kicad_pcb --rights AGPL-3.0-only
```

Run the standalone native probe with the exact cached image and external evidence:

```bash
PYTHONPATH=runner:scripts backend/.venv/bin/python scripts/check_pcb_fabrication.py \
  --evidence-dir /external/new-fabrication-evidence-directory
```

The checker uses the existing runner isolation and independent original fixture
coordinates. It includes plated and unconnected synthetic variants and explicit
malformed/slot/DNP rejection. It changes no recipe registry, credentials, database,
permanent service or original fixture. This is standalone real-tool evidence;
registered runner transport and browser acceptance remain separate checkpoints.

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

## Independent source-net extraction pack

`kicad-net-assertions-v1` is a separate, bounded source extraction program in
`specmate.pcb_disagreement.native_script`. It exports a standalone schematic format
20250114 with the pinned KiCad 10.0.6 CLI, or parses preserved KiCad XML version E.
The parser rejects DTDs/entities, namespaces, unsupported versions, oversized/deep XML,
missing identity fields and conflicting repeated assignments. Unknown metadata remains
in retained XML and is listed as unsupported. Missing net membership remains unknown.

The exact source hash, exported XML hash, adapter/tool version, source role, extraction
method, reported source-tool metadata, actual component/sheet/unit/pin fields and
coverage are retained in canonical JSON. Source-tool text in an uploaded netlist is a
reported claim; parsing it does not establish that KiCad generated those bytes.
Both JSON and XML are declared outputs. Derived terminal IDs are scoped to the exact
source hash and native occurrence fields; no terminal UUID or PCB correspondence is
invented. No native net membership is routed copper or physical continuity proof.

Generate a proposed recipe without changing execution authority:

```bash
cd backend
uv run python ../toolpacks/kicad/source_nets_recipe.py original.kicad_sch \
  --source-role schematic --rights AGPL-3.0-only
```

The [original fixture](../../tests/fixtures/native/kicad-source-nets/README.md) passed
an isolated actual CLI/program probe for schematic export and preserved netlist parsing.
The approved runner/build acceptance checkpoint remains separate. No existing board
intake recipe or report is changed; schematic parity, hierarchy, variants and automatic
source precedence are not advertised by this pack.
