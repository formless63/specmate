# Document presentation and exports

Pure renderers and serializers over authorized document input rows. This package
does not fetch sources, derive engineering quantities, grant distribution rights,
or mutate drafts or retained document sets. Unknown quantities remain explicit.

The deterministic stored-ZIP/XLSX and RFC4180 CSV mechanics in `src/table.ts` adapt
WireHub's table serializer at `cbf919edf30a9d906a791971d3a40e22cb78b67e`
(AGPL-3.0-only). CSV adds protection for formula-like authored strings; XLSX writes
them as inline strings. No predecessor catalog data, fonts or designs are included.
