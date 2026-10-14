# Coherent export packages

`DOC-001` combines the existing generators into one portable ZIP whose manifest pins
every included output to exact revisions of one frozen root. It does not replace those
generators or their authority: cable projections, retained preparation document sets
(PRE-004), cable test packages, registered KiCad fabrication outputs and retained scene
drawings keep their own semantics. Export is not a release, manufacturing approval,
physical test or qualification.

## Request and operations

`export_package.review` and `export_package.download` serve browser, HTTP, MCP and
trusted-job adapters through the shared operation layer, with the `workspace.read`
floor and no idempotency key. Each call freshly reauthorizes the actor and every
included record. Download supplies the reviewed manifest SHA-256; a changed review is a
conflict. `POST /api/v0/export-packages/download` returns the ZIP with a `Digest` header.

A request names an exact root revision, the root quantity in scope (or none, which keeps
every derived quantity unknown), an optional exact frozen BOM plan and purpose, and the
retained outputs to include: preparation document sets, cable test plan revisions,
`{intake_id, build_id}` fabrication builds, scene drawings and firmware builds
(`{firmware_revision_id, assembly_snapshot_id, path, build_id}`, the same reference
`firmware_build.read` takes). Only authorized internal
review is supported.

`export_package.candidates` (same `workspace.read` floor) lists, for one root, the latest
currently readable preparation document sets and cable test plans rooted in its closure,
scene drawings of pinned snapshots, validated successful fabrication builds of the
intakes its `pcb_population` revisions pin, and validated successful firmware builds of
the pinned firmware revisions (plain, and per exact assigned occurrence of the root). Each candidate is reread through its own
authority; unreadable or invalid records are not offered. The browser panel chooses
retained outputs only from this list. Listing is not a coherence decision.

## Coherence and quantities

The package resolves the root's complete frozen closure and counts contextual
occurrences independently: the root once and each occurrence path once. Scope quantity
is that per-root count times the stated root quantity. Pinned dependencies that are not
occurrences have no scope quantity.

Every included output lists its cited revisions. A cited revision is `pinned` when it is
in the package closure, `conflict` when it is another revision of a pinned definition,
and `supplementary` otherwise (profiles, test plans, BOM plans). Additionally:

- a BOM plan must pin the package root and the same root quantity;
- a preparation document set must be rooted in the package closure and declare the
  scope quantity of its root;
- a test plan's root must be in the package closure; its occurrence paths are reported;
- a fabrication build's exact source revision and board path must be pinned by a
  `pcb_population` revision in the closure; board quantity follows those occurrences;
- a scene drawing's snapshot must belong to a pinned revision;
- a firmware build's firmware revision must be pinned in the closure; an
  occurrence-specific build must name a pinned assembly snapshot with the recorded
  snapshot hash, and its board population must not conflict. Its scope quantity follows
  that snapshot's occurrence count. A plain (non-occurrence) build has no scope quantity.

Any conflict makes the package `incoherent`; review still explains it, but download is
refused. An unknown scope quantity makes coherence `unknown`. Completeness is reported
separately: unresolved BOM items and PCB populations without an included registered
build make the package `limited`, never silently complete.

## Package layout

- `manifest.json`: scope, every pin with per-root occurrences and scope quantity, section
  summaries, outputs with cited revisions/findings, unresolved items, unsupported output
  semantics, and the file inventory (path, SHA-256, bytes, media type, section, origin).
- `designs/<revision>.json`: unchanged canonical snapshots of every pin.
- `system/structure.json`: occurrences, declared relationships and pinned firmware.
- `spreadsheet/occurrences.csv`, `spreadsheet/revision-quantities.csv` and, with a BOM
  plan, `spreadsheet/bom-<purpose>.csv/.json`, plus `spreadsheet/package.xlsx` holding the
  same tables as sheets. CSV is RFC 4180; text never becomes a
  spreadsheet formula (XLSX text is always a string cell) and unknown amounts are empty
  cells with an explicit status.
- `rights/review.json` and `rights/review.csv`: declared rights review (below).
- `cable/<revision>/cable.json`, `conductors.csv`, `harness.json`, and retained
  preparation document bytes under `cable/preparation/<set>/`.
- `cable/<harness revision>/formboard-print.html` and `formboard-plan.json`: the
  server-generated full-size print of every harness revision in the closure (below).
- `firmware/<build>/`: the registered compiler files of an included firmware build.
- `test/<plan revision>/cable-test-package.json`.
- `pcb/populations.json` and registered outputs under `pcb/<build>/`.
- `mechanical/sources.json` and retained drawings under `mechanical/<drawing>/`.
- `review.html` (escaped static HTML, no scripts or remote resources) and `README.txt`.

