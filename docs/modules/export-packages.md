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
`{intake_id, build_id}` fabrication builds and scene drawings. Only authorized internal
review is supported.

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
- a scene drawing's snapshot must belong to a pinned revision.

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
  plan, `spreadsheet/bom-<purpose>.csv/.json`. CSV is RFC 4180; text never becomes a
  spreadsheet formula and unknown amounts are empty cells with an explicit status.
- `cable/<revision>/cable.json`, `conductors.csv`, `harness.json`, and retained
  preparation document bytes under `cable/preparation/<set>/`.
- `test/<plan revision>/cable-test-package.json`.
- `pcb/populations.json` and registered outputs under `pcb/<build>/`.
- `mechanical/sources.json` and retained drawings under `mechanical/<drawing>/`.
- `review.html` (escaped static HTML, no scripts or remote resources) and `README.txt`.

The archive uses the standard-library `zipfile` and `csv` modules, fixed timestamps and
sorted entries, so an unchanged review yields identical bytes. Bounds: 2,000 revisions,
4,000 files and 16 MiB.

## Unsupported output semantics

The manifest lists these explicitly rather than approximating them: XLSX workbooks;
browser-rendered harness formboard prints; pick-and-place, population BOM and assembly
drawings; native CAD/STEP or toleranced manufacturing drawings (preserved mechanical
sources are cited by pin, not re-exported); scaled mechanical drawings; compiled firmware
outputs; physical test results; and distribution (see
[selected assembly packages](selected-packages.md) for reviewed distribution rights).

## Offline verification

`backend/src/specmate/export_packages/verification.py` is standard-library only:

```bash
python3 -I -S verification.py package.zip --manifest-sha256 <retained-review-sha256>
```

It checks the manifest against the separately retained review hash, the file inventory,
pinned snapshot bytes and that each output's files are present.
