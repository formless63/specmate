# toolpacks

Independently pinned engineering execution images and adapters. Each declares operations, formats, architecture, permissions, resource limits, tool/library identities and output validation. Install images without starting permanent tool services.

This directory is an implementation boundary, not a claim that the subsystem is built.
Start with `docs/ARCHITECTURE.md`, the relevant capability IDs and assigned task.

The [KiCad fixture environment](kicad/README.md) pins one amd64 native tool image for
synthetic board generation, inspection, DRC and SVG export. It is an explicit development
checkpoint, separate from the operator's installed recipe registry. Its limits and
unverified formats/architectures are declared in [its manifest](kicad/manifest.json).

The [slicer pack](slicer/README.md) defines an optional, not yet built FDM slicing image
for printing preparation; its catalog entry has no pinned digest and unknown sizes.