The archive uses the standard-library `zipfile` and `csv` modules, fixed timestamps and
sorted entries, so an unchanged review yields identical bytes. The workbook is written by
openpyxl 3.1.5 (MIT; dependency et-xmlfile, MIT) with fixed creator and created/modified
properties, and its zip members are rewritten with a fixed timestamp in sorted order, so
the same review gives a byte-identical `.xlsx`. Bounds: 2,000 revisions,
4,000 files and 16 MiB.

## Formboard print

For each harness revision in the closure the package regenerates the formboard print on
the server from the exact frozen harness and the exact stock revisions it pins
(`specmate.harnesses.formboard`). It is a Python port of the browser renderer in
`packages/harness-views` (layout, 1:1 tiled print plan, page SVG and printable HTML); the
TypeScript renderer is not run server-side because the backend image has no Node runtime.
A golden test (`tests/data/formboard`, regenerated by `generate.ts`) compares the Python
output byte for byte with the TypeScript output. The print is A4 landscape, 10 mm margin
and overlap, uncalibrated, with the length axis to scale only for sections with a
recorded planned cut length; other sections are drawn dashed at a labelled placeholder
length. The output record states the scale, page count and number of unknown lengths.
Printing is not routing, fit, a calibrated measurement or manufacturing approval. If no
plan can be produced (no physical sections, or more than 64 tiles) the harness is listed
as unresolved with the reason, never faked. Only the HTML and a plan summary are
packaged; there is no PDF because no PDF library is installed.

## Firmware outputs

An included firmware build contributes the exact retained bytes of a fully validated
compiler stage: `firmware.elf`, `firmware.hex`, `compile.json` (report), `handoff.json`
(the canonical handoff of the exact declaration) and `compile.log`. Validation is the
same `firmware_build.read` validation (receipt, hashes, provenance, structural ELF/HEX
checks). The output record anchors the firmware revision and snapshot hash, occurrence,
recipe, toolchain and the ELF, HEX, report and handoff SHA-256. Hardware compatibility is
not evaluated, nothing is flashed and no device operation is observed. Each pinned source
file's declared rights appear in the rights review with status `unknown` (source rights
are free text with no recorded cleared/restricted status), so the download needs the
rights acknowledgement. Pinned firmware without an included build is listed as
unresolved and makes the package `limited`.

Registered fabrication builds currently carry no pick-and-place, population BOM or
assembly drawing; each PCB output records `assembly_outputs: not_provided` and the
manifest keeps `pcb.assembly_outputs` unsupported.

## Rights review

The manifest `rights` block and `rights/review.*` list, for every revision in the closure,
each catalog representation and source identifier with its recorded `rights_status`
(`cleared`, `restricted`, `unknown`), declared rights text, and for representations the
exact file path and SHA-256. Representations whose file belongs to another workspace are
hidden as in the catalog. Revisions with no declaration are listed as undeclared, never as
cleared. Nothing is inferred and the review is not a distribution grant.

When any record is `restricted` or `unknown`, `acknowledgement_required` is true and
`export_package.download` (and the HTTP download) refuses unless `rights_acknowledged` is
true. The acknowledgement is not part of the manifest, so the reviewed hash is unchanged.

## Unsupported output semantics

The manifest lists these explicitly rather than approximating them: pick-and-place,
population BOM and assembly drawings (not produced by the registered fabrication pack);
native CAD/STEP or toleranced manufacturing drawings (preserved mechanical
sources are cited by pin, not re-exported); scaled mechanical drawings; physical test
results; and distribution (the rights review below records declarations
only; see [selected assembly packages](selected-packages.md) for reviewed distribution).

## Offline verification

`backend/src/specmate/export_packages/verification.py` is standard-library only:

```bash
python3 -I -S verification.py package.zip --manifest-sha256 <retained-review-sha256>
```

It checks the manifest against the separately retained review hash, the file inventory,
pinned snapshot bytes and that each output's files are present.

Package format 2 (the latest; manifests carry `package_format`) also contains a frozen copy, `export_packages/verifiers/v2.py`, as `verify/verification.py`, listed
and hashed in the manifest inventory like any other file (no exemption is needed: the manifest
is hashed over the same bytes). It accepts a `.zip` or an extracted folder. A bundled copy can
only vouch for its own package, so use a separately obtained verifier for independent assurance.

Format 1 (no bundled verifier, no `package_format` key) is kept so releases made before format 2 still rebuild to the same manifest: each release stores its `package_format` and `release.verify` rebuilds with it. Never edit a released `verifiers/vN.py`; a verifier or layout change needs a new format number.
