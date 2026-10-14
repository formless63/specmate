# Shared stock section

Pure TypeScript section layout, standalone SVG, and straight stock extrusion.
No catalog, font, browser, external tool, or preparation profile is required.
The backend owns schema validation and engineering persistence. All projections
consume the same version 1 section; missing dimensions/positions remain unknown.
Axonometric previews compress axial length for display and are not fit evidence.

Geometry is adapted from WireHub at commit
`cbf919edf30a9d906a791971d3a40e22cb78b67e`:
`packages/layout/src/cross-section.ts` (deterministic ring placement) and
`packages/layout/src/figure8.ts` (joined-lobe outline). These packages are
AGPL-3.0-only; the repository's module exception is not required by Specmate.
See the root NOTICE and LICENSE. No predecessor catalogs or fonts are bundled.

`appearance.ts` resolves recorded colour and free-text material into one display
appearance (fill, finish, texture, physical hints) shared by the SVG drawings, end faces
and the 3D viewer; unrecorded values stay explicitly unknown. `end-face.ts` mirrors and
turns the section for one end. Their chirality rule and shield-texture vocabulary adapt
cab-stu (MIT, formless63) as recorded in the root NOTICE.
