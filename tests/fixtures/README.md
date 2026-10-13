# Synthetic fixtures and independent expectations

These original examples exercise invariants and independently specified arithmetic.
They do not represent company products, manufacturing-qualified designs, actual stock,
or real bench results. None establishes a native-tool result by itself.

The JSON expectation files specify independent desired semantics. They are not native
tool tests. The original [KiCad board](native/kicad/two-net-board.kicad_pcb) is authored
with a [pinned tool environment](../../toolpacks/kicad/README.md). Its generator does not
read [board-expectations.json](board-expectations.json). The native checker extracts
actual geometry and net membership before comparing them to that oracle.

Self-contained packages under `bundles/` contain a source-bundle manifest and exact
original bytes under `files/`. The native board's [source bundle](native/kicad/source-bundle.json)
references its adjacent board file. Backend fixture tests validate these contracts,
register bytes through shared operations, reconstruct the stored originals, and exercise
interrupted/corrupt registration and unsafe-package rejection against PostgreSQL.

Run lightweight integrity and comparator checks with `make check-fixtures`. Run the
expensive native checkpoint explicitly after caching the pinned image:

```bash
make native-fixture-check NATIVE_EVIDENCE_DIR=/tmp/specmate-native-evidence
```

The evidence directory must be outside the checkout. A missing tool is an unavailable
check with a nonzero exit. Real-container recovery cases deliberately simulate control
API faults; they do not establish a live application/Temporal journey. Other JSON
oracles remain scenario inputs until their implementing checks exist. Private acceptance
examples stay outside this public tree and are not CI prerequisites.
