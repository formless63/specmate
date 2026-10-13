# Deliberate assembly revision adoption

`upgrade.propose` captures an exact owning assembly snapshot, an old revision, a later
revision of the same definition, explicitly selected occurrence paths and a review basis.
The proposal is a separate record. It never changes a frozen consumer or implies that
an existing configuration is valid, compatible or qualified.

The current adapter supports direct assembly occurrence paths. Repeated occurrences of
one definition can be selected independently. Nested adoption requires a new owning
subassembly draft and coordinated parent propagation; the adapter rejects that unsupported
action. Non-assembly owning content is rejected rather than converted into an assembly.

The preview identifies exact old and candidate revision hashes, changed descendant paths,
placements and firmware assignments, retained root relationships and contextual assignments.
Electrical, mechanical, firmware, manufacturing and evidence impact each begin as
`not_evaluated`. A reviewer can record an `unknown` or `reviewed` assessment with a basis;
that assessment remains separate from compatibility, engineering validity and physical
qualification, which this adapter does not evaluate.

`upgrade.review` appends an immutable, sequential review under the proposal state token.
Acceptance requires explicit correspondence for every root-authored feature directly on a
selected occurrence, including unchanged feature labels. The current feature adapter checks
declared connector-body and pinout contacts on both exact revisions; keys and undeclared
contacts cannot be mapped. Other feature kinds require a supported adapter. Root-authored
relationships are retained and only their explicitly reviewed feature IDs change. A root
relationship or contextual assignment targeting a removed or changed descendant is rejected
until explicit descendant correspondence is supported. It is never dropped automatically.

`upgrade.apply` requires the current accepted review and its state token. The caller must
choose `new_draft` or `existing_draft`. A new draft belongs to the same owning definition,
preserves the exact baseline revision when the snapshot is frozen, and keeps the immutable
proposal link. An existing draft requires its own ID and independent state token, must
belong to the owning definition, and must exactly match the proposal's baseline content.
Independent edits require a new proposal. Application records link the exact review and
resulting draft version; later edits do not rewrite that application evidence.

All operations use the shared authorization and transaction layer. Current access to the
owning snapshot, both complete revision closures, source origins, every retained review
file and application draft is checked before disclosure, state conflicts or keyed replay
mismatch diagnostics. GUI, HTTP, MCP and trusted jobs discover the same typed operations.
Read operations evaluate live authority and do not accept idempotency keys. Mutations scope
keys to actor, project and operation; replay rechecks retained references.

Database guards prevent mutation of proposals, reviews and application links, require the
same-definition later-revision relation, serialize review versions, and check that an
application links the current accepted review to a draft of the exact owning definition.
Neither a review acceptance nor a successful adoption is evidence of physical qualification.
