# Original synthetic KiCad fixtures

`two-net-board.kicad_pcb` is an original, deliberately simple board authored by
`toolpacks/kicad/generate_fixture.py` using the pinned KiCad 10.0.6 image. It uses
embedded original footprints, no external library assets, and stable UUIDs.
The native board format is `20260206`. The fixture files and generator use the
repository's AGPL-3.0-only license.

The board has a 40 × 25 mm outline, 1.6 mm thickness, and four unplated 2 mm
mounting holes at (3, 3), (37, 3), (3, 22), and (37, 22) mm. J1 and R1 each have
two 2 × 2 mm pads. Two 0.5 mm tracks run horizontally from x=10 to x=25 mm at
y=10 and y=15 mm. The first connects J1.1 to R1.1 on N1; the second connects
J1.2 to R1.2 on N2. R1 has value `1k`; its component passage remains separate
from the copper nets. Coordinates follow KiCad's x-right, y-down frame.

The acceptance facts live independently in `tests/fixtures/board-expectations.json`.
The generator does not read that expectation file, and the checker must derive
facts from the native board before comparing them. Preserve that separation when
changing either side. Successful DRC does not qualify a physical design; there is
no schematic, sourced component, electrical rating or manufacturing process here.

`invalid-board.kicad_pcb` deliberately has an unknown item and an unclosed root.
It exercises rejection by the real parser; it is not a valid engineering source.
Do not repair it into a successful input.

See `toolpacks/kicad/README.md` for the pinned environment and regeneration.
