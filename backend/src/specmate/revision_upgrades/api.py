from uuid import UUID

from ninja import Router

from specmate.revision_upgrades.queries import result

router = Router(tags=["revision upgrades"])


@router.get("/proposals/{proposal_id}")
def proposal(request, proposal_id: UUID):
    return result(request.user, proposal_id)
