# Coordinated preparation documents

PRE-004 produces six bounded, deterministic files from one exact frozen root:
specifications JSON, a declared schematic SVG, cut/preparation CSV, an inert HTML
build sheet, terminations JSON and authored test-intent JSON. Every file contains
identical root revision, snapshot, exact design/source pins, rights declarations,
configuration and generator/format identity. These are declared engineering
information; generation never demonstrates physical continuity, fit or test success.

A request pins a frozen root, nullable quantity, optional exact frozen BOM plan,
standalone make/buy decision and basis, and bindings addressed by exact contextual
occurrence paths. A binding may select exact cut profiles, end-preparation profiles
with explicit physical-end mappings, and authored test intent. A BOM must pin the
same root and quantity. Test intent must pin that root, contextual path and cable
revision; matching labels or repeated revision identity cannot substitute for scope.

Cable and Harness scopes use their existing typed projection rules. Other root
kinds retain specifications and explicit unknown wiring assessments; no alternative
native parser or solver is invoked. Each of the six files has an assessment that
retains missing bindings and qualification limits. Incomplete inputs are allowed
for review and generation; they never become an empty complete manufacturing plan.

Physical Harness sections count once, independently of their logical segment count.
Repeated occurrences count independently. Technical design counts remain present
inside bought boundaries; workshop counts are zero there and null at unassessed
make/buy boundaries. Frozen declared stock and conductor cuts remain distinct from
profile suggestions. Applying formulas does not write stock facts or replace cuts.
End preparation remains declared intent, and authored tests remain not performed.
Unknown lengths, quantities, mappings, instructions and expected tests stay unknown.

`preparation_documents.review` requires a current active actor and current read
access to the entire root, design/catalog origin and source ancestry closure,
including supplementary profiles, BOM and test plans. It returns a manifest and
`document-inputs-<digest>` token. The digest covers exact inputs and generator/format
identity; it does not detect access changes, which are independently reauthorized.

`preparation_documents.generate` is a controlled engineering write: it additionally
requires `DESIGN_EDIT` on the root's owning project, the reviewed token and a stable
idempotency key. Replay freshly checks both that write authority and the entire
stored receipt closure. Review, read, list and download require `PROJECT_READ` for
the owning project and complete current closure. Viewers can inspect and download;
they cannot generate. Hidden input authority withholds the whole set, not a partial
receipt or cached source label.

Outputs use the shared content-addressed blobstore. All bytes are staged and promoted
before transactional database publication. Failure publishes no partial receipt or
key; promoted unreferenced blobs may remain for the shared bounded reconciliation
policy. Generated outputs do not introduce another SourceBlob ownership boundary.
Database guards prohibit receipt/output mutation. History downloads original bytes,
without rerunning a later generator. Files have per-output hashes, sizes, media and
rights. HTML/SVG contain no scripts or external resources, authored text is escaped,
and CSV text is protected against spreadsheet formula interpretation.

Authorized internal review retains explicit unknown rights. Distribution additionally
requires permitted declarations for every exact design/source subject and declared
output rights with a basis; opaque source references remain unresolved and block
that distribution purpose. This is retained rights review, not an inferred license.
Source file hashes, declared rights, source manifests and ancestry remain provenance;
no source bytes, native geometry or private predecessor data are copied into outputs.

Predecessor disposition: WireHub build-sheet/schematic and saved-document route at
`cbf919edf30a9d906a791971d3a40e22cb78b67e`, plus cab-stu build-sheet tests at
`6bbf79655deb572df9f11490ca38e4f739ce71fb`, informed deterministic presentation.
Legacy server/catalog loading and workshop bench derivations are reference only.
The Specmate Python projection uses immutable typed declarations instead. No
predecessor models, fonts, workshop defaults or private fixture inputs are retained.
