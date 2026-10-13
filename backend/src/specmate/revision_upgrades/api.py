from uuid import UUID

from ninja import Router

from specmate.revision_upgrades.queries import inspect_owning, result

router = Router(tags=["revision upgrades"])


@router.get("/proposals/{proposal_id}")
def proposal(request, proposal_id: UUID):
    return result(request.user, proposal_id)


@router.get("/snapshots/{snapshot_id}")
def owning_snapshot(request, snapshot_id: UUID):
    return inspect_owning(request.user, snapshot_id)
