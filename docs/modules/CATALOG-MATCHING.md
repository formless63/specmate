# Reviewed catalog matching

`catalog.propose_match` records a candidate between exact revisions of distinct
engineering definitions. Import, supplier and model associations carry observed
identifiers, a proposal basis and evidence. Similar identifiers do not establish
identity. An explicit proposal creates a separate candidate even when identifiers
are equal; it does not merge definitions, register a representation or alter a
consumer's captured dependency pins.

The source revision determines the assertion's owning project. Proposing or
reviewing requires its current `design.edit` permission and current read authority
over both revisions' complete retained closure. Target edit authority is unnecessary
because the target is referenced rather than changed. Correspondence between two
revisions of the same definition belongs to explicit revision adoption, not matching.

Evidence is explicitly `unknown`, an `unverified_citation`, or a `registered_file`.
A registered citation pins an exact source bundle revision and package-relative
path; the response retains its hash, media type and declared rights. Paths, rights
and citation text preserve whitespace. Registration verifies which bytes were cited;
it does not verify the document's engineering claims or authorize redistribution.
Unknown evidence never becomes a verified source by accepting a match.

`catalog.review_match` appends `accepted`, `rejected` or `needs_evidence`, with its
own basis, evidence and reviewer provenance. Each decision remains in history.
An accepted decision means reviewed correspondence only: interchangeability,
physical qualification, model accuracy and automatic adoption are not implied.
Later review can change the current decision without rewriting earlier evidence.

Candidates and reviews are immutable database rows. A database sequence guard and
candidate lock protect consecutive review versions. Reviews compare the required
`expected_state` (`match-v0`, `match-v1`, …); stale requests receive an authorized
current state. Both operations use the shared executor's actor/project/operation
idempotency namespace. Every retained citation and both engineering closures are
reauthorized before result disclosure, replay or keyed/stale conflict diagnostics.
Revoked evidence in any prior review prevents disclosure of the whole history.

The HTTP adapter exposes candidate detail, cursor-paged candidates owned by a source
revision, and cursor-paged exact registered files for a project's evidence selector.
Hidden candidates are skipped without counts; continuation cursors refer only to
visible candidates. HTTP commands, discovered agent commands and trusted jobs call
the same registered operations. The browser uses definition and exact-revision
selectors, typed evidence fields and an append-review form; JSON editing is unnecessary.
Continuations must identify a currently authorized row in the same query scope.
The browser's explicit access refresh and window-focus refresh discard retained
selections, forms and history before reading current authority. A denied candidate
reread also clears old options and disables mutations until access is refreshed.

Automatic similarity scoring, supplier import adapters, model-fit computation and
candidate deduplication are further capability work. This implementation accepts
explicitly observed candidates and never silently collapses them. PCB population
component/pad associations remain in their domain-specific operation layer.
