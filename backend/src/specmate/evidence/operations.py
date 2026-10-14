from specmate.access.permissions import Perm
from specmate.evidence.contracts import ListEvidence, ReadTaxonomy
from specmate.evidence.queries import list_evidence
from specmate.evidence.taxonomy import taxonomy
from specmate.operations import Context, operation
from specmate.operations.core import ACCESS_AUTHENTICATED


@operation(
    "evidence.list",
    ListEvidence,
    summary="List distinct evidence kinds with subject, method, conditions and provenance.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def evidence_list(ctx: Context, p: ListEvidence):
    return list_evidence(ctx.user, p)


@operation(
    "evidence.taxonomy",
    ReadTaxonomy,
    summary="Read the shared evidence-kind taxonomy and what each kind never establishes.",
    supports_idempotency=False,
    access=ACCESS_AUTHENTICATED,
)
def evidence_taxonomy(ctx: Context, p: ReadTaxonomy):
    return taxonomy()
