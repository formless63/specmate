from uuid import UUID

from ninja import Router

from specmate.catalog_packs import queries

router = Router(tags=["catalog packs"])


@router.get("/projects/{project_id}")
def packs(request, project_id: UUID, after: UUID | None = None, limit: int = 25):
    return queries.list_packs(request.user, project_id, after=after, limit=limit)


@router.get("/packs/{pack_id}")
def pack(request, pack_id: UUID):
    return queries.get_pack(request.user, pack_id)


@router.get("/versions/{version_id}")
def version(request, version_id: UUID):
    return queries.get_version(request.user, version_id)


@router.get("/packs/{pack_id}/history")
def history(request, pack_id: UUID, after: int = 0, limit: int = 25):
    return queries.history(request.user, pack_id, after=after, limit=limit)
