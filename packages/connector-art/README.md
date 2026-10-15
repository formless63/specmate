# Connector face art

Data-driven connector mating faces and a themed React renderer (`ConnectorFace`).

- `geometry.ts`: the geometry schema. Millimeters in the mating-face view of the face's
  own gender (+x right, +y down, origin at the face center). The solder side is the
  mirror; the partner gender's face is also the mirror. Paths use absolute `M L Z` only
  so mirroring is exact.
- `library.ts`: `CONNECTOR_GEOMETRIES`, keyed `<family>-<male|female>` plus bare family
  keys (`mini-din-10`, `scart`) for the receptacle or header face.
- `body.ts`: `geometryForBody` picks a face from a body's declared `geometry_key`, or
  from an unambiguous family text and pin count; anything else returns `null`.
- `ConnectorFace.tsx`: SVG face using Schematic Bench tokens. Pins a caller lists no
  entry for are unknown and hatched; states never rely on hue alone; clickable pins are
  keyboard-operable buttons.

Every geometry carries `verification` (numbering verified, single-source or unverified;
positions nominal, scaled or approximate) and a generic source statement. Pin layouts
and numbering come from published connector standards and documentation and were
cross-checked against more than one reference where available; outlines are
simplified illustrations. A face is presentation, not evidence: it never establishes
fit, clearance, mating compatibility or conductor identity.

## Provenance

Adapted from WireHub by formless63 at commit `cbf919edf30a9d906a791971d3a40e22cb78b67e`
(AGPL-3.0-only): `packages/layout/src/connector-art.ts` (D-subminiature shell table:
contact pitch and row spacing, flange widths and mounting-hole spacing; the mini-DIN
shield size; the eight-pin DIN arc order; the mating-face/mirror convention). The
SCART/JP21 outline proportions follow WireHub's `modules/av-video/pack/art/scart-21.json`
(CC0-1.0). Corrected here: the SCART cut corner sits on the odd-contact row, and the
mini-DIN 9 and 10 rows follow the published three-row layouts. No predecessor catalog
records, depictions or fonts are bundled.
