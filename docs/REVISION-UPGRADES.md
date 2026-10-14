# Deliberate assembly revision and replacement adoption

`upgrade.propose` captures an exact owning assembly snapshot, an old revision, an explicit
candidate revision and identity relation, a consuming context, explicitly selected
occurrence paths and a review basis.
The proposal is a separate record. It never changes a frozen consumer or implies that
an existing configuration is valid, compatible or qualified.

`upgrade.inspect_owner` authorizes the owning snapshot and its current catalog origins
before returning selector occurrences. The browser uses this same scoped query.

The identity `relation` is explicit. `later_revision` (the default) requires a later
revision of the same definition. `declared_replacement` names a different definition of
the same kind and requires a reviewer-authored `replacement_basis`; the declaration is the
only identity correspondence. Equal labels, display references and catalog matching
associations never establish a replacement, and kind conversion is unsupported.

Paths select direct occurrences of one exact consuming context. `context_path` is empty
for the owning snapshot or addresses a nested assembly occurrence in its closure; that
occurrence's exact frozen revision becomes the consumer and the proposal retains its
snapshot. Adoption edits only a draft of the consumer definition. Repeated occurrences
of one definition can be selected independently. The preview reports
`parent_propagation`: sibling uses of the same consumer revision and outer relationships
or contextual assignments that address the selected nested uses. Outer contexts keep
their frozen pins until a separate later-revision proposal adopts the new consumer
revision with its own review. Non-assembly content is rejected rather than converted.

`upgrade.consumers` lists frozen assembly snapshots in the revision's workspace that pin
it at any depth, with each contextual use path. An optional `project_id` is context only:
consumers whose definition that project references come first and carry `in_project`.
Non-members receive NotFound.

The preview identifies exact old and candidate revision hashes, changed descendant paths,
placements and firmware assignments, retained root relationships and contextual assignments.
Electrical, mechanical, firmware, manufacturing and evidence impact each begin as
`not_evaluated`. A reviewer can record an `unknown` or `reviewed` assessment with a basis;
that assessment remains separate from compatibility, engineering validity and physical
qualification, which this adapter does not evaluate.

`upgrade.review` appends an immutable, sequential review under the proposal state token.
Acceptance requires explicit correspondence for every consumer-authored feature on a
selected occurrence or on a changed descendant below it, including unchanged feature
labels. The current feature adapter checks declared connector-body and pinout contacts on
the exact old and candidate revisions at that path; keys and undeclared contacts cannot be
mapped. Other feature kinds require a supported adapter.

Consumer-authored relationships and contextual assignments are never dropped or rebound
automatically. Acceptance requires an explicit `retain` or `remove` decision with a basis
for each relationship that addresses a changed or removed descendant, each contextual
assignment on one, and, for a declared replacement, every relationship and assignment on
the replaced occurrence itself. A relationship or assignment addressing a removed
descendant can only be removed. Retained relationships change only their reviewed feature
IDs. Decisions may name only relationships and assignments that touch the selected uses.

`upgrade.apply` requires the current accepted review and its state token. The caller must
choose `new_draft` or `existing_draft`. A new draft belongs to the consuming definition,
preserves the exact consumer revision as its base when frozen, and keeps the immutable
proposal link. An existing draft requires its own ID and independent state token, must
belong to the consuming definition, and must exactly match the consumer baseline content.
Independent edits require a new proposal. Application records link the exact review and
resulting draft version; later edits do not rewrite that application evidence.

All operations use the shared authorization and transaction layer. Current access to the
owning snapshot, both complete revision closures, source origins, every retained review
file and application draft is checked before disclosure, state conflicts or keyed replay
mismatch diagnostics. GUI, HTTP, MCP and trusted jobs discover the same typed operations.
Read operations evaluate live authority and do not accept idempotency keys. Mutations scope
keys to actor, workspace and operation; replay rechecks retained references.

Database guards prevent mutation of proposals, reviews and application links, require
either the same-definition later-revision relation or a declared same-kind replacement of
a different definition with a basis, require a nested consumer to be an assembly revision
pinned in the owning snapshot's closure, serialize review versions, and check that an
application links the current accepted review to a draft of the exact consuming definition.
Neither a review acceptance nor a successful adoption is evidence of physical qualification.
