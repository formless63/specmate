# Document presentation and exports

Pure renderers and serializers over authorized document input rows. This package
does not fetch sources, derive engineering quantities, grant distribution rights,
or mutate drafts or retained document sets. Unknown quantities remain explicit.

The deterministic stored-ZIP/XLSX and RFC4180 CSV mechanics in `src/table.ts` adapt
WireHub's table serializer at `cbf919edf30a9d906a791971d3a40e22cb78b67e`
(AGPL-3.0-only). CSV adds protection for formula-like authored strings; XLSX writes
them as inline strings. No predecessor catalog data, fonts or designs are included.

`model.ts` maps authorized coordinated sections into numbered landings, nullable
cuts, per-end preparation instructions, authored continuity expectations, BOM rows
and authored labels. It does not infer pairs from landings. HTML/SVG escape text;
table exports retain viewed identity, state and the reviewed input hash. A separate
cable working-buffer adapter marks drafts UNRELEASED and keeps unbound practices,
test intent and manufacturing quantities unknown.

The text-only P-touch archive adapts the XML/ZIP structure in WireHub's
`exports/lbx.ts` at the same pin. It declares a generic 80 × 12 mm layout, preserves
authored label and terminal text and embeds no fonts, images or external resources.
Actual P-touch Editor/printer compatibility has not been qualified.
