# Printing preparation (optional)

Printing is a later, optional extension (PRT-001 to PRT-004). Nothing in the base product
depends on it, and nothing here operates a printer. This page covers what is implemented
for profiles, manufacturing variants and slicing.

## Profiles (PRT-001)

A print profile is an ordinary versioned workspace definition (`print_profile`: draft,
frozen revision, history). It is a printer, process or material profile for FDM or resin
printing. Each parameter is a known key with a type, unit and bounds, for example nozzle
diameter, layer height, filament diameter or exposure time. Each parameter value records
its basis (`documented`, `inferred`, `preference`) and source (a citation or an exact
registered source file with hash and rights), using the same rules as workshop profiles.
A parameter that is absent or `unknown` stays unknown. It is never shown as zero or
replaced by a slicer default. Profiles can ship in catalog packs as `profile` entries and
be adopted like workshop profiles.

Commands: `print_profile.create`, `.update`, `.freeze`, `.read`.

## Preparations and manufacturing variants (PRT-001, PRT-002)

A print preparation (`print_preparation`) is a manufacturing variant of one part:

- **Part:** an exact frozen `mechanical_source` revision and one of its pinned model files.
  The mechanical definition is the part identity. Several variants (for example FDM PETG
  and resin) reference the same part identity; `print_preparation.variants` lists them.
- **Profiles:** exact printer, process and material profile revisions. Each must have the
  right role and the same technology as the variant.
- **Declarations:** model units, orientation (`as_modelled` or an explicit X/Y/Z rotation)
  and support strategy (`none`, `auto`, `buildplate_only`), each with a basis. Also copies,
  the output format (G-code or a prepared 3MF project) and the slicer tool.

Freezing pins the part and the three profile revisions as exact dependencies. Reading a
preparation shows the part identity, every effective parameter with the profile revision
and provenance it came from, and the slicing readiness. Commands:
`print_preparation.create`, `.update`, `.freeze`, `.read`, `.variants`.

## Slicing (PRT-002)

Slicing is an optional native stage through the shared approved-recipe, runner and
tool-catalog layer, using the [slicer pack](../toolpacks/slicer/README.md) (PrusaSlicer
2.5.0, FDM only). The recipe is exact for one frozen preparation. It binds the model hash,
the generated slicer settings, orientation, supports, copies and output format.
`print_slice.options` shows the exact proposed recipe and why slicing is unavailable.
An operator approves it with the locally built image digest. `print_slice.request` needs
`build.execute`. `print_slice.read` accepts only a complete registered output set whose
report matches the exact input, tool package, model hash and output hashes.

Slicing is refused while the orientation, support strategy, model units or a required
setting is unknown. It is also refused for resin and for non-mesh models (STEP or native
CAD). Optional settings left unknown are not sent: the slicer uses its own defaults, and
the record lists them as tool defaults. Outputs carry rights derived from the staged
source bundle. Estimates come from the slicer. An unstated or zero estimate stays
unknown, and the mass estimate is unknown unless the material profile declares a density.

A slice result identifies its exact profile revisions, tool package and image. It is never
called printable, never submitted to a printer and never physically qualified.

## Not implemented

Print batches, consumption, partial outcomes and post-processing (PRT-003), and measured
results on printed units (PRT-004) are not implemented yet. No printer integration or
permission exists: preparation has no submission path. Resin slicing (for example
UVtools) has no pack.
